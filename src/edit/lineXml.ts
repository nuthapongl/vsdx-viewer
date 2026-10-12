/**
 * Writing a re-routed line back into its Visio XML.
 *
 * Two shapes of line exist in files:
 *  - 1-D shapes (BeginX/BeginY/EndX/EndY): the end points are the source of
 *    truth and Pin/Width/Angle are formulas of them. We update the end points
 *    and the cached values, keeping every formula (also glue formulas), so the
 *    shape stays a proper 1-D shape in Visio.
 *  - plain polyline shapes: we describe the new vertices in a fresh bounding
 *    box (no rotation, no flip) and rewrite the geometry rows.
 */
import { applyMatrix, invert, type Matrix } from "../model/transform";
import type { ConnectorRoute, Point, Side } from "../model/types";
import type { ShapeRef } from "../visio/types";
import { child, children } from "../visio/xml";
import { findCell, fmt, nextShapeId, pageShapesElement, refreshFormulas, setCell } from "./xmlEdit";

const EPS = 1e-9;

/**
 * Give a cell a new value while keeping its formula. A cell the shape only
 * inherits is created, carrying the inherited formula, so that Visio keeps
 * deriving it the same way.
 */
function setValue(ref: ShapeRef, name: string, value: number) {
  const existing = findCell(ref.el, name);
  if (existing) {
    existing.setAttribute("V", fmt(value));
    existing.removeAttribute("E");
    return;
  }
  const inherited = ref.sheet.data.cells.get(name);
  setCell(ref.el, name, value);
  if (inherited?.f) findCell(ref.el, name)!.setAttribute("F", inherited.f);
}

function geometrySection(ref: ShapeRef): { ix: string; section: Element } | undefined {
  const keys = [...ref.sheet.data.sections.keys()].filter((k) => k.startsWith("Geometry#"));
  keys.sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
  for (const key of keys) {
    const effective = ref.sheet.data.sections.get(key)!;
    if (effective.cells.get("NoShow")?.v === "1") continue;
    const ix = effective.ix;
    const doc = ref.el.ownerDocument;
    let section = children(ref.el, "Section").find(
      (s) => s.getAttribute("N") === "Geometry" && (s.getAttribute("IX") ?? "0") === ix,
    );
    if (!section) {
      section = doc.createElementNS(ref.el.namespaceURI, "Section");
      section.setAttribute("N", "Geometry");
      section.setAttribute("IX", ix);
      const sections = children(ref.el, "Section");
      const anchor = sections[sections.length - 1] ?? children(ref.el, "Cell").slice(-1)[0];
      if (anchor) anchor.after(section);
      else ref.el.prepend(section);
    }
    return { ix, section };
  }
  return undefined;
}

/**
 * Replace a geometry section's rows with MoveTo + LineTo rows through `points`
 * (shape-local inches, Y up). Rows the shape only inherits from its master are
 * deleted explicitly. X/Y keep their link to Width/Height where that is defined.
 */
function writeRows(ref: ShapeRef, points: Point[], width: number, height: number) {
  const target = geometrySection(ref);
  if (!target) return;
  const { section } = target;
  const doc = ref.el.ownerDocument;
  const ns = ref.el.namespaceURI;
  const effective = ref.sheet.data.sections.get(`Geometry#${target.ix}`)!;

  const inheritedRows = [...effective.rows.values()].filter((r) =>
    [...r.cells.values()].some((c) => c.inherited),
  );
  const maxIx = Math.max(0, ...[...effective.rows.keys()].map(Number).filter(Number.isFinite));

  for (const row of children(section, "Row")) row.remove();
  for (const r of inheritedRows) {
    const del = doc.createElementNS(ns, "Row");
    del.setAttribute("IX", r.ix);
    del.setAttribute("Del", "1");
    section.appendChild(del);
  }

  let ix = inheritedRows.length ? maxIx + 1 : 1;
  const cell = (n: string, v: number, f?: string) => {
    const c = doc.createElementNS(ns, "Cell");
    c.setAttribute("N", n);
    c.setAttribute("V", fmt(v));
    if (f) c.setAttribute("F", f);
    return c;
  };
  points.forEach((p, i) => {
    const row = doc.createElementNS(ns, "Row");
    row.setAttribute("T", i === 0 ? "MoveTo" : "LineTo");
    row.setAttribute("IX", String(ix++));
    row.appendChild(cell("X", p.x, width > EPS ? `Width*${fmt(p.x / width)}` : undefined));
    row.appendChild(cell("Y", p.y, height > EPS ? `Height*${fmt(p.y / height)}` : undefined));
    section.appendChild(row);
  });
}

