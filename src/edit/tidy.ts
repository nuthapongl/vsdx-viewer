/**
 * Tidying lines (pure; no XML): a proposal for each line that can be improved, to be
 * previewed before anything is written.
 *
 * - A line whose two ends are known nodes is routed again like a new connector: right
 *   angles, around the other shapes, as few bends as it can.
 * - Any other line is only cleaned: points on a straight run and tiny jogs removed,
 *   nearly horizontal / vertical pieces made exactly so.
 * - Lines that run over one another along the same stretch are then moved apart into
 *   side-by-side lanes (their first and last pieces stay where they attach).
 */
import type { DiagramShape, Point } from "../model/types";
import type { Topology } from "../analysis/graph";
import { lineVertices } from "./connectors";
import { obstaclesFor, planRoute } from "./connectorPlan";
import { simplify, type Rect } from "./routing";

export interface Tidied {
  lineId: string;
  before: Point[];
  after: Point[];
  /** Routed again between its two nodes, or only cleaned up. */
  how: "rerouted" | "cleaned";
}

export interface RouteStats {
  lines: number;
  bends: number;
  /** Total length in px. */
  length: number;
  /** Places where two different lines cross. */
  crossings: number;
  /** Length in px over which different lines run side by side closer than a lane. */
  tight: number;
}

const SNAP = 3; // px: a piece this close to horizontal / vertical becomes exactly so
const JOG = 8; // px: a step of this size or less between two parallel pieces is removed
const GAP = 7.5; // px between side-by-side lines
const LANE = GAP; // lines closer than this count as crowded
const CHANNEL = 14; // px: lines this close that share a stretch are laid out together

const same = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

/** Snap nearly straight pieces, drop tiny jogs and points on a straight run. */
export function cleanPolyline(points: Point[]): Point[] {
  let pts = points.map((p) => ({ ...p }));
  for (let pass = 0; pass < 3; pass++) {
    // nearly horizontal / vertical pieces
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      if (Math.abs(a.y - b.y) <= SNAP && Math.abs(a.x - b.x) > SNAP) {
        if (i < pts.length - 1) b.y = a.y;
        else if (i - 1 > 0) a.y = b.y;
      } else if (Math.abs(a.x - b.x) <= SNAP && Math.abs(a.y - b.y) > SNAP) {
        if (i < pts.length - 1) b.x = a.x;
        else if (i - 1 > 0) a.x = b.x;
      }
    }
    // a tiny step between two parallel pieces: [.., p, q, r, s, ..] with |q-r| <= JOG and p-q, r-s parallel
    for (let i = 1; i + 2 < pts.length - 0 && pts.length > 4; i++) {
      const [q, r] = [pts[i], pts[i + 1]];
      const p = pts[i - 1];
      const s = pts[i + 2];
      if (!s) break;
      const horizontalRuns = same(p.y, q.y) && same(r.y, s.y) && same(q.x, r.x) && Math.abs(q.y - r.y) <= JOG;
      const verticalRuns = same(p.x, q.x) && same(r.x, s.x) && same(q.y, r.y) && Math.abs(q.x - r.x) <= JOG;
      // keep the ends where they are: move the inner piece onto the outer one that is free to move
      if (horizontalRuns && i + 2 < pts.length - 1) {
        pts[i + 1] = { x: r.x, y: q.y };
        pts[i + 2] = { x: s.x, y: q.y };
      } else if (verticalRuns && i + 2 < pts.length - 1) {
        pts[i + 1] = { x: q.x, y: r.y };
        pts[i + 2] = { x: q.x, y: s.y };
      }
    }
    pts = simplify(pts);
  }
  return pts;
}

interface Seg {
  line: number;
  idx: number; // segment i joins points i and i+1
  horizontal: boolean;
  at: number; // y for a horizontal piece, x for a vertical one
  lo: number;
  hi: number;
}

