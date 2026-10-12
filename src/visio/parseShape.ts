import type {
  ConnectorRoute,
  DiagramShape,
  ImageData,
  ShapeStyle,
  ShapeType,
  Side,
  TextBlock,
} from "../model/types";
import {
  PX_PER_INCH,
  applyMatrix,
  decompose,
  localToParent,
  multiply,
} from "./coordinateTransform";
import { buildGeometry } from "./geometry";
import { relId, type Relationship, type VsdxPackage } from "./package";
import { ShapeSheet } from "./sheet";
import { buildTextStyle, parseTextRuns } from "./text";
import type {
  Connect,
  DocumentContext,
  MasterInfo,
  ParentFrame,
  ShapeData,
  ShapeRef,
} from "./types";
import { attr, child, children, mergeShapeData, readShapeData } from "./xml";

/** Everything a shape needs to know about the page it lives on. */
export interface PageContext {
  doc: DocumentContext;
  pkg: VsdxPackage;
  pageRels: Map<string, Relationship>;
  /** Used to flip Y: the (foreground) page height in inches. */
  pageHeightIn: number;
  connects: Connect[];
  /** Prefix for shape ids (non-empty for shapes of background pages). */
  idPrefix: string;
  /** When set, every editable (non-synthetic, own-page) shape is recorded here by id. */
  registry?: Map<string, ShapeRef>;
}

const SIDE_BY_NUMBER: Side[] = ["N", "E", "S", "W"];

/**
 * Connector routing settings: stored by this app as user-defined cells (plain
 * numbers, so Visio ignores them), otherwise inferred from the geometry.
 */
function readRoute(sheet: ShapeSheet, commandCount: number): ConnectorRoute {
  const user = sheet.section("User");
  const value = (name: string): number | undefined => {
    const row = [...(user?.rows.values() ?? [])].find((r) => r.name === name);
    const v = parseFloat(row?.cells.get("Value")?.v ?? "");
    return Number.isFinite(v) ? v : undefined;
  };
  const style = value("vsdxStyle");
  const side = (n: string): Side | undefined => {
    const v = value(n);
    return v === undefined ? undefined : SIDE_BY_NUMBER[v];
  };
  return {
    style: style === undefined ? (commandCount > 2 ? "elbow" : "straight") : style === 1 ? "elbow" : "straight",
    beginSide: side("vsdxBeginSide"),
    endSide: side("vsdxEndSide"),
  };
}

/** Node ids the user confirmed for a line's ends (see `writeLinks`). */
function readLinks(sheet: ShapeSheet): DiagramShape["links"] {
  const user = sheet.section("User");
  if (!user) return undefined;
  const found: { begin: [number, string][]; end: [number, string][] } = { begin: [], end: [] };
  for (const row of user.rows.values()) {
    const m = /^vsdxLink(Begin|End)(\d+)$/.exec(row.name ?? "");
    const v = parseFloat(row.cells.get("Value")?.v ?? "");
    if (m && Number.isFinite(v)) found[m[1] === "Begin" ? "begin" : "end"].push([Number(m[2]), String(v)]);
  }
  const ids = (list: [number, string][]) => list.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const begin = ids(found.begin);
  const end = ids(found.end);
  return begin.length || end.length ? { ...(begin.length ? { begin } : {}), ...(end.length ? { end } : {}) } : undefined;
}

/** The high-availability group number the user gave a node (see `writeHaGroup`). */
function readHa(sheet: ShapeSheet): number | undefined {
  const row = [...(sheet.section("User")?.rows.values() ?? [])].find((r) => r.name === "vsdxHaGroup");
  const v = parseFloat(row?.cells.get("Value")?.v ?? "");
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  webp: "image/webp",
};

const DASHES: Record<number, number[]> = {
  2: [4, 2.5],
  3: [1, 2],
  4: [4, 2, 1, 2],
  5: [4, 2, 1, 2, 1, 2],
  6: [8, 3],
  7: [8, 3, 1, 3],
  8: [8, 3, 1, 3, 1, 3],
};

function buildTextBlock(sheet: ShapeSheet): TextBlock {
  const w = sheet.width;
  const h = sheet.height;
  const tw = sheet.num("TxtWidth", w, "x");
  const th = sheet.num("TxtHeight", h, "y");
  const pinX = sheet.num("TxtPinX", w / 2, "x");
  const pinY = sheet.num("TxtPinY", h / 2, "y");
  const locX = sheet.num("TxtLocPinX", tw / 2, "x");
  const locY = sheet.num("TxtLocPinY", th / 2, "y");
  const angle = sheet.num("TxtAngle", 0);
  return {
    x: (pinX - locX) * PX_PER_INCH,
    y: (h - (pinY - locY) - th) * PX_PER_INCH,
    width: tw * PX_PER_INCH,
    height: th * PX_PER_INCH,
    angle: (-angle * 180) / Math.PI,
  };
}

