/**
 * Connection ports and automatic routing of elbow (orthogonal) connectors.
 *
 * All coordinates are page px. A connector leaves a shape through a *port* (the
 * middle of one of its four sides) in the direction of that side, and the route
 * between two ports avoids the other shapes and uses as few bends as it can,
 * the way Figma, draw.io and Visio's own connectors behave.
 */
import { applyMatrix, placementMatrix } from "../model/transform";
import type { DiagramShape, Point, Side } from "../model/types";

export type { Side };
export const SIDES: Side[] = ["N", "E", "S", "W"];

const DIR: Record<Side, Point> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

export const oppositeSide = (s: Side): Side => (s === "N" ? "S" : s === "S" ? "N" : s === "E" ? "W" : "E");

export interface Port {
  side: Side;
  point: Point;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Cardinal side whose direction is closest to the vector (dx, dy). */
function cardinal(dx: number, dy: number): Side {
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "E" : "W") : dy >= 0 ? "S" : "N";
}

/**
 * The four ports of a shape: the middle of each side of its frame, with the
 * direction pointing out of the shape. Rotated or mirrored shapes get ports on
 * the sides that now face north/east/south/west.
 */
export function portsOf(shape: Pick<DiagramShape, "x" | "y" | "width" | "height" | "rotation" | "flipX">): Port[] {
  const m = placementMatrix(shape);
  const w = shape.width;
  const h = shape.height;
  return [
    [w / 2, 0, 0, -1],
    [w, h / 2, 1, 0],
    [w / 2, h, 0, 1],
    [0, h / 2, -1, 0],
  ].map(([bx, by, nx, ny]) => {
    const [px, py] = applyMatrix(m, bx, by);
    // outward normal: the linear part of the matrix applied to the box-frame normal
    const dx = m[0] * nx + m[2] * ny;
    const dy = m[1] * nx + m[3] * ny;
    return { side: cardinal(dx, dy), point: { x: px, y: py } };
  });
}

export function portOf(shape: Parameters<typeof portsOf>[0], side: Side): Port {
  const ports = portsOf(shape);
  return ports.find((p) => p.side === side) ?? ports[0];
}

/** The port closest to a point. */
export function nearestPort(shape: Parameters<typeof portsOf>[0], p: Point): Port {
  return portsOf(shape).reduce((best, q) =>
    Math.hypot(q.point.x - p.x, q.point.y - p.y) < Math.hypot(best.point.x - p.x, best.point.y - p.y) ? q : best,
  );
}

/** Axis-aligned bounding box of a (possibly rotated) shape frame. */
export function rectOf(shape: Parameters<typeof portsOf>[0]): Rect {
  const m = placementMatrix(shape);
  const pts = [
    [0, 0],
    [shape.width, 0],
    [shape.width, shape.height],
    [0, shape.height],
  ].map(([x, y]) => applyMatrix(m, x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

export interface RouteEnd {
  point: Point;
  /** Side of the shape the connector attaches to. Without one the end is free (no stub, any approach). */
  side?: Side;
}

export interface RouteOptions {
  obstacles: Rect[];
  /** Clearance kept around obstacles. */
  margin?: number;
  /** Length of the straight piece that leaves a port before the route may turn. */
  stub?: number;
  bendCost?: number;
}

export interface Route {
  points: Point[];
  bends: number;
  length: number;
  /** Search cost (length plus bend penalties): comparable between routes of the same options. */
  cost: number;
}

const DEFAULTS = { margin: 8, stub: 14, bendCost: 40 };
const EPS = 1e-6;

const add = (p: Point, d: Point, k: number): Point => ({ x: p.x + d.x * k, y: p.y + d.y * k });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Remove repeated points and points in the middle of a straight run. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && dist(last, p) < EPS) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const along = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
    if (Math.abs(cross) < EPS && along > 0) out.splice(i, 1);
  }
  return out;
}

function countBends(points: Point[]): number {
  let bends = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > EPS) bends++;
  }
  return bends;
}

