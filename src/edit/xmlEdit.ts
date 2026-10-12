/**
 * Low-level edits applied directly to a page's Visio XML.
 *
 * The saved file must stay a faithful copy of the original, so nothing here
 * regenerates shapes from the diagram model: each function patches the cells,
 * text or elements it is responsible for and leaves everything else alone.
 */
import {
  applyMatrix,
  invert,
  multiply,
  placementMatrix,
  type Matrix,
  type Placement,
} from "../model/transform";
import { PX_PER_INCH, localToBox } from "../visio/coordinateTransform";
import { evalFormula } from "../visio/formula";
import type { ShapeRef } from "../visio/types";
import { normalizeBreaks } from "../visio/text";
import { child, children } from "../visio/xml";

const EPS = 1e-9;

/** Number as written to a cell: plain decimal, no exponent, no trailing zeros. */
export function fmt(n: number): string {
  const s = n.toFixed(10);
  const t = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  return t === "-0" || t === "" ? "0" : t;
}

export function findCell(el: Element, name: string): Element | undefined {
  for (const c of children(el, "Cell")) if (c.getAttribute("N") === name) return c;
  return undefined;
}

/**
 * Give a shape cell a new constant value. The formula is dropped: Visio would
 * otherwise re-evaluate it and undo the edit when the file is opened.
 */
export function setCell(el: Element, name: string, value: number | string, keepFormula = false) {
  let c = findCell(el, name);
  if (!c) {
    c = el.ownerDocument.createElementNS(el.namespaceURI, "Cell");
    c.setAttribute("N", name);
    const cells = children(el, "Cell");
    const last = cells[cells.length - 1];
    if (last) last.after(c);
    else el.insertBefore(c, el.firstChild);
  }
  c.setAttribute("V", typeof value === "number" ? fmt(value) : value);
  if (!keepFormula) c.removeAttribute("F");
  c.removeAttribute("E");
}

// --- formulas that depend on the shape's size ---------------------------------------

/** Which axis a geometry-row cell measures along, for scaling cells whose formula we can't evaluate. */
function geometryAxis(rowType: string, cell: string): "x" | "y" | undefined {
  const xy = (xs: string[], ys: string[]) =>
    xs.includes(cell) ? "x" : ys.includes(cell) ? "y" : undefined;
  switch (rowType) {
    case "MoveTo":
    case "LineTo":
    case "ArcTo":
      return xy(["X"], ["Y"]);
    case "EllipticalArcTo":
    case "QuadBezTo":
      return xy(["X", "A"], ["Y", "B"]);
    case "Ellipse":
    case "CubBezTo":
      return xy(["X", "A", "C"], ["Y", "B", "D"]);
    default:
      return undefined; // Rel* rows are fractions of the size and need no change
  }
}

function directScope(el: Element, w: number, h: number): Record<string, number> {
  const scope: Record<string, number> = { Width: w, Height: h };
  for (const c of children(el, "Cell")) {
    const n = c.getAttribute("N");
    const v = parseFloat(c.getAttribute("V") ?? "");
    if (n && Number.isFinite(v) && !(n in scope)) scope[n] = v;
  }
  return scope;
}

/**
 * After a size change, bring cached values (V) in line with their formulas (F).
 * Formulas we can't evaluate keep their F; geometry coordinates among them are
 * scaled so the picture is right even if the file is read without recalculation.
 */
