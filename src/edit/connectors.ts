/**
 * Keeping lines attached to the shapes they touch.
 *
 * Everything here works on the diagram model in page px, with no XML involved:
 * which shapes are lines, which line ends belong to a shape that is being
 * moved, and how the line's vertices follow.
 *
 * An end counts as attached if the file glues it to the shape (`Connects`), or
 * - because many files draw their lines as plain polylines with no glue at
 * all - if the end lies on the border of the shape.
 */
import {
  applyMatrix,
  invert,
  placementMatrix,
  type Matrix,
  type Placement,
} from "../model/transform";
import type { DiagramShape, Point } from "../model/types";

/** Distance (px) from a shape's border within which a line end counts as touching it. */
export const ATTACH_TOLERANCE = 5;

/** Segments shorter than this off an axis are still treated as horizontal / vertical. */
const AXIS_EPS = 0.5;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Vertices (page px) of a shape that is a line: a single open straight-segment
 * path that is stroked and not meant to be filled. Anything else (closed
 * shapes, curves, several paths) returns null and is left alone.
 */
export function lineVertices(shape: DiagramShape): Point[] | null {
  if (shape.type === "group" || shape.type === "image" || shape.type === "text") return null;
  if (shape.geometry.length !== 1) return null;
  const path = shape.geometry[0];
  if (!path.stroke || !shape.style.stroke) return null;
  if (path.fill && shape.style.fill && !shape.connector) return null;

  const pts: Point[] = [];
  for (const [i, c] of path.commands.entries()) {
    if (i === 0 ? c.op !== "M" : c.op !== "L") return null;
    if (c.op === "M" || c.op === "L") pts.push({ x: c.x, y: c.y });
  }
  if (pts.length < 2 || dist(pts[0], pts[pts.length - 1]) < 1) return null; // closed

  const m = placementMatrix(shape);
  const out = pts.map((p) => {
    const [x, y] = applyMatrix(m, p.x, p.y);
    return { x, y };
  });

  // A 1-D shape's first vertex must be its begin point, or "start"/"end" would be swapped.
  if (shape.connector) {
    if (dist(out[0], shape.connector.begin.point) > 2) return null;
    if (dist(out[out.length - 1], shape.connector.end.point) > 2) return null;
  }
  return out;
}