function pathLength(points: Point[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += dist(points[i - 1], points[i]);
  return l;
}

/** A tidy elbow that ignores obstacles: used when the search finds no way through. */
function fallbackElbow(from: RouteEnd & { side: Side }, to: RouteEnd, stub: number): Point[] {
  const a = from.point;
  const b = to.point;
  const horizontal = from.side === "E" || from.side === "W";
  const a1 = add(a, DIR[from.side], stub);
  if (!to.side) {
    return simplify(horizontal ? [a, a1, { x: a1.x, y: b.y }, b] : [a, a1, { x: b.x, y: a1.y }, b]);
  }
  const b1 = add(b, DIR[to.side], stub);
  const toHorizontal = to.side === "E" || to.side === "W";
  if (horizontal === toHorizontal) {
    // Parallel exits: meet halfway between the stubs.
    if (horizontal) {
      const mx = (a1.x + b1.x) / 2;
      return simplify([a, a1, { x: mx, y: a1.y }, { x: mx, y: b1.y }, b1, b]);
    }
    const my = (a1.y + b1.y) / 2;
    return simplify([a, a1, { x: a1.x, y: my }, { x: b1.x, y: my }, b1, b]);
  }
  return simplify([a, a1, horizontal ? { x: b1.x, y: a1.y } : { x: a1.x, y: b1.y }, b1, b]);
}

/** Binary min-heap keyed by number. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    let i = this.keys.length;
    this.keys.push(key);
    this.vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      [this.keys[p], this.keys[i]] = [this.keys[i], this.keys[p]];
      [this.vals[p], this.vals[i]] = [this.vals[i], this.vals[p]];
      i = p;
    }
  }
  pop(): number {
    const top = this.vals[0];
    const lastK = this.keys.pop()!;
    const lastV = this.vals.pop()!;
    if (this.keys.length) {
      this.keys[0] = lastK;
      this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        [this.keys[m], this.keys[i]] = [this.keys[i], this.keys[m]];
        [this.vals[m], this.vals[i]] = [this.vals[i], this.vals[m]];
        i = m;
      }
    }
    return top;
  }
}

const DIRS: Point[] = [DIR.N, DIR.E, DIR.S, DIR.W]; // index = direction id
const dirIndex = (d: Point) => DIRS.findIndex((x) => x.x === d.x && x.y === d.y);

/**
 * Route an orthogonal connector from one end to another.
 *
 * The search runs on the grid formed by the lines through the endpoints and the
 * (inflated) edges of nearby obstacles, with a penalty per bend, so routes hug
 * obstacles and turn as little as possible. Paths leave and enter through the
 * ports' sides, never through the shape itself.
 */
export function routeElbow(from: RouteEnd & { side: Side }, to: RouteEnd, options: RouteOptions): Route {
  const margin = options.margin ?? DEFAULTS.margin;
  const stub = options.stub ?? DEFAULTS.stub;
  const bendCost = options.bendCost ?? DEFAULTS.bendCost;

  const s0 = add(from.point, DIR[from.side], stub);
  const s1 = to.side ? add(to.point, DIR[to.side], stub) : to.point;

  // Only obstacles near the connector matter; ones that swallow a stub point can't be avoided.
  const pad = 250;
  const minX = Math.min(s0.x, s1.x) - pad;
  const maxX = Math.max(s0.x, s1.x) + pad;
  const minY = Math.min(s0.y, s1.y) - pad;
  const maxY = Math.max(s0.y, s1.y) + pad;
  const strictlyIn = (r: Rect, p: Point) =>
    p.x > r.x + EPS && p.x < r.x + r.width - EPS && p.y > r.y + EPS && p.y < r.y + r.height - EPS;
  const obs = options.obstacles
    .map((o) => ({ x: o.x - margin, y: o.y - margin, width: o.width + 2 * margin, height: o.height + 2 * margin }))
    .filter(
      (o) =>
        o.x < maxX && o.x + o.width > minX && o.y < maxY && o.y + o.height > minY && !strictlyIn(o, s0) && !strictlyIn(o, s1),
    )
    .slice(0, 120);

  const xsSet = new Set<number>([s0.x, s1.x, (s0.x + s1.x) / 2]);
  const ysSet = new Set<number>([s0.y, s1.y, (s0.y + s1.y) / 2]);
  for (const o of obs) {
    xsSet.add(o.x);
    xsSet.add(o.x + o.width);
    ysSet.add(o.y);
    ysSet.add(o.y + o.height);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const nx = xs.length;
  const ny = ys.length;
  const node = (i: number, j: number) => i * ny + j;

  // Which grid nodes and edges lie inside an obstacle, worked out once per obstacle instead of
  // on every step of the search. Obstacle edges are grid lines, so an edge is blocked exactly
  // when it lies strictly within the obstacle on one axis and between its sides on the other.
  const indexX = new Map(xs.map((x, i) => [x, i]));
  const indexY = new Map(ys.map((y, j) => [y, j]));
  const blockedNode = new Uint8Array(nx * ny);
  const blockedH = new Uint8Array(nx * ny); // edge (i, j) -> (i + 1, j)
  const blockedV = new Uint8Array(nx * ny); // edge (i, j) -> (i, j + 1)
  for (const o of obs) {
    const iL = indexX.get(o.x)!;
    const iR = indexX.get(o.x + o.width)!;
    const jT = indexY.get(o.y)!;
    const jB = indexY.get(o.y + o.height)!;
    for (let i = iL; i <= iR; i++) {
      for (let j = jT; j <= jB; j++) {
        const inX = i > iL && i < iR;
        const inY = j > jT && j < jB;
        if (inX && inY) blockedNode[node(i, j)] = 1;
        if (inY && i < iR) blockedH[node(i, j)] = 1;
        if (inX && j < jB) blockedV[node(i, j)] = 1;
      }
    }
  }
  /** Is the step from (i, j) in direction `nd` (0 N, 1 E, 2 S, 3 W) blocked? */
  const stepBlocked = (i: number, j: number, nd: number) =>
    nd === 1 ? blockedH[node(i, j)] === 1 : nd === 3 ? blockedH[node(i - 1, j)] === 1 : nd === 2 ? blockedV[node(i, j)] === 1 : blockedV[node(i, j - 1)] === 1;

  const iStart = xs.indexOf(s0.x);
  const jStart = ys.indexOf(s0.y);
  const iEnd = xs.indexOf(s1.x);
  const jEnd = ys.indexOf(s1.y);

  const startDir = dirIndex(DIR[from.side]);
  const endDir = to.side ? dirIndex(DIR[oppositeSide(to.side)]) : -1; // direction of travel into the end shape

  const total = nx * ny * 4;
  const best = new Float64Array(total).fill(Infinity);
  const parent = new Int32Array(total).fill(-1);
  const heap = new Heap();
  const state = (i: number, j: number, d: number) => node(i, j) * 4 + d;
  const heuristic = (i: number, j: number) => Math.abs(xs[i] - s1.x) + Math.abs(ys[j] - s1.y);

  const first = state(iStart, jStart, startDir);
  best[first] = 0;
  heap.push(heuristic(iStart, jStart), first);

  let goal = -1;
  let goalCost = Infinity;
  while (heap.size > 0) {
    const cur = heap.pop();
    const d = cur % 4;
    const n = (cur - d) / 4;
    const j = n % ny;
    const i = (n - j) / ny;
    const g = best[cur];
    if (g + heuristic(i, j) >= goalCost) continue;
    if (i === iEnd && j === jEnd) {
      // Arriving in a different direction than the end shape expects costs one more bend.
      const total2 = g + (endDir >= 0 && d !== endDir ? bendCost : 0);
      if (total2 < goalCost) {
        goalCost = total2;
        goal = cur;
      }
      continue;
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue; // no U-turns
      const i2 = i + (nd === 1 ? 1 : nd === 3 ? -1 : 0);
      const j2 = j + (nd === 2 ? 1 : nd === 0 ? -1 : 0);
      if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
      if (blockedNode[node(i2, j2)] || stepBlocked(i, j, nd)) continue;
      const step = Math.abs(xs[i2] - xs[i]) + Math.abs(ys[j2] - ys[j]);
      const cost = g + step + (nd !== d ? bendCost : 0);
      const s2 = state(i2, j2, nd);
      if (cost < best[s2]) {
        best[s2] = cost;
        parent[s2] = cur;
        heap.push(cost + heuristic(i2, j2), s2);
      }
    }
  }

  let points: Point[];
  let cost = goalCost;
  if (goal < 0) {
    points = fallbackElbow(from, to, stub);
    cost = pathLength(points) + countBends(points) * bendCost + 1e6; // worse than any found route
  } else {
    const chain: Point[] = [];
    for (let s = goal; s >= 0; s = parent[s]) {
      const d = s % 4;
      const n = (s - d) / 4;
      const j = n % ny;
      chain.push({ x: xs[(n - j) / ny], y: ys[j] });
    }
    chain.reverse();
    points = simplify([from.point, ...chain, ...(to.side ? [to.point] : [])]);
  }
  return { points, bends: countBends(points), length: pathLength(points), cost };
}

/** Pieces of a straight connector (no routing). */
export function routeStraight(from: RouteEnd, to: RouteEnd): Route {
  const points = [from.point, to.point];
  return { points, bends: 0, length: dist(from.point, to.point), cost: dist(from.point, to.point) };
}

/**
 * Pick the best pair of sides for an elbow connector between two shapes, or from
 * a shape to a free point, by trying the candidates and keeping the cheapest route.
 */
export function bestElbow(
  fromShape: Parameters<typeof portsOf>[0],
  to: Parameters<typeof portsOf>[0] | Point,
  options: RouteOptions,
  fixed: { from?: Side; to?: Side } = {},
): { from: Port; to?: Port; route: Route } {
  const fromPorts = fixed.from ? [portOf(fromShape, fixed.from)] : portsOf(fromShape);
  const isShape = (t: typeof to): t is Parameters<typeof portsOf>[0] => "width" in t;
  const toPorts: (Port | undefined)[] = isShape(to) ? (fixed.to ? [portOf(to, fixed.to)] : portsOf(to)) : [undefined];

  let best: { from: Port; to?: Port; route: Route } | undefined;
  for (const f of fromPorts) {
    for (const t of toPorts) {
      const end: RouteEnd = t ? { point: t.point, side: t.side } : { point: to as Point };
      const route = routeElbow({ point: f.point, side: f.side }, end, options);
      if (!best || route.cost < best.route.cost) best = { from: f, to: t, route };
    }
  }
  return best!;
}
