/**
 * The magnet that pulls the end of a line onto the shapes it is dragged near: first onto a
 * port (the middle of a side), then onto the nearest point of a shape's outline.
 */
import type { DiagramShape, Point, Side } from "../model/types";
import { frameCorners, lineVertices } from "./connectors";
import { portsOf } from "./routing";

/** Screen px within which a port, or an outline, attracts. */
export const PORT_PULL = 14;
export const EDGE_PULL = 8;

export interface SnapHit {
  point: Point;
  shapeId: string;
  kind: "port" | "edge";
  /** The side of the port, for `kind` "port". */
  side?: Side;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The closest point to `p` on the segment a-b. */
function onSegment(p: Point, a: Point, b: Point): Point {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** The shapes a line end can attach to: top-level boxes (tiles, groups, frames), not lines or loose text. */
export function snapTargets(shapes: DiagramShape[], exclude: Set<string> = new Set()): DiagramShape[] {
  return shapes.filter(
    (s) =>
      !s.parentId &&
      !exclude.has(s.id) &&
      s.width > 0 &&
      s.height > 0 &&
      s.type !== "text" &&
      !s.connector &&
      !lineVertices(s),
  );
}

/**
 * Where the magnet would put an end dragged to `p`, or undefined when nothing is near enough.
 * `scale` is the zoom (pull distances are in screen px). Ports win over outlines; among
 * equals the nearer, then the smaller shape.
 */
export function snapPoint(shapes: DiagramShape[], p: Point, scale: number, exclude: Set<string> = new Set()): SnapHit | undefined {
  const portR = PORT_PULL / scale;
  const edgeR = EDGE_PULL / scale;
  let best: (SnapHit & { d: number; area: number }) | undefined;
  const consider = (hit: SnapHit, d: number, area: number) => {
    const rank = (x: { kind: string; d: number; area: number }) => [x.kind === "port" ? 0 : 1, x.d, x.area];
    const cand = { ...hit, d, area };
    if (!best) return void (best = cand);
    const [a, b] = [rank(cand), rank(best)];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(a[i] - b[i]) < (i === 1 ? 0.5 : 1e-9)) continue;
      if (a[i] < b[i]) best = cand;
      return;
    }
  };
  for (const s of snapTargets(shapes, exclude)) {
    const area = s.width * s.height;
    for (const port of portsOf(s)) {
      const d = dist(p, port.point);
      if (d <= portR) consider({ point: port.point, shapeId: s.id, kind: "port", side: port.side }, d, area);
    }
    const c = frameCorners(s);
    for (let i = 0; i < c.length; i++) {
      const q = onSegment(p, c[i], c[(i + 1) % c.length]);
      const d = dist(p, q);
      if (d <= edgeR) consider({ point: q, shapeId: s.id, kind: "edge" }, d, area);
    }
  }
  return best ? { point: best.point, shapeId: best.shapeId, kind: best.kind, side: best.side } : undefined;
}
