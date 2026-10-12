/**
 * Planning a connector's path between two ends (pure; no XML).
 *
 * An end is a shape and a side (a port), or a free point. The same plan feeds the
 * preview while dragging, a newly created connector, and the re-routing of
 * connectors when the shapes they are glued to change.
 */
import type { ConnectorRoute, DiagramShape, Point, Side } from "../model/types";
import { lineVertices } from "./connectors";
import {
  bestElbow,
  nearestPort,
  portOf,
  portsOf,
  rectOf,
  type Port,
  type Rect,
} from "./routing";

type Frame = Pick<DiagramShape, "x" | "y" | "width" | "height" | "rotation" | "flipX">;

export interface PlanEnd {
  /** Frame of the shape the end is attached to (at its position after any pending move). */
  shape?: Frame;
  /** Side to use. When absent for an attached end, the best side is chosen. */
  side?: Side;
  /** Position of a free end. */
  point?: Point;
}

export interface Plan {
  points: Point[];
  beginSide?: Side;
  endSide?: Side;
}

/**
 * Shapes a connector should route around. Frames that merely mark an area (no
 * fill, no text, no picture) are not obstacles - connectors run inside them -
 * nor are lines or labels.
 */
export function obstaclesFor(
  shapes: DiagramShape[],
  override: Map<string, Frame> = new Map(),
): Rect[] {
  const out: Rect[] = [];
  for (const s of shapes) {
    if (s.parentId || s.connector || lineVertices(s) || s.type === "text") continue;
    // An outline that only marks an area (no fill, text or picture) is not in the way.
    if (s.type !== "group" && !s.style.fill && !s.text && !s.image) continue;
    const f = override.get(s.id) ?? s;
    if (f.width <= 0 || f.height <= 0) continue;
    out.push(rectOf(f));
  }
  return out;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The ports of two shapes that are closest to each other (for a straight connector). */
function closestPorts(a: Frame, b: Frame, fixed: { a?: Side; b?: Side }): [Port, Port] {
  const pa = fixed.a ? [portOf(a, fixed.a)] : portsOf(a);
  const pb = fixed.b ? [portOf(b, fixed.b)] : portsOf(b);
  let best: [Port, Port] = [pa[0], pb[0]];
  for (const x of pa) for (const y of pb) if (dist(x.point, y.point) < dist(best[0].point, best[1].point)) best = [x, y];
  return best;
}

export function planRoute(
  a: PlanEnd,
  b: PlanEnd,
  style: ConnectorRoute["style"],
  obstacles: Rect[],
): Plan {
  if (style === "straight") {
    if (a.shape && b.shape) {
      const [pa, pb] = closestPorts(a.shape, b.shape, { a: a.side, b: b.side });
      return { points: [pa.point, pb.point], beginSide: pa.side, endSide: pb.side };
    }
    if (a.shape) {
      const pa = a.side ? portOf(a.shape, a.side) : nearestPort(a.shape, b.point!);
      return { points: [pa.point, b.point!], beginSide: pa.side };
    }
    if (b.shape) {
      const pb = b.side ? portOf(b.shape, b.side) : nearestPort(b.shape, a.point!);
      return { points: [a.point!, pb.point], endSide: pb.side };
    }
    return { points: [a.point!, b.point!] };
  }

  if (a.shape && b.shape) {
    const r = bestElbow(a.shape, b.shape, { obstacles }, { from: a.side, to: b.side });
    return { points: r.route.points, beginSide: r.from.side, endSide: r.to?.side };
  }
  if (a.shape) {
    const r = bestElbow(a.shape, b.point!, { obstacles }, { from: a.side });
    return { points: r.route.points, beginSide: r.from.side };
  }
  if (b.shape) {
    const r = bestElbow(b.shape, a.point!, { obstacles }, { from: b.side });
    return { points: [...r.route.points].reverse(), endSide: r.from.side };
  }
  // Two free ends: one bend, horizontal first.
  const [p, q] = [a.point!, b.point!];
  return {
    points: Math.abs(p.x - q.x) < 1e-6 || Math.abs(p.y - q.y) < 1e-6 ? [p, q] : [p, { x: q.x, y: p.y }, q],
  };
}

/** Current ends of an existing connector, ready for `planRoute`. */
export function endsOf(
  line: DiagramShape,
  frameOf: (id: string) => Frame | undefined,
): { a: PlanEnd; b: PlanEnd; style: ConnectorRoute["style"] } | undefined {
  const c = line.connector;
  if (!c) return undefined;
  const make = (end: typeof c.begin, side: Side | undefined): PlanEnd => {
    const shape = end.shapeId !== undefined ? frameOf(end.shapeId) : undefined;
    if (!shape) return { point: end.point };
    return { shape, side: side ?? nearestPort(shape, end.point).side };
  };
  return {
    a: make(c.begin, c.route?.beginSide),
    b: make(c.end, c.route?.endSide),
    style: c.route?.style ?? "straight",
  };
}

/** One end of a connector as the user describes it: a shape (and maybe a side), or a free point. */
export interface ConnectTarget {
  shapeId?: string;
  side?: Side;
  point?: Point;
}

const frameOfShape = (s: DiagramShape): Frame => ({
  x: s.x,
  y: s.y,
  width: s.width,
  height: s.height,
  rotation: s.rotation,
  flipX: s.flipX,
});

/**
 * Plan a connector between two targets on a page. `override` gives the frames
 * shapes will have after a pending change (a move in progress).
 */
export function planBetween(
  shapes: DiagramShape[],
  from: ConnectTarget,
  to: ConnectTarget,
  style: ConnectorRoute["style"],
  override: Map<string, Frame> = new Map(),
): Plan {
  const frame = (id?: string): Frame | undefined => {
    if (id === undefined) return undefined;
    const o = override.get(id);
    if (o) return o;
    const s = shapes.find((x) => x.id === id);
    return s ? frameOfShape(s) : undefined;
  };
  const end = (t: ConnectTarget): PlanEnd => {
    const shape = frame(t.shapeId);
    return shape ? { shape, side: t.side } : { point: t.point };
  };
  return planRoute(end(from), end(to), style, obstaclesFor(shapes, override));
}