export function refreshFormulas(el: Element, w: number, h: number, w0: number, h0: number) {
  const scope = directScope(el, w, h);
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const c of children(el, "Cell")) {
      const f = c.getAttribute("F");
      const n = c.getAttribute("N");
      if (!f || !n || n === "Width" || n === "Height") continue;
      const v = evalFormula(f, scope);
      if (v === undefined) continue;
      if (!(n in scope) || Math.abs(v - scope[n]) > 1e-12) {
        c.setAttribute("V", fmt(v));
        scope[n] = v;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const sx = w0 > 0 ? w / w0 : 1;
  const sy = h0 > 0 ? h / h0 : 1;
  for (const sec of children(el, "Section")) {
    const isGeometry = sec.getAttribute("N") === "Geometry";
    for (const row of children(sec, "Row")) {
      const rowType = row.getAttribute("T") ?? "";
      for (const c of children(row, "Cell")) {
        const f = c.getAttribute("F");
        if (!f) continue;
        const v = evalFormula(f, scope);
        if (v !== undefined) {
          c.setAttribute("V", fmt(v));
        } else if (isGeometry) {
          const axis = geometryAxis(rowType, c.getAttribute("N") ?? "");
          const old = parseFloat(c.getAttribute("V") ?? "");
          if (axis && Number.isFinite(old)) c.setAttribute("V", fmt(old * (axis === "x" ? sx : sy)));
        }
      }
    }
  }
}

// --- placement ------------------------------------------------------------------------

const isOneD = (ref: ShapeRef) => ref.sheet.has("BeginX") && ref.sheet.has("EndX");

/**
 * Write a new page-space placement into the shape's own cells (PinX/PinY,
 * Width/Height, LocPin, Angle). `ref.sheet` must describe the shape as it was
 * *before* the edit (callers revert the element first), which makes this
 * idempotent: calling it repeatedly while dragging never accumulates error.
 *
 * The parent frame is inverted, so shapes inside rotated groups work too.
 */
export function writePlacement(ref: ShapeRef, p: Placement) {
  if (isOneD(ref)) return; // connectors are not repositioned (see session notes)
  const { el, sheet, frame } = ref;

  const w0 = sheet.width;
  const h0 = sheet.height;
  const w = p.width / PX_PER_INCH;
  const h = p.height / PX_PER_INCH;
  const oldPinX = sheet.num("PinX", 0, "x");
  const oldPinY = sheet.num("PinY", 0, "y");
  const oldLocX = sheet.num("LocPinX", w0 / 2, "x");
  const oldLocY = sheet.num("LocPinY", h0 / 2, "y");
  const oldAngle = sheet.num("Angle", 0);

  let locX = oldLocX;
  let locY = oldLocY;
  if (Math.abs(w - w0) > EPS || Math.abs(h - h0) > EPS) {
    if (Math.abs(w - w0) > EPS) setCell(el, "Width", w);
    if (Math.abs(h - h0) > EPS) setCell(el, "Height", h);
    refreshFormulas(el, Math.abs(w - w0) > EPS ? w : w0, Math.abs(h - h0) > EPS ? h : h0, w0, h0);
    const scope = directScope(el, Math.abs(w - w0) > EPS ? w : w0, Math.abs(h - h0) > EPS ? h : h0);
    const resolveLoc = (name: string, old: number, ratio: number): number => {
      const c = findCell(el, name);
      const f = c?.getAttribute("F");
      if (c && f && evalFormula(f, scope) !== undefined) return parseFloat(c.getAttribute("V") ?? "0");
      const v = old * ratio;
      setCell(el, name, v);
      return v;
    };
    locX = resolveLoc("LocPinX", oldLocX, w0 > 0 ? w / w0 : 1);
    locY = resolveLoc("LocPinY", oldLocY, h0 > 0 ? h / h0 : 1);
  }

  // local (inches, Y up) -> parent local (inches, Y up) for the requested placement
  const toParent = multiply(invert(frame.toScreen), multiply(placementMatrix(p), localToBox(h)));
  const fx = sheet.num("FlipX", 0) === 1 ? -1 : 1;
  const angle = Math.atan2(toParent[1] * fx, toParent[0] * fx);
  const [pinX, pinY] = applyMatrix(toParent, locX, locY);

  if (Math.abs(pinX - oldPinX) > EPS) setCell(el, "PinX", pinX);
  if (Math.abs(pinY - oldPinY) > EPS) setCell(el, "PinY", pinY);

  let dAngle = angle - oldAngle;
  dAngle -= Math.round(dAngle / (2 * Math.PI)) * 2 * Math.PI;
  if (Math.abs(dAngle) > EPS) {
    setCell(el, "Angle", Math.abs(angle) < 1e-12 ? 0 : angle);
  }
}

// --- text -----------------------------------------------------------------------------

function textNodes(root: Node, out: Text[] = []): Text[] {
  root.childNodes.forEach((n) => {
    if (n.nodeType === 3 || n.nodeType === 4) out.push(n as Text);
    else if (n.nodeType === 1) textNodes(n, out);
  });
  return out;
}

/**
 * Change a shape's text from `oldText` (what the user saw) to `newText`,
 * editing only the characters that differ so runs with different fonts,
 * sizes or colours keep their formatting.
 */
export function setShapeText(ref: ShapeRef, oldText: string, newText: string) {
  const { el } = ref;
  let textEl = child(el, "Text");
  if (!textEl) {
    const doc = el.ownerDocument;
    textEl = ref.masterText
      ? (doc.importNode(ref.masterText, true) as Element)
      : doc.createElementNS(el.namespaceURI, "Text");
    if (!ref.masterText) {
      const cp = doc.createElementNS(el.namespaceURI, "cp");
      cp.setAttribute("IX", "0");
      textEl.appendChild(cp);
    }
    const anchor = child(el, "ForeignData") ?? child(el, "Shapes");
    if (anchor) el.insertBefore(textEl, anchor);
    else el.appendChild(textEl);
  }

  const nodes = textNodes(textEl);
  const raw = nodes.map((n) => n.nodeValue ?? "").join("");
  // U+2028/2029 are shown as line breaks; compare on that basis (same length, so offsets agree)
  // and leave the original characters alone wherever the text is unchanged.
  const visible = normalizeBreaks(raw).replace(/\n$/, ""); // the last "\n" just ends the paragraph

  if (nodes.length === 0) {
    textEl.appendChild(el.ownerDocument.createTextNode(newText));
    return;
  }
  if (visible !== oldText) {
    // The displayed text isn't the raw text (e.g. upper-case formatting): replace wholesale.
    nodes.forEach((n, i) => {
      n.nodeValue = i === 0 ? newText + raw.slice(visible.length) : "";
    });
    return;
  }

  let p = 0;
  while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
  let s = 0;
  while (
    s < oldText.length - p &&
    s < newText.length - p &&
    oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]
  ) {
    s++;
  }
  const removeFrom = p;
  const removeTo = oldText.length - s;
  const insert = newText.slice(p, newText.length - s);

  // delete [removeFrom, removeTo)
  let offset = 0;
  for (const n of nodes) {
    const v = n.nodeValue ?? "";
    const a = Math.max(removeFrom - offset, 0);
    const b = Math.min(removeTo - offset, v.length);
    if (b > a) n.nodeValue = v.slice(0, a) + v.slice(b);
    offset += v.length;
  }
  if (!insert) return;

  // insert at `removeFrom`, continuing the formatting of the preceding character
  offset = 0;
  let target = nodes[0];
  let at = 0;
  let found = false;
  for (const n of nodes) {
    const len = (n.nodeValue ?? "").length;
    if (removeFrom > offset && removeFrom <= offset + len) {
      target = n;
      at = removeFrom - offset;
      found = true;
      break;
    }
    offset += len;
  }
  if (!found) at = 0;
  const v = target.nodeValue ?? "";
  target.nodeValue = v.slice(0, at) + insert + v.slice(at);
}

