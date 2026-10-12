import { PX_PER_INCH } from "./coordinateTransform";
import type { GeometryPath, PathCommand } from "../model/types";
import type { Row, Section } from "./types";
import type { Axis, ShapeSheet } from "./sheet";

const EPS = 1e-6;

interface Pt {
  x: number;
  y: number;
}

/** Everything the row handlers need; all coordinates are Visio local inches, Y up. */
class PathBuilder {
  cmds: PathCommand[] = [];
  cur: Pt = { x: 0, y: 0 };
  start: Pt = { x: 0, y: 0 };
  hasPoint = false;
  private heightIn: number;

  constructor(heightIn: number) {
    this.heightIn = heightIn;
  }

  /** Visio local inches (Y up) -> px box frame (Y down). */
  private px(p: Pt): Pt {
    return { x: p.x * PX_PER_INCH, y: (this.heightIn - p.y) * PX_PER_INCH };
  }

  moveTo(p: Pt) {
    const q = this.px(p);
    this.cmds.push({ op: "M", x: q.x, y: q.y });
    this.cur = p;
    this.start = p;
    this.hasPoint = true;
  }

  lineTo(p: Pt) {
    if (!this.hasPoint) return this.moveTo(p);
    const q = this.px(p);
    this.cmds.push({ op: "L", x: q.x, y: q.y });
    this.cur = p;
  }

  quadTo(c: Pt, p: Pt) {
    if (!this.hasPoint) return this.moveTo(p);
    const qc = this.px(c);
    const q = this.px(p);
    this.cmds.push({ op: "Q", x1: qc.x, y1: qc.y, x: q.x, y: q.y });
    this.cur = p;
  }

  cubicTo(c1: Pt, c2: Pt, p: Pt) {
    if (!this.hasPoint) return this.moveTo(p);
    const a = this.px(c1);
    const b = this.px(c2);
    const q = this.px(p);
    this.cmds.push({ op: "C", x1: a.x, y1: a.y, x2: b.x, y2: b.y, x: q.x, y: q.y });
    this.cur = p;
  }

  /** `ccw` is the direction in Visio's Y-up frame. */
  arcTo(p: Pt, rx: number, ry: number, rotRad: number, large: boolean, ccw: boolean) {
    if (!this.hasPoint) return this.moveTo(p);
    const q = this.px(p);
    this.cmds.push({
      op: "A",
      rx: rx * PX_PER_INCH,
      ry: ry * PX_PER_INCH,
      // Y flip turns a CCW rotation of the axis into a CW one in SVG terms.
      rotation: (-rotRad * 180) / Math.PI,
      largeArc: large,
      // CCW in Y-up becomes sweep=0 in SVG's Y-down frame.
      sweep: !ccw,
      x: q.x,
      y: q.y,
    });
    this.cur = p;
  }

  close() {
    this.cmds.push({ op: "Z" });
    this.cur = this.start;
  }
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Circle through three points, or undefined if (almost) collinear. */
function circumcircle(a: Pt, b: Pt, c: Pt): { c: Pt; r: number } | undefined {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < EPS) return undefined;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const center = { x: ux, y: uy };
  return { c: center, r: dist(center, a) };
}

const TWO_PI = Math.PI * 2;
const mod2pi = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/** EllipticalArcTo: arc from `p0` to `p1` passing through `pc`, on an ellipse with major axis angle `angle` and axis ratio `ratio`. */
function ellipticalArc(
  b: PathBuilder,
  p0: Pt,
  p1: Pt,
  pc: Pt,
  angle: number,
  ratio: number,
) {
  const d = ratio > EPS ? ratio : 1;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Rotate by -angle, then squash the major axis so the ellipse becomes a circle.
  const t = (p: Pt): Pt => ({
    x: (p.x * cos + p.y * sin) / d,
    y: -p.x * sin + p.y * cos,
  });
  const q0 = t(p0);
  const qc = t(pc);
  const q1 = t(p1);
  const circle = circumcircle(q0, qc, q1);
  if (!circle) return b.lineTo(p1);
  const a0 = Math.atan2(q0.y - circle.c.y, q0.x - circle.c.x);
  const ac = Math.atan2(qc.y - circle.c.y, qc.x - circle.c.x);
  const a1 = Math.atan2(q1.y - circle.c.y, q1.x - circle.c.x);
  const toEnd = mod2pi(a1 - a0);
  const toCtl = mod2pi(ac - a0);
  const ccw = toCtl < toEnd;
  const span = ccw ? toEnd : TWO_PI - toEnd;
  b.arcTo(p1, circle.r * d, circle.r, angle, span > Math.PI, ccw);
}