/**
 * Re-route a line through `pagePoints` (page px). `ref` must describe the
 * shape as it was before the edit (see `EditHandle.apply`).
 */
export function writeLine(ref: ShapeRef, pagePoints: Point[]) {
  const { el, sheet, frame } = ref;
  const toParent = invert(frame.toScreen);
  const q = pagePoints.map((p) => {
    const [x, y] = applyMatrix(toParent, p.x, p.y);
    return { x, y }; // parent-local inches, Y up
  });
  const first = q[0];
  const last = q[q.length - 1];

  if (sheet.has("BeginX") && sheet.has("EndX")) {
    const w0 = sheet.width;
    const h0 = sheet.height;
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const width = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const pin = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };

    setValue(ref, "BeginX", first.x);
    setValue(ref, "BeginY", first.y);
    setValue(ref, "EndX", last.x);
    setValue(ref, "EndY", last.y);
    setValue(ref, "PinX", pin.x);
    setValue(ref, "PinY", pin.y);
    setValue(ref, "Width", width);
    setValue(ref, "Angle", angle);
    refreshFormulas(el, width, h0, w0, h0);

    // Shape-local coordinates: x along begin -> end, origin at the shape's local (0,0).
    const locX = sheet.num("LocPinX", w0 / 2, "x") * (w0 > EPS ? width / w0 : 1);
    const locY = sheet.num("LocPinY", h0 / 2, "y");
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const origin = { x: pin.x - (cos * locX - sin * locY), y: pin.y - (sin * locX + cos * locY) };
    const local = q.map((p) => ({
      x: cos * (p.x - origin.x) + sin * (p.y - origin.y),
      y: -sin * (p.x - origin.x) + cos * (p.y - origin.y),
    }));

    // A straight line inheriting its geometry from a master already follows Width.
    const ownRows = !!geometrySection(ref) && children(geometrySection(ref)!.section, "Row").length > 0;
    if (q.length > 2 || ownRows) writeRows(ref, local, width, h0);
    return;
  }

  // Plain polyline: new axis-aligned bounding box, no rotation or flip.
  const minX = Math.min(...q.map((p) => p.x));
  const maxX = Math.max(...q.map((p) => p.x));
  const minY = Math.min(...q.map((p) => p.y));
  const maxY = Math.max(...q.map((p) => p.y));
  const width = maxX - minX;
  const height = maxY - minY;

  setCell(el, "PinX", minX + width / 2);
  setCell(el, "PinY", minY + height / 2);
  setCell(el, "Width", width);
  setCell(el, "Height", height);
  for (const [name, v, f] of [
    ["LocPinX", width / 2, "Width*0.5"],
    ["LocPinY", height / 2, "Height*0.5"],
  ] as const) {
    const existing = findCell(el, name);
    setCell(el, name, v, true);
    if (!existing?.getAttribute("F")) findCell(el, name)!.setAttribute("F", f);
  }
  if (Math.abs(sheet.num("Angle", 0)) > EPS) setCell(el, "Angle", 0);
  if (sheet.num("FlipX", 0) === 1) setCell(el, "FlipX", 0);
  if (sheet.num("FlipY", 0) === 1) setCell(el, "FlipY", 0);

  writeRows(
    ref,
    q.map((p) => ({ x: p.x - minX, y: p.y - minY })),
    width,
    height,
  );
}

/**
 * Move a 1-D line by (dx, dy) page px without touching its geometry: the end
 * points and the pin shift, Width/Angle stay. Glue formulas on the end points
 * are replaced by plain values, because a line that has been dragged away is
 * no longer attached (see `unglue`) - unless `keepGlue` says the shapes it is
 * glued to move by the same amount. `ref` is the shape as it was before the move.
 */
export function translateLine(ref: ShapeRef, dxPage: number, dyPage: number, keepGlue = false) {
  const inv = invert(ref.frame.toScreen);
  const [ox, oy] = applyMatrix(inv, 0, 0);
  const [px, py] = applyMatrix(inv, dxPage, dyPage);
  const dx = px - ox;
  const dy = py - oy;

  for (const [name, d, axis] of [
    ["BeginX", dx, "x"],
    ["BeginY", dy, "y"],
    ["EndX", dx, "x"],
    ["EndY", dy, "y"],
  ] as const) {
    const value = ref.sheet.num(name, 0, axis) + d;
    // Detaching drops the formula; when the shapes it is glued to move too (keepGlue) it stays.
    if (keepGlue) setValue(ref, name, value);
    else setCell(ref.el, name, value);
  }
  setValue(ref, "PinX", ref.sheet.num("PinX", 0, "x") + dx);
  setValue(ref, "PinY", ref.sheet.num("PinY", 0, "y") + dy);
}