export function frameCorners(s: DiagramShape): Point[] {
  const m = placementMatrix(s);
  return [
    [0, 0],
    [s.width, 0],
    [s.width, s.height],
    [0, s.height],
  ].map(([x, y]) => {
    const [px, py] = applyMatrix(m, x, y);
    return { x: px, y: py };
  });
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Distance from `p` to the border of the shape's frame. */
export function borderDistance(s: DiagramShape, p: Point): number {
  const c = frameCorners(s);
  return Math.min(...c.map((a, i) => distToSegment(p, a, c[(i + 1) % 4])));
}

/** Is `p` inside the shape's frame (or on it)? Works for rotated frames. */
export function insideFrame(s: DiagramShape, p: Point, tol = 0): boolean {
  const inv = invert(placementMatrix(s));
  const [x, y] = applyMatrix(inv, p.x, p.y);
  return x >= -tol && y >= -tol && x <= s.width + tol && y <= s.height + tol;
}

/** Is `p` on the border of the shape's frame (within `tol`)? */
export function nearBorder(s: DiagramShape, p: Point, tol = ATTACH_TOLERANCE): boolean {
  const c = frameCorners(s);
  return c.some((a, i) => distToSegment(p, a, c[(i + 1) % 4]) <= tol);
}

export interface LineAttachment {
  lineId: string;
  /** The line's vertices before the edit, in page px. */
  vertices: Point[];
  /** Page position of the attached end(s) before the edit. */
  start?: Point;
  end?: Point;
}

/** Ids of `movedId` and everything nested in it (they are contiguous in paint order). */
export function subtreeIds(shapes: DiagramShape[], movedId: string): Set<string> {
  const ids = new Set([movedId]);
  const at = shapes.findIndex((s) => s.id === movedId);
  for (let i = at + 1; at >= 0 && i < shapes.length; i++) {
    const parent = shapes[i].parentId;
    if (!parent || !ids.has(parent)) break;
    ids.add(shapes[i].id);
  }
  return ids;
}

/**
 * Line ends that belong to the moved shape(s) or to anything inside them.
 * `editable` filters out lines that can't be written back (other pages, masters).
 */
export function findAttachments(
  shapes: DiagramShape[],
  moved: string | Iterable<string>,
  editable: (id: string) => boolean,
  tol = ATTACH_TOLERANCE,
): LineAttachment[] {
  const inside = new Set<string>();
  for (const id of typeof moved === "string" ? [moved] : moved) {
    for (const x of subtreeIds(shapes, id)) inside.add(x);
  }
  const anchors = shapes.filter(
    (s) =>
      inside.has(s.id) &&
      s.type !== "text" &&
      s.width > 0 &&
      s.height > 0 &&
      lineVertices(s) === null,
  );

  const out: LineAttachment[] = [];
  for (const line of shapes) {
    if (inside.has(line.id) || !editable(line.id)) continue;
    const vertices = lineVertices(line);
    if (!vertices) continue;

    const ends = [
      { p: vertices[0], glued: line.connector?.begin.shapeId },
      { p: vertices[vertices.length - 1], glued: line.connector?.end.shapeId },
    ].map(({ p, glued }) =>
      (glued !== undefined && inside.has(glued)) || anchors.some((a) => nearBorder(a, p, tol))
        ? p
        : undefined,
    );
    if (ends[0] || ends[1]) {
      out.push({ lineId: line.id, vertices, start: ends[0], end: ends[1] });
    }
  }
  return out;
}

/** Is every point inside the container's frame (within `tol` px)? Works for rotated containers. */
function allInside(container: DiagramShape, pts: Point[], tol = 1): boolean {
  const inv = invert(placementMatrix(container));
  return pts.every((p) => {
    const [x, y] = applyMatrix(inv, p.x, p.y);
    return x >= -tol && y >= -tol && x <= container.width + tol && y <= container.height + tol;
  });
}

/**
 * Does a shape belong inside the container? Its centre must be inside and at least
 * 40% of its area. Requiring the whole frame would miss labels, whose frames are
 * usually a little larger than their text and so poke out over the box's edge.
 * (Area is measured on the shape's bounding box in the container's own axes.)
 */
export function mostlyInside(container: DiagramShape, pts: Point[], minFraction = 0.4, tol = 1): boolean {
  const inv = invert(placementMatrix(container));
  const q = pts.map((p) => {
    const [x, y] = applyMatrix(inv, p.x, p.y);
    return { x, y };
  });
  const minX = Math.min(...q.map((p) => p.x));
  const maxX = Math.max(...q.map((p) => p.x));
  const minY = Math.min(...q.map((p) => p.y));
  const maxY = Math.max(...q.map((p) => p.y));
  const area = (maxX - minX) * (maxY - minY);
  if (area <= 1e-9) return allInside(container, pts, tol); // a flat shape: it must lie within

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  if (cx < -tol || cy < -tol || cx > container.width + tol || cy > container.height + tol) return false;

  const overlapX = Math.max(0, Math.min(maxX, container.width) - Math.max(minX, 0));
  const overlapY = Math.max(0, Math.min(maxY, container.height) - Math.max(minY, 0));
  return (overlapX * overlapY) / area >= minFraction;
}

export interface Contents {
  /** Shapes (and groups) lying entirely inside the container. */
  shapes: string[];
  /** Lines lying entirely inside it and attached to nothing outside it: they move as a whole. */
  lines: string[];
}

/**
 * What a box takes with it when it is moved: the siblings that lie (mostly)
 * inside its frame. A group counts as one item (its parts move with it), and
 * only shapes next to the container qualify, so a group is never torn apart.
 *
 * Lines inside the box move rigidly, unless one end is glued to something
 * outside it: such a line only follows the end that is inside (that is handled
 * by `findAttachments`).
 */
export function findContents(
  shapes: DiagramShape[],
  container: DiagramShape,
  editable: (id: string) => boolean,
): Contents {
  const none = { shapes: [], lines: [] };
  if (container.width <= 0 || container.height <= 0) return none;

  const siblings = shapes.filter(
    (s) => s.id !== container.id && s.parentId === container.parentId && editable(s.id),
  );
  const inside = new Set<string>(subtreeIds(shapes, container.id));
  const contained: DiagramShape[] = [];
  const lines: { shape: DiagramShape; pts: Point[] }[] = [];

  for (const s of siblings) {
    // A curved 1-D connector has no vertex list, but its end points still say where it is.
    const pts = lineVertices(s) ?? (s.connector ? [s.connector.begin.point, s.connector.end.point] : null);
    if (pts) {
      if (allInside(container, pts)) lines.push({ shape: s, pts });
    } else if ((s.width > 0 || s.height > 0) && mostlyInside(container, frameCorners(s))) {
      contained.push(s);
      for (const id of subtreeIds(shapes, s.id)) inside.add(id);
    }
  }

  const rigid = lines.filter(({ shape }) => {
    const glued = [shape.connector?.begin.shapeId, shape.connector?.end.shapeId];
    return glued.every((g) => g === undefined || inside.has(g));
  });
  return { shapes: contained.map((s) => s.id), lines: rigid.map((l) => l.shape.id) };
}

/**
 * Where an attached end goes when the shape changes from `start` to `next`: it
 * keeps its relative position in the shape (so it stays on the border when the
 * shape is resized, and turns with it when it is rotated).
 */
export function followAnchor(point: Point, start: Placement, next: Placement): Point {
  const m0: Matrix = placementMatrix(start);
  const [lx, ly] = applyMatrix(invert(m0), point.x, point.y);
  const sx = start.width > 0 ? next.width / start.width : 1;
  const sy = start.height > 0 ? next.height / start.height : 1;
  const [x, y] = applyMatrix(placementMatrix(next), lx * sx, ly * sy);
  return { x, y };
}

/**
 * Move the first and/or last vertex of a polyline, adjusting its neighbour so
 * that an orthogonal segment stays orthogonal (the segment stretches instead
 * of turning diagonal). A straight two-point line simply follows.
 */
export function followEndpoints(
  original: Point[],
  target: { start?: Point; end?: Point },
): Point[] {
  const pts = original.map((p) => ({ ...p }));
  const n = pts.length;

  /**
   * The first segment was horizontal (axis "y") or vertical (axis "x"), and its
   * outer end moved by `delta` across it. Shift vertex `k` the same way so the
   * segment stays straight; a following segment running the same way is shifted
   * too, while one at right angles just stretches. The far end is never moved.
   */
  const shiftChain = (k: number, dir: 1 | -1, axis: "x" | "y", delta: number) => {
    const far = dir > 0 ? n - 1 : 0;
    while (k !== far) {
      const next = k + dir;
      const continuesAlong = Math.abs(pts[k][axis] - pts[next][axis]) < AXIS_EPS;
      pts[k][axis] += delta;
      if (!continuesAlong) break;
      k = next;
    }
  };

  const move = (i: number, to: Point) => {
    const dir: 1 | -1 = i === 0 ? 1 : -1;
    const j = i + dir;
    if (n > 2) {
      const a = pts[i];
      const b = pts[j];
      const horizontal = Math.abs(a.y - b.y) < AXIS_EPS;
      const vertical = Math.abs(a.x - b.x) < AXIS_EPS;
      if (horizontal && !vertical) shiftChain(j, dir, "y", to.y - a.y);
      else if (vertical && !horizontal) shiftChain(j, dir, "x", to.x - a.x);
    }
    pts[i] = { ...to };
  };

  if (target.start) move(0, target.start);
  if (target.end) move(n - 1, target.end);

  // Drop zero-length segments the move may have created (keeping both ends).
  return pts.filter((p, i) => i === 0 || i === n - 1 || dist(p, pts[i - 1]) > 0.01);
}