/** ArcTo: circular arc whose midpoint is `bow` away from the chord. */
function bulgeArc(b: PathBuilder, p0: Pt, p1: Pt, bow: number) {
  const chord = dist(p0, p1);
  if (chord < EPS || Math.abs(bow) < EPS) return b.lineTo(p1);
  const r = (chord * chord) / 4 / (2 * Math.abs(bow)) + Math.abs(bow) / 2;
  b.arcTo(p1, r, r, 0, Math.abs(bow) > r, bow < 0 ? false : true);
}

function ellipseRow(b: PathBuilder, c: Pt, a: Pt, e: Pt) {
  const rx = dist(c, a);
  const ry = dist(c, e);
  if (rx < EPS || ry < EPS) return;
  const phi = Math.atan2(a.y - c.y, a.x - c.x);
  const right = { x: c.x + rx * Math.cos(phi), y: c.y + rx * Math.sin(phi) };
  const left = { x: c.x - rx * Math.cos(phi), y: c.y - rx * Math.sin(phi) };
  b.moveTo(right);
  b.arcTo(left, rx, ry, phi, false, true);
  b.arcTo(right, rx, ry, phi, false, true);
  b.close();
}

/** Parse the numeric arguments of `POLYLINE(xType, yType, x1, y1, ...)`. */
function polylineArgs(f: string | undefined): { xType: number; yType: number; pts: Pt[] } | undefined {
  if (!f) return undefined;
  const m = /^\s*POLYLINE\s*\((.*)\)\s*$/i.exec(f);
  if (!m) return undefined;
  const nums = m[1].split(",").map((s) => parseFloat(s));
  if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return undefined;
  const [xType, yType, ...rest] = nums;
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < rest.length; i += 2) pts.push({ x: rest[i], y: rest[i + 1] });
  return { xType, yType, pts };
}