function buildStyle(sheet: ShapeSheet, roundingPx: number): ShapeStyle {
  const fillPattern = sheet.num("FillPattern", 1);
  const linePattern = sheet.num("LinePattern", 1);
  const fillTrans = sheet.num("FillForegndTrans", 0);
  const lineTrans = sheet.num("LineColorTrans", 0);
  const weightPx = sheet.num("LineWeight", 0.01) * PX_PER_INCH;
  const beginArrow = sheet.num("BeginArrow", 0);
  const endArrow = sheet.num("EndArrow", 0);

  // A themed shape says "Themed" instead of giving a colour: take it from the theme.
  const themed = fillPattern !== 0 && sheet.fillThemed ? sheet.themedFill() : undefined;
  const style: ShapeStyle = {
    fill: fillPattern === 0 ? undefined : (themed?.solid ?? themed?.gradient?.stops[0]?.color ?? sheet.color("FillForegnd") ?? "#ffffff"),
    stroke: linePattern === 0 ? undefined : (sheet.color("LineColor") ?? sheet.themedLine() ?? "#000000"),
    // Visio's hairline (0) is still visible.
    strokeWidth: Math.max(weightPx, 0.75),
  };
  if (themed?.gradient) style.gradient = themed.gradient;
  if (fillPattern !== 0) {
    const shadow = sheet.themedShadow();
    if (shadow) style.shadow = shadow;
  }
  if (fillTrans > 0) style.fillOpacity = Math.max(0, 1 - fillTrans);
  if (lineTrans > 0) style.strokeOpacity = Math.max(0, 1 - lineTrans);
  if (linePattern > 1) style.dash = DASHES[linePattern] ?? [4, 2.5];
  if (beginArrow > 0) {
    style.beginArrow = beginArrow;
    style.beginArrowSize = sheet.num("BeginArrowSize", 2);
  }
  if (endArrow > 0) {
    style.endArrow = endArrow;
    style.endArrowSize = sheet.num("EndArrowSize", 2);
  }
  if (roundingPx > 0) style.rounding = roundingPx;
  return style;
}

async function loadImage(
  page: PageContext,
  fd: Element,
  rels: Map<string, Relationship>,
  sheet: ShapeSheet,
): Promise<ImageData> {
  const rid = child(fd, "Rel") ? relId(child(fd, "Rel")!) : undefined;
  const rel = rid ? rels.get(rid) : undefined;
  const ext = rel?.target.split(".").pop()?.toLowerCase() ?? "";
  const format = ext || (fd.getAttribute("CompressionType") ?? fd.getAttribute("ForeignType") ?? "");

  // The picture's own rectangle (ImgOffset = its bottom-left corner in the shape's frame).
  const w = sheet.width;
  const h = sheet.height;
  const iw = sheet.num("ImgWidth", w, "x");
  const ih = sheet.num("ImgHeight", h, "y");
  const box = {
    x: sheet.num("ImgOffsetX", 0, "x") * PX_PER_INCH,
    y: (h - (sheet.num("ImgOffsetY", 0, "y") + ih)) * PX_PER_INCH,
    width: iw * PX_PER_INCH,
    height: ih * PX_PER_INCH,
  };

  const mime = MIME[ext];
  if (!rel || !mime || !page.pkg.has(rel.target)) return { format, ...box };
  return { href: await page.pkg.mediaUrl(rel.target, mime), format, ...box };
}

/**
 * Parse one `<Shape>` (and, for groups, its descendants) into model shapes.
 * The result is flattened in paint order: the group first, then its children.
 *
 * `synthetic` marks children that are copied out of a master because the
 * instance doesn't list them itself.
 */
