/** Pure maths for dragging selection handles; no DOM, so it can be unit-tested. */
import {
  applyMatrix,
  invert,
  placementMatrix,
  type Placement,
} from "../model/transform";
import { normalizeDegrees } from "../visio/coordinateTransform";

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export const MIN_SIZE = 4;

/** Handle positions in the shape's box frame (px, top-left origin). */
export function handlePoint(h: Handle, w: number, height: number): [number, number] {
  const x = h.includes("w") ? 0 : h.includes("e") ? w : w / 2;
  const y = h.includes("n") ? 0 : h.includes("s") ? height : height / 2;
  return [x, y];
}

export const CURSORS: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

/**
 * Placement after dragging `handle` to page point `pt`. The opposite edge (or
 * corner) stays where it is, also when the shape is rotated or mirrored,
 * because the pointer is mapped into the shape's own box frame first.
 */
export function resizePlacement(
  start: Placement,
  handle: Handle,
  pt: { x: number; y: number },
): Placement {
  const m = placementMatrix(start);
  const [px, py] = applyMatrix(invert(m), pt.x, pt.y);
  const { width: w, height: h } = start;

  let x0 = 0;
  let x1 = w;
  let y0 = 0;
  let y1 = h;
  if (handle.includes("w")) x0 = Math.min(px, w - MIN_SIZE);
  if (handle.includes("e")) x1 = Math.max(px, MIN_SIZE);
  if (handle.includes("n")) y0 = Math.min(py, h - MIN_SIZE);
  if (handle.includes("s")) y1 = Math.max(py, MIN_SIZE);

  const [cx, cy] = applyMatrix(m, (x0 + x1) / 2, (y0 + y1) / 2);
  const nw = x1 - x0;
  const nh = y1 - y0;
  return { ...start, x: cx - nw / 2, y: cy - nh / 2, width: nw, height: nh };
}

/** Placement after dragging the rotation handle to `pt`; 0° = pointer straight above the centre. */
export function rotatePlacement(
  start: Placement,
  pt: { x: number; y: number },
  snapDegrees?: number,
): Placement {
  const cx = start.x + start.width / 2;
  const cy = start.y + start.height / 2;
  let deg = (Math.atan2(pt.x - cx, -(pt.y - cy)) * 180) / Math.PI;
  if (snapDegrees) deg = Math.round(deg / snapDegrees) * snapDegrees;
  return { ...start, rotation: normalizeDegrees(deg) };
}