function buildRow(b: PathBuilder, row: Row, sheet: ShapeSheet) {
  const w = sheet.width;
  const h = sheet.height;
  const cell = (n: string, axis: Axis): number | undefined => {
    const c = row.cells.get(n);
    return c ? sheet.value(c, axis) : undefined;
  };
  const abs = (nx: string, ny: string): Pt | undefined => {
    const x = cell(nx, "x");
    const y = cell(ny, "y");
    return x === undefined || y === undefined ? undefined : { x, y };
  };
  const rel = (nx: string, ny: string): Pt | undefined => {
    const x = cell(nx, "none");
    const y = cell(ny, "none");
    return x === undefined || y === undefined ? undefined : { x: x * w, y: y * h };
  };

  switch (row.type) {
    case "MoveTo": {
      const p = abs("X", "Y");
      if (p) b.moveTo(p);
      break;
    }
    case "LineTo": {
      const p = abs("X", "Y");
      if (p) b.lineTo(p);
      break;
    }
    case "RelMoveTo": {
      const p = rel("X", "Y");
      if (p) b.moveTo(p);
      break;
    }
    case "RelLineTo": {
      const p = rel("X", "Y");
      if (p) b.lineTo(p);
      break;
    }
    case "ArcTo": {
      const p = abs("X", "Y");
      if (!p) break;
      const bow = cell("A", "none") ?? 0;
      bulgeArc(b, b.cur, p, bow);
      break;
    }
    case "EllipticalArcTo": {
      const p = abs("X", "Y");
      const c = abs("A", "B");
      if (!p) break;
      if (!c) b.lineTo(p);
      else ellipticalArc(b, b.cur, p, c, cell("C", "none") ?? 0, cell("D", "none") ?? 1);
      break;
    }
    case "RelEllipticalArcTo": {
      const p = rel("X", "Y");
      const c = rel("A", "B");
      if (!p) break;
      if (!c) b.lineTo(p);
      else ellipticalArc(b, b.cur, p, c, cell("C", "none") ?? 0, cell("D", "none") ?? 1);
      break;
    }
    case "Ellipse": {
      const c = abs("X", "Y");
      const a = abs("A", "B");
      const e = abs("C", "D");
      if (c && a && e) ellipseRow(b, c, a, e);
      break;
    }
    case "QuadBezTo": {
      const p = abs("X", "Y");
      const c = abs("A", "B");
      if (p && c) b.quadTo(c, p);
      else if (p) b.lineTo(p);
      break;
    }
    case "RelQuadBezTo": {
      const p = rel("X", "Y");
      const c = rel("A", "B");
      if (p && c) b.quadTo(c, p);
      else if (p) b.lineTo(p);
      break;
    }
    case "CubBezTo": {
      const p = abs("X", "Y");
      const c1 = abs("A", "B");
      const c2 = abs("C", "D");
      if (p && c1 && c2) b.cubicTo(c1, c2, p);
      else if (p) b.lineTo(p);
      break;
    }
    case "RelCubBezTo": {
      const p = rel("X", "Y");
      const c1 = rel("A", "B");
      const c2 = rel("C", "D");
      if (p && c1 && c2) b.cubicTo(c1, c2, p);
      else if (p) b.lineTo(p);
      break;
    }
    case "PolylineTo": {
      const p = abs("X", "Y");
      const poly = polylineArgs(row.cells.get("A")?.f) ?? polylineArgs(row.cells.get("A")?.v);
      if (poly) {
        for (const q of poly.pts) {
          b.lineTo({
            x: poly.xType === 0 ? q.x * w : q.x,
            y: poly.yType === 0 ? q.y * h : q.y,
          });
        }
      }
      if (p) b.lineTo(p);
      break;
    }
    case "SplineKnot":
    case "NURBSTo": {
      // Approximated by straight segments between the on-curve points.
      const p = abs("X", "Y");
      if (p) b.lineTo(p);
      break;
    }
    default:
      // InfiniteLine, SplineStart, ... are not drawn.
      break;
  }
}

/** Replace sharp corners of an M/L/Z polyline by quadratic curves of (at most) radius `r` px. */
function roundCorners(cmds: PathCommand[], r: number): PathCommand[] {
  const pts: { x: number; y: number }[] = [];
  let closed = false;
  for (const c of cmds) {
    if (c.op === "M" || c.op === "L") pts.push({ x: c.x, y: c.y });
    else if (c.op === "Z") closed = true;
    else return cmds; // curves: leave untouched
  }
  if (pts.length > 1 && closed === false) {
    const f = pts[0];
    const l = pts[pts.length - 1];
    closed = Math.hypot(f.x - l.x, f.y - l.y) < EPS;
  }
  if (closed && pts.length > 1) {
    const f = pts[0];
    const l = pts[pts.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) < EPS) pts.pop();
  }
  if (pts.length < 3) return cmds;

  const out: PathCommand[] = [];
  const n = pts.length;
  const lim = closed ? n : n - 2;
  const at = (i: number) => pts[((i % n) + n) % n];
  const toward = (a: { x: number; y: number }, b: { x: number; y: number }, d: number) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: a.x + ((b.x - a.x) / len) * d, y: a.y + ((b.y - a.y) / len) * d };
  };
  const radiusAt = (i: number) =>
    Math.min(
      r,
      Math.hypot(at(i).x - at(i - 1).x, at(i).y - at(i - 1).y) / 2,
      Math.hypot(at(i + 1).x - at(i).x, at(i + 1).y - at(i).y) / 2,
    );

  if (!closed) out.push({ op: "M", x: pts[0].x, y: pts[0].y });
  for (let k = 0; k < lim; k++) {
    const i = closed ? k : k + 1;
    const p = at(i);
    const rad = radiusAt(i);
    const a = toward(p, at(i - 1), rad);
    const b = toward(p, at(i + 1), rad);
    out.push(k === 0 && closed ? { op: "M", x: a.x, y: a.y } : { op: "L", x: a.x, y: a.y });
    out.push({ op: "Q", x1: p.x, y1: p.y, x: b.x, y: b.y });
  }
  if (closed) out.push({ op: "Z" });
  else out.push({ op: "L", x: pts[n - 1].x, y: pts[n - 1].y });
  return out;
}