// --- style ----------------------------------------------------------------------------

export interface StylePatch {
  /** `null` = no fill. */
  fill?: string | null;
  /** `null` = no line. */
  stroke?: string | null;
  /** px */
  lineWidth?: number;
}

function shapeAndDescendants(el: Element): Element[] {
  return [el, ...Array.from(el.getElementsByTagNameNS("*", "Shape"))];
}

/** Apply a style change to a shape; for groups, to everything inside them. */
export function applyStyle(el: Element, patch: StylePatch) {
  for (const target of shapeAndDescendants(el)) {
    if (target.getAttribute("Type") === "Group" || target.getAttribute("Type") === "Foreign") continue;
    if (patch.fill !== undefined) {
      if (patch.fill === null) {
        setCell(target, "FillPattern", 0);
      } else {
        setCell(target, "FillForegnd", patch.fill);
        setCell(target, "FillPattern", 1);
      }
    }
    if (patch.stroke !== undefined) {
      if (patch.stroke === null) {
        setCell(target, "LinePattern", 0);
      } else {
        setCell(target, "LineColor", patch.stroke);
        setCell(target, "LinePattern", 1);
      }
    }
    if (patch.lineWidth !== undefined) {
      setCell(target, "LineWeight", Math.max(patch.lineWidth, 0) / PX_PER_INCH);
    }
  }
}

// --- structure ------------------------------------------------------------------------

export function pageShapesElement(root: Element): Element {
  let shapes = child(root, "Shapes");
  if (!shapes) {
    shapes = root.ownerDocument.createElementNS(root.namespaceURI, "Shapes");
    root.insertBefore(shapes, root.firstChild);
  }
  return shapes;
}

/**
 * Remove a shape (and everything inside it) from the page, then clean up what
 * pointed at it: glue records, and formulas that referenced it by `Sheet.N!`
 * (they would be dangling references, which Visio reports as errors).
 * Returns the removed shape ids.
 */