function segmentsOf(routes: Point[][]): Seg[] {
  const out: Seg[] = [];
  routes.forEach((pts, line) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      if (same(a.y, b.y) && !same(a.x, b.x)) out.push({ line, idx: i, horizontal: true, at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
      else if (same(a.x, b.x) && !same(a.y, b.y)) out.push({ line, idx: i, horizontal: false, at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
    }
  });
  return out;
}

const hitsRect = (a: Point, b: Point, r: Rect) => {
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return x1 > r.x + 1 && x0 < r.x + r.width - 1 && y1 > r.y + 1 && y0 < r.y + r.height - 1;
};

export interface LaneOptions {
  obstacles?: Rect[];
  /**
   * Per line, for its first and last piece: the range an end may slide along the frame it
   * touches (a zone's border), or undefined when the end must stay where it is.
   */
  slide?: ({ lo: number; hi: number } | undefined)[][];
}

/**
 * Move lines that run side by side (or on top of one another) into evenly spaced lanes. All
 * the lines of a channel are laid out together, in the order they already have, so no new
 * crossings appear. A piece that touches an end of its line stays put unless that end may
 * slide along a border; a channel that would end up inside a shape, or off a border, is
 * left as it was. Returns new routes.
 */
export function spreadLanes(routes: Point[][], options: LaneOptions = {}): Point[][] {
  const obstacles = options.obstacles ?? [];
  const out = routes.map((r) => simplify(r.map((p) => ({ ...p }))));
  const slideOf = (s: Seg) => {
    const pts = out[s.line];
    if (s.idx === 0) return options.slide?.[s.line]?.[0];
    if (s.idx + 1 === pts.length - 1) return options.slide?.[s.line]?.[1];
    return null; // interior: free
  };
  const movable = (s: Seg) => slideOf(s) !== undefined;

  for (let round = 0; round < 2; round++) {
    for (const horizontal of [true, false]) {
      const segs = segmentsOf(out).filter((s) => s.horizontal === horizontal).sort((a, b) => a.at - b.at || a.line - b.line);
      const clusters: Seg[][] = [];
      for (const s of segs) {
        const c = clusters.find((cl) => s.at - cl[cl.length - 1].at < CHANNEL && cl.some((o) => Math.min(o.hi, s.hi) - Math.max(o.lo, s.lo) > 6));
        if (c) c.push(s);
        else clusters.push([s]);
      }
      for (const cl of clusters) {
        if (new Set(cl.map((s) => s.line)).size < 2) continue;
        // Lanes sit on a regular grid, so the gaps are all equal. Pieces that cannot move are
        // placed first; the others take the nearest free slot of the grid (two pieces may share
        // a slot when they do not share a stretch of it).
        const base = Math.min(...cl.map((s) => s.at));
        const placed: { at: number; lo: number; hi: number }[] = cl.filter((s) => !movable(s)).map((s) => ({ at: s.at, lo: s.lo, hi: s.hi }));
        const clash = (s: Seg, at: number) => placed.some((q) => Math.abs(q.at - at) < GAP - 0.5 && Math.min(q.hi, s.hi) - Math.max(q.lo, s.lo) > 6);
        const usable = (s: Seg, at: number) => {
          const range = slideOf(s);
          if (range && (at < range.lo || at > range.hi)) return false;
          const pts = out[s.line];
          const moved = (j: number) =>
            horizontal
              ? { x: pts[j].x, y: j === s.idx || j === s.idx + 1 ? at : pts[j].y }
              : { x: j === s.idx || j === s.idx + 1 ? at : pts[j].x, y: pts[j].y };
          // a shape the piece already ran through does not count against it
          return ![s.idx - 1, s.idx, s.idx + 1].some(
            (i) =>
              i >= 0 &&
              i + 1 < pts.length &&
              obstacles.some((r) => hitsRect(moved(i), moved(i + 1), r) && !hitsRect(pts[i], pts[i + 1], r)),
          );
        };
        const moves: { s: Seg; at: number }[] = [];
        for (const s of cl.filter(movable)) {
          const k0 = Math.round((s.at - base) / GAP);
          let chosen: number | undefined;
          for (let d = 0; d <= cl.length + 2 && chosen === undefined; d++) {
            for (const k of d === 0 ? [k0] : [k0 + d, k0 - d]) {
              const at = base + k * GAP;
              if (k >= 0 && !clash(s, at) && usable(s, at)) {
                chosen = at;
                break;
              }
            }
          }
          const at = chosen ?? s.at;
          placed.push({ at, lo: s.lo, hi: s.hi });
          if (Math.abs(at - s.at) >= 0.25) moves.push({ s, at });
        }
        for (const { s, at } of moves) {
          for (const j of [s.idx, s.idx + 1]) {
            if (horizontal) out[s.line][j].y = at;
            else out[s.line][j].x = at;
          }
        }
      }
    }
  }
  // A line that was square must stay square: if a move left a slanted piece, keep the line as it was.
  const slanted = (pts: Point[]) => pts.slice(1).some((p, i) => !same(p.x, pts[i].x, 0.6) && !same(p.y, pts[i].y, 0.6));
  return out.map((r, k) => (slanted(r) && !slanted(routes[k]) ? simplify(routes[k]) : simplify(r)));
}

/** Groups of lines that run side by side (within a channel's width), with their positions across it. */
export function channelsOf(routes: Point[][]): { horizontal: boolean; at: number[] }[] {
  const out: { horizontal: boolean; at: number[] }[] = [];
  for (const horizontal of [true, false]) {
    const segs = segmentsOf(routes).filter((s) => s.horizontal === horizontal).sort((a, b) => a.at - b.at || a.line - b.line);
    const clusters: Seg[][] = [];
    for (const s of segs) {
      const c = clusters.find((cl) => s.at - cl[cl.length - 1].at < CHANNEL && cl.some((o) => o.line !== s.line && Math.min(o.hi, s.hi) - Math.max(o.lo, s.lo) > 6));
      if (c) c.push(s);
      else clusters.push([s]);
    }
    for (const cl of clusters) if (new Set(cl.map((s) => s.line)).size > 1) out.push({ horizontal, at: cl.map((s) => Math.round(s.at * 10) / 10) });
  }
  return out;
}

/** Numbers that say how tidy a set of routes is. */
export function routeStats(routes: Point[][]): RouteStats {
  let bends = 0;
  let length = 0;
  for (const pts of routes) {
    bends += Math.max(0, pts.length - 2);
    for (let i = 0; i + 1 < pts.length; i++) length += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  const segs = segmentsOf(routes);
  let crossings = 0;
  let tight = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = [segs[i], segs[j]];
      if (a.line === b.line) continue;
      if (a.horizontal === b.horizontal) {
        if (Math.abs(a.at - b.at) < LANE - 0.5) tight += Math.max(0, Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo));
      } else {
        const [h, v] = a.horizontal ? [a, b] : [b, a];
        if (v.at > h.lo + 1 && v.at < h.hi - 1 && h.at > v.lo + 1 && h.at < v.hi - 1) crossings++;
      }
    }
  }
  return { lines: routes.length, bends, length: Math.round(length), crossings, tight: Math.round(tight) };
}