/** Remove the glue records of a connector that was moved away from its shapes. */
export function unglue(root: Element, connectorId: string) {
  const connects = child(root, "Connects");
  if (!connects) return;
  for (const c of children(connects, "Connect")) {
    if (c.getAttribute("FromSheet") === connectorId) c.remove();
  }
}

// --- connectors: creating, gluing, remembering how they are routed -------------------------

const SIDE_NUMBER: Record<Side, number> = { N: 0, E: 1, S: 2, W: 3 };
/** Visio's `FromPart` for the begin and end of a 1-D shape. */
const FROM_PART = { begin: 9, end: 12 };

function userRow(doc: Document, ns: string | null, name: string, value: number): Element {
  const row = doc.createElementNS(ns, "Row");
  row.setAttribute("N", name);
  const cell = doc.createElementNS(ns, "Cell");
  cell.setAttribute("N", "Value");
  cell.setAttribute("V", fmt(value));
  row.appendChild(cell);
  return row;
}

/**
 * Remember how a connector is routed, as plain numbers in user-defined cells
 * (Visio keeps and ignores them): style 0/1 and the sides 0-3 = N, E, S, W.
 */
function ensureUserSection(el: Element): Element {
  let section = children(el, "Section").find((s) => s.getAttribute("N") === "User");
  if (!section) {
    section = el.ownerDocument.createElementNS(el.namespaceURI, "Section");
    section.setAttribute("N", "User");
    const before = children(el, "Section")[0];
    if (before) before.before(section);
    else el.appendChild(section);
  }
  return section;
}

/**
 * Remember which nodes a line's ends connect to, as the shape ids the user confirmed:
 * rows `vsdxLinkBegin1..n` and `vsdxLinkEnd1..n` holding plain numbers.
 */
export function writeLinks(el: Element, links: { begin?: string[]; end?: string[] }) {
  const doc = el.ownerDocument;
  const section = ensureUserSection(el);
  for (const row of children(section, "Row")) {
    if (/^vsdxLink(Begin|End)\d+$/.test(row.getAttribute("N") ?? "")) row.remove();
  }
  for (const [prefix, ids] of [
    ["vsdxLinkBegin", links.begin],
    ["vsdxLinkEnd", links.end],
  ] as const) {
    (ids ?? []).forEach((id, i) => {
      const n = Number(id);
      if (Number.isFinite(n)) section.appendChild(userRow(doc, el.namespaceURI, `${prefix}${i + 1}`, n));
    });
  }
  if (children(section, "Row").length === 0) section.remove();
}

/**
 * Remember which high-availability group a node belongs to: a row `vsdxHaGroup` holding the
 * group's number. Nodes with the same number stand in for one another. `undefined` clears it.
 */
export function writeHaGroup(el: Element, group: number | undefined) {
  const section = ensureUserSection(el);
  for (const row of children(section, "Row")) {
    if (row.getAttribute("N") === "vsdxHaGroup") row.remove();
  }
  if (group !== undefined && group > 0) {
    section.appendChild(userRow(el.ownerDocument, el.namespaceURI, "vsdxHaGroup", group));
  }
  if (children(section, "Row").length === 0) section.remove();
}

export function writeRouteMeta(el: Element, route: ConnectorRoute) {
  const section = ensureUserSection(el);
  const set = (name: string, value: number | undefined) => {
    const existing = children(section!, "Row").find((r) => r.getAttribute("N") === name);
    if (value === undefined) {
      existing?.remove();
      return;
    }
    if (existing) {
      const cell = children(existing, "Cell").find((c) => c.getAttribute("N") === "Value");
      if (cell) {
        cell.setAttribute("V", fmt(value));
        cell.removeAttribute("F");
        return;
      }
      existing.remove();
    }
    section!.appendChild(userRow(el.ownerDocument, el.namespaceURI, name, value));
  };
  set("vsdxStyle", route.style === "elbow" ? 1 : 0);
  set("vsdxBeginSide", route.beginSide ? SIDE_NUMBER[route.beginSide] : undefined);
  set("vsdxEndSide", route.endSide ? SIDE_NUMBER[route.endSide] : undefined);
}