export async function parseShape(
  el: Element,
  page: PageContext,
  parent: ParentFrame,
  synthetic = false,
): Promise<DiagramShape[]> {
  if (el.getAttribute("Del") === "1") return [];
  const rawId = el.getAttribute("ID") ?? "";
  const id = parent.id && synthetic ? `${parent.id}.${rawId}` : `${page.idPrefix}${rawId}`;

  // --- Master / style resolution -------------------------------------------------
  let master: MasterInfo | undefined = parent.master;
  let masterEl: Element | undefined;
  const masterRef = el.getAttribute("Master");
  const masterShapeRef = el.getAttribute("MasterShape");
  if (synthetic) {
    masterEl = el;
  } else if (masterRef) {
    master = page.doc.masters.get(masterRef);
    masterEl = master?.topLevel[0];
  } else if (masterShapeRef && parent.master) {
    masterEl = parent.master.allShapes.get(masterShapeRef);
  }

  const ownData: ShapeData = synthetic ? { cells: new Map(), sections: new Map() } : readShapeData(el);
  const masterData = masterEl ? readShapeData(masterEl) : undefined;
  const data = masterData ? mergeShapeData(masterData, ownData) : ownData;
  const styleAttr = (n: string) => attr(el, n) ?? (masterEl ? attr(masterEl, n) : undefined);
  const sheet = new ShapeSheet(
    page.doc,
    data,
    {
      line: styleAttr("LineStyle"),
      fill: styleAttr("FillStyle"),
      text: styleAttr("TextStyle"),
    },
    masterData,
  );

  if (!synthetic && !page.idPrefix && page.registry) {
    page.registry.set(id, {
      el,
      frame: parent,
      sheet,
      masterText: masterEl ? child(masterEl, "Text") : undefined,
    });
  }

  // --- Placement -----------------------------------------------------------------
  const w = sheet.width;
  const h = sheet.height;
  const local = localToParent({
    pinX: sheet.num("PinX", 0, "x"),
    pinY: sheet.num("PinY", 0, "y"),
    locPinX: sheet.num("LocPinX", w / 2, "x"),
    locPinY: sheet.num("LocPinY", h / 2, "y"),
    angle: sheet.num("Angle", 0),
    flipX: sheet.num("FlipX", 0) === 1,
    flipY: sheet.num("FlipY", 0) === 1,
  });
  const toScreen = multiply(parent.toScreen, local);
  const placement = decompose(toScreen, w, h);

  // --- Geometry & style ----------------------------------------------------------
  const isGroup = el.getAttribute("Type") === "Group";
  const foreign =
    child(el, "ForeignData") ?? (masterEl ? child(masterEl, "ForeignData") : undefined);
  const roundingPx = sheet.num("Rounding", 0) * PX_PER_INCH;
  const built = buildGeometry(sheet, roundingPx);
  const style = buildStyle(sheet, roundingPx);

  // --- Text ----------------------------------------------------------------------
  const textEl = child(el, "Text") ?? (masterEl ? child(masterEl, "Text") : undefined);
  const textRuns = textEl ? parseTextRuns(textEl, sheet) : [];
  const text = textRuns.map((r) => r.text).join("");

  // --- Connectors ----------------------------------------------------------------
  const oneD = sheet.has("BeginX") && sheet.has("EndX");
  let connector: DiagramShape["connector"];
  let connected = false;
  if (oneD) {
    const pt = (xn: string, yn: string) => {
      const [x, y] = applyMatrix(parent.toScreen, sheet.num(xn, 0, "x"), sheet.num(yn, 0, "y"));
      return { x, y };
    };
    const glued = (prefix: string) => {
      const c = page.connects.find((k) => k.fromSheet === rawId && k.fromCell.startsWith(prefix));
      if (c) connected = true;
      return c ? `${page.idPrefix}${c.toSheet}` : undefined;
    };
    connector = {
      begin: { point: pt("BeginX", "BeginY"), shapeId: glued("Begin") },
      end: { point: pt("EndX", "EndY"), shapeId: glued("End") },
      route: readRoute(sheet, built.paths[0]?.commands.length ?? 0),
    };
    if (!connected) connected = page.connects.some((k) => k.fromSheet === rawId);
  }

  // --- Shape type ----------------------------------------------------------------
  let type: ShapeType;
  const drawable = built.paths.some((p) => p.fill || p.stroke);
  if (isGroup) type = "group";
  else if (foreign) type = "image";
  else if (oneD) type = connected ? "connector" : "line";
  else if (!drawable && text.trim()) type = "text";
  else if (built.ellipseRows > 0 && built.paths.length === 1) type = "ellipse";
  else if (built.isRect) type = "rectangle";
  else type = "unknown";

  const shape: DiagramShape = {
    id,
    parentId: parent.id,
    name: attr(el, "Name") ?? attr(el, "NameU") ?? (masterEl ? attr(masterEl, "NameU") : undefined),
    type,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    rotation: placement.rotation,
    flipX: placement.flipX,
    style,
    geometry: built.paths,
    source: masterRef ? { masterId: masterRef, master: master?.name } : undefined,
  };
  if (text.trim() && textRuns.length) {
    shape.text = text;
    shape.textRuns = textRuns;
    shape.textStyle = buildTextStyle(sheet, textRuns[0]);
    shape.textBlock = buildTextBlock(sheet);
  }
  if (connector) shape.connector = connector;
  const links = readLinks(sheet);
  if (links) shape.links = links;
  const ha = readHa(sheet);
  if (ha !== undefined) shape.ha = ha;
  if (foreign) {
    const fromMaster = !child(el, "ForeignData");
    shape.image = await loadImage(
      page,
      foreign,
      fromMaster && master ? master.rels : page.pageRels,
      sheet,
    );
  }

  const out: DiagramShape[] = [shape];

  // --- Children ------------------------------------------------------------------
  if (isGroup) {
    const frame: ParentFrame = { toScreen, id, master };
    const ownShapes = child(el, "Shapes");
    if (ownShapes) {
      for (const c of children(ownShapes, "Shape")) {
        out.push(...(await parseShape(c, page, frame, synthetic)));
      }
    } else {
      const masterShapes = masterEl ? child(masterEl, "Shapes") : undefined;
      if (masterShapes) {
        for (const c of children(masterShapes, "Shape")) {
          out.push(...(await parseShape(c, page, frame, true)));
        }
      }
    }
  }
  return out;
}