/**
 * Propose a tidier route for every line on a page. `topology` says which lines join two
 * known nodes; for those a fresh route is tried and kept only when it is clearly better
 * (fewer bends, or shorter, with no detour and no new crossings). The rest are cleaned.
 */
export function tidyRoutes(shapes: DiagramShape[], topology: Topology): Tidied[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const obstacles = obstaclesFor(shapes);
  const lines = new Map(topology.lines.map((l) => [l.lineId, l]));
  const items: Tidied[] = [];
  for (const s of shapes) {
    const before = lineVertices(s);
    if (!before || before.length < 2) continue;
    items.push({ lineId: s.id, before, after: cleanPolyline(before), how: "cleaned" });
  }
  const crossingsOf = (k: number, pts: Point[]) =>
    routeStats([pts, ...items.filter((_, i) => i !== k).map((i) => i.after)]).crossings;
  items.forEach((it, k) => {
    const info = lines.get(it.lineId);
    const a = info && info.begin.kind === "node" && info.begin.nodeIds.length === 1 ? byId.get(info.begin.nodeIds[0]) : undefined;
    const b = info && info.end.kind === "node" && info.end.nodeIds.length === 1 ? byId.get(info.end.nodeIds[0]) : undefined;
    // A connector glued to shapes keeps its attachments: only lines without glue are routed again.
    const glued = !!(byId.get(it.lineId)?.connector?.begin.shapeId || byId.get(it.lineId)?.connector?.end.shapeId);
    if (!a || !b || a.id === b.id || glued) return;
    const cand = planRoute({ shape: a }, { shape: b }, "elbow", obstacles).points;
    const [now, next] = [routeStats([it.after]), routeStats([cand])];
    const better =
      (next.bends < now.bends || (next.bends === now.bends && next.length < now.length * 0.9)) &&
      next.length <= now.length * 1.1 &&
      crossingsOf(k, cand) <= crossingsOf(k, it.after);
    if (better) {
      it.after = cand;
      it.how = "rerouted";
    }
  });
  // Ends that touch a zone's border (not a node) may slide along it.
  const zoneRect = new Map(topology.zones.map((z) => [z.id, z]));
  const slide = items.map((it) => {
    const info = lines.get(it.lineId);
    const one = (end: "begin" | "end", pts: Point[]) => {
      const e = info?.[end];
      const z = e && e.kind === "zone" && e.zoneId ? zoneRect.get(e.zoneId) : undefined;
      if (!z || pts.length < 2) return undefined;
      const [p, q] = end === "begin" ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
      const vertical = same(p.x, q.x);
      const onTopBottom = same(p.y, z.y, 3) || same(p.y, z.y + z.height, 3);
      const onSides = same(p.x, z.x, 3) || same(p.x, z.x + z.width, 3);
      if (vertical && onTopBottom) return { lo: z.x + 6, hi: z.x + z.width - 6 };
      if (!vertical && onSides) return { lo: z.y + 6, hi: z.y + z.height - 6 };
      return undefined;
    };
    return [one("begin", it.after), one("end", it.after)];
  });
  const spread = spreadLanes(items.map((i) => i.after), { obstacles, slide });
  // moving pieces can leave a fraction-of-a-pixel step behind: square it off again
  return items.map((i, k) => ({ ...i, after: cleanPolyline(spread[k]) }));
}