/** Glue one end of a connector to a shape, or detach it (`shapeId` undefined). */
export function setGlue(root: Element, connectorId: string, end: "begin" | "end", shapeId?: string) {
  const prefix = end === "begin" ? "Begin" : "End";
  let connects = child(root, "Connects");
  if (connects) {
    for (const c of children(connects, "Connect")) {
      if (c.getAttribute("FromSheet") === connectorId && (c.getAttribute("FromCell") ?? "").startsWith(prefix)) {
        c.remove();
      }
    }
  }
  if (shapeId === undefined) return;
  if (!connects) {
    connects = root.ownerDocument.createElementNS(root.namespaceURI, "Connects");
    root.appendChild(connects);
  }
  const c = root.ownerDocument.createElementNS(root.namespaceURI, "Connect");
  c.setAttribute("FromSheet", connectorId);
  c.setAttribute("FromCell", `${prefix}X`);
  c.setAttribute("FromPart", String(FROM_PART[end]));
  c.setAttribute("ToSheet", shapeId);
  c.setAttribute("ToCell", "PinX");
  c.setAttribute("ToPart", "3");
  connects.appendChild(c);
}

/** An end that is no longer glued to where a formula says: make its cells plain values. */
export function dropEndFormulas(el: Element, end: "begin" | "end") {
  const prefix = end === "begin" ? "Begin" : "End";
  for (const name of [`${prefix}X`, `${prefix}Y`]) findCell(el, name)?.removeAttribute("F");
}

export interface NewConnector {
  /** Vertices in page px, first = begin. */
  points: Point[];
  /** page (Visio inches, Y up) -> px matrix of the page. */
  pageToScreen: Matrix;
  beginShapeId?: string;
  endShapeId?: string;
  route: ConnectorRoute;
  /** Arrow ids; 0 = none. The end gets a filled arrow by default. */
  beginArrow?: number;
  endArrow?: number;
}

/**
 * Append a new 1-D connector shape to the page, written the way Visio writes
 * its own: end points are the source of truth, Pin/Width/Angle are formulas of
 * them, and the glue is recorded in `Connects`. Returns its id.
 */
export function createConnector(root: Element, spec: NewConnector): string {
  const doc = root.ownerDocument;
  const ns = root.namespaceURI;
  const id = nextShapeId(root);
  const el = (name: string, attrs: Record<string, string> = {}, kids: Node[] = []) => {
    const e = doc.createElementNS(ns, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    kids.forEach((k) => e.appendChild(k));
    return e;
  };
  const cell = (n: string, v: number | string, f?: string) =>
    el("Cell", { N: n, V: typeof v === "number" ? fmt(v) : v, ...(f ? { F: f } : {}) });

  const toParent = invert(spec.pageToScreen);
  const q = spec.points.map((p) => {
    const [x, y] = applyMatrix(toParent, p.x, p.y);
    return { x, y }; // inches, Y up
  });
  const begin = q[0];
  const end = q[q.length - 1];
  const dx = end.x - begin.x;
  const dy = end.y - begin.y;
  const width = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Shape-local: x along begin -> end, origin at the begin point (LocPin is the middle of a zero-height shape).
  const local = q.map((p) => ({
    x: cos * (p.x - begin.x) + sin * (p.y - begin.y),
    y: -sin * (p.x - begin.x) + cos * (p.y - begin.y),
  }));

  const cells: Element[] = [
    cell("PinX", (begin.x + end.x) / 2, "(BeginX+EndX)/2"),
    cell("PinY", (begin.y + end.y) / 2, "(BeginY+EndY)/2"),
    cell("Width", width, "SQRT((EndX-BeginX)^2+(EndY-BeginY)^2)"),
    cell("Height", 0),
    cell("LocPinX", width / 2, "Width*0.5"),
    cell("LocPinY", 0, "Height*0.5"),
    cell("Angle", angle, "ATAN2(EndY-BeginY,EndX-BeginX)"),
    cell("BeginX", begin.x),
    cell("BeginY", begin.y),
    cell("EndX", end.x),
    cell("EndY", end.y),
  ];
  if (spec.beginArrow) cells.push(cell("BeginArrow", spec.beginArrow));
  cells.push(cell("EndArrow", spec.endArrow ?? 5));

  const rows = local.map((p, i) =>
    el("Row", { T: i === 0 ? "MoveTo" : "LineTo", IX: String(i + 1) }, [
      cell("X", p.x, width > 1e-9 ? `Width*${fmt(p.x / width)}` : undefined),
      cell("Y", p.y),
    ]),
  );
  const geometry = el("Section", { N: "Geometry", IX: "0" }, [
    cell("NoFill", 1),
    cell("NoLine", 0),
    cell("NoShow", 0),
    cell("NoSnap", 0),
    cell("NoQuickDrag", 0),
    ...rows,
  ]);

  const shape = el("Shape", { ID: id, Type: "Shape", LineStyle: "0", FillStyle: "0", TextStyle: "0" }, [
    ...cells,
    geometry,
  ]);
  writeRouteMeta(shape, spec.route);
  pageShapesElement(root).appendChild(shape);
  setGlue(root, id, "begin", spec.beginShapeId);
  setGlue(root, id, "end", spec.endShapeId);
  return id;
}