export interface BuiltGeometry {
  paths: GeometryPath[];
  /** Number of the Ellipse rows seen (used for shape type detection). */
  ellipseRows: number;
  /** A single path that is exactly the four corners of the shape's box. */
  isRect: boolean;
}

function looksLikeRect(cmds: PathCommand[], wPx: number, hPx: number): boolean {
  const pts: Pt[] = [];
  for (const c of cmds) {
    if (c.op === "M" || c.op === "L") pts.push({ x: c.x, y: c.y });
    else if (c.op !== "Z") return false;
  }
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-3) {
    pts.pop();
  }
  if (pts.length !== 4) return false;
  const tol = 0.5;
  const corners = new Set<string>();
  for (const p of pts) {
    const cx = Math.abs(p.x) < tol ? 0 : Math.abs(p.x - wPx) < tol ? 1 : -1;
    const cy = Math.abs(p.y) < tol ? 0 : Math.abs(p.y - hPx) < tol ? 1 : -1;
    if (cx < 0 || cy < 0) return false;
    corners.add(`${cx}${cy}`);
  }
  return corners.size === 4;
}

function sortedGeometrySections(sheet: ShapeSheet): Section[] {
  const secs: Section[] = [];
  for (const [key, s] of sheet.data.sections) {
    if (key.startsWith("Geometry#")) secs.push(s);
  }
  return secs.sort((a, b) => Number(a.ix) - Number(b.ix));
}

/** Build model geometry (px, box frame, Y down) from a shape's Geometry sections. */
export function buildGeometry(sheet: ShapeSheet, roundingPx: number): BuiltGeometry {
  const paths: GeometryPath[] = [];
  let ellipseRows = 0;
  let isRect = false;
  for (const sec of sortedGeometrySections(sheet)) {
    const flag = (n: string) => {
      const c = sec.cells.get(n);
      return c ? c.v === "1" || c.v.toLowerCase() === "true" : false;
    };
    if (flag("NoShow")) continue;

    const b = new PathBuilder(sheet.height);
    const rows = [...sec.rows.values()].sort((x, y) => Number(x.ix) - Number(y.ix));
    for (const row of rows) {
      if (row.type === "Ellipse") ellipseRows++;
      buildRow(b, row, sheet);
    }
    if (b.cmds.length === 0) continue;

    // Visio fills implicitly-closed shapes; close the path when it returns to its start.
    const last = b.cmds[b.cmds.length - 1];
    const first = b.cmds[0];
    if (
      last.op !== "Z" &&
      first.op === "M" &&
      "x" in last &&
      Math.hypot(last.x - first.x, last.y - first.y) < 1e-3 &&
      b.cmds.length > 2
    ) {
      b.cmds.push({ op: "Z" });
    }

    if (paths.length === 0) {
      isRect = looksLikeRect(b.cmds, sheet.width * PX_PER_INCH, sheet.height * PX_PER_INCH);
    } else {
      isRect = false;
    }
    const cmds = roundingPx > 0 ? roundCorners(b.cmds, roundingPx) : b.cmds;
    paths.push({ commands: cmds, fill: !flag("NoFill"), stroke: !flag("NoLine") });
  }
  return { paths, ellipseRows, isRect };
}
