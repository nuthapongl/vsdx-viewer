import { frameCorners, lineVertices } from "../edit/connectors";
import type { DiagramShape, Point } from "../model/types";
import type { Bounds } from "./bounds";

/** Longest side, and total pixels, of an exported image: past this canvases fail or run out of memory. */
export const MAX_SIDE = 8192;
export const MAX_PIXELS = 50_000_000;

/** The rectangle spanned by two corner points, in whichever order they were given. */
export function regionBetween(a: Point, b: Point): Bounds {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Axis-aligned box around a shape (its outline, or its path for a line), grown by `pad`. */
export function shapeBounds(shape: DiagramShape, pad = 0): Bounds {
  const pts = lineVertices(shape) ?? frameCorners(shape);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
}

/** The wanted scale, reduced when the image would be too large. */
export function fitScale(region: Bounds, wanted: number): number {
  const bySide = MAX_SIDE / Math.max(region.width, region.height, 1);
  const byArea = Math.sqrt(MAX_PIXELS / Math.max(region.width * region.height, 1));
  return Math.min(wanted, bySide, byArea);
}