export function removeShape(root: Element, el: Element): string[] {
  const ids = new Set(
    shapeAndDescendants(el)
      .map((s) => s.getAttribute("ID"))
      .filter((id): id is string => !!id),
  );
  el.remove();

  const connects = child(root, "Connects");
  if (connects) {
    for (const c of children(connects, "Connect")) {
      if (ids.has(c.getAttribute("FromSheet") ?? "") || ids.has(c.getAttribute("ToSheet") ?? "")) {
        c.remove();
      }
    }
  }

  const ref = new RegExp(`Sheet\\.(${[...ids].join("|")})!`);
  for (const c of Array.from(root.getElementsByTagNameNS("*", "Cell"))) {
    const f = c.getAttribute("F");
    if (f && ref.test(f)) {
      c.removeAttribute("F");
      c.removeAttribute("E");
    }
  }
  return [...ids];
}

/** Move a shape to the top (`front`) or bottom (`back`) of its siblings. */
export function reorderShape(el: Element, where: "front" | "back") {
  const parent = el.parentElement;
  if (!parent) return;
  if (where === "front") {
    parent.appendChild(el);
  } else {
    const first = children(parent, "Shape")[0];
    if (first && first !== el) parent.insertBefore(el, first);
  }
}

export type NewShapeKind = "rectangle" | "ellipse" | "text";

export function nextShapeId(root: Element): string {
  let max = 0;
  for (const s of Array.from(root.getElementsByTagNameNS("*", "Shape"))) {
    const n = parseInt(s.getAttribute("ID") ?? "", 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return String(max + 1);
}

/**
 * Append a new top-level shape. `centre` is in page px (Y down); `pageToScreen`
 * is the page's Visio-inch -> px matrix. The shape is built the way Visio writes
 * its own: size-driven formulas for the geometry, style sheet 0 for the look.
 */
export function addShape(
  root: Element,
  kind: NewShapeKind,
  centre: { x: number; y: number },
  size: { width: number; height: number },
  pageToScreen: Matrix,
): string {
  const doc = root.ownerDocument;
  const ns = root.namespaceURI;
  const el = (name: string, attrs: Record<string, string> = {}, kids: Node[] = []) => {
    const e = doc.createElementNS(ns, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    kids.forEach((k) => e.appendChild(k));
    return e;
  };
  const cell = (n: string, v: string | number, f?: string) =>
    el("Cell", { N: n, V: typeof v === "number" ? fmt(v) : v, ...(f ? { F: f } : {}) });
  const row = (t: string, ix: number, cells: Element[]) => el("Row", { T: t, IX: String(ix) }, cells);

  const [pinX, pinY] = applyMatrix(invert(pageToScreen), centre.x, centre.y);
  const w = size.width / PX_PER_INCH;
  const h = size.height / PX_PER_INCH;
  const id = nextShapeId(root);

  const flags = (noFill: boolean, noLine: boolean) => [
    cell("NoFill", noFill ? 1 : 0),
    cell("NoLine", noLine ? 1 : 0),
    cell("NoShow", 0),
    cell("NoSnap", 0),
    cell("NoQuickDrag", 0),
  ];
  const rect = [
    row("MoveTo", 1, [cell("X", 0), cell("Y", 0)]),
    row("LineTo", 2, [cell("X", w, "Width"), cell("Y", 0)]),
    row("LineTo", 3, [cell("X", w, "Width"), cell("Y", h, "Height")]),
    row("LineTo", 4, [cell("X", 0), cell("Y", h, "Height")]),
    row("LineTo", 5, [cell("X", 0), cell("Y", 0)]),
  ];
  const ellipse = [
    row("Ellipse", 1, [
      cell("X", w / 2, "Width*0.5"),
      cell("Y", h / 2, "Height*0.5"),
      cell("A", w, "Width"),
      cell("B", h / 2, "Height*0.5"),
      cell("C", w / 2, "Width*0.5"),
      cell("D", h, "Height"),
    ]),
  ];

  const kids: Element[] = [
    cell("PinX", pinX),
    cell("PinY", pinY),
    cell("Width", w),
    cell("Height", h),
    cell("LocPinX", w / 2, "Width*0.5"),
    cell("LocPinY", h / 2, "Height*0.5"),
  ];
  if (kind === "text") kids.push(cell("FillPattern", 0), cell("LinePattern", 0));
  kids.push(
    el("Section", { N: "Geometry", IX: "0" }, [
      ...flags(kind === "text", kind === "text"),
      ...(kind === "ellipse" ? ellipse : rect),
    ]),
  );
  if (kind === "text") {
    kids.push(el("Text", {}, [el("cp", { IX: "0" }), doc.createTextNode("Text")]));
  }

  const shape = el("Shape", { ID: id, Type: "Shape", LineStyle: "0", FillStyle: "0", TextStyle: "0" }, kids);
  pageShapesElement(root).appendChild(shape);
  return id;
}
