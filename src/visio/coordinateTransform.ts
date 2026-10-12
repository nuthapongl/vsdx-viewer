/**
 * Coordinate handling.
 *
 * Visio: inches, origin bottom-left of the page, Y up, angles counter-clockwise
 * in radians. Every shape has its own local frame (origin bottom-left of the
 * shape's box) and sits in its parent's local frame (the page for top-level
 * shapes) via PinX/PinY/LocPinX/LocPinY/Angle/Flip.
 *
 * Model: CSS px, origin top-left, Y down, degrees clockwise.
 */

import { applyMatrix, invert, multiply, type Matrix, type Placement } from "../model/transform";

export { applyMatrix, multiply, type Matrix };

export const PX_PER_INCH = 96;

export interface XForm {
  pinX: number;
  pinY: number;
  locPinX: number;
  locPinY: number;
  /** radians, counter-clockwise */
  angle: number;
  flipX: boolean;
  flipY: boolean;
}

/**
 * Matrix taking a shape's local coordinates (Visio units) to its parent's.
 * Flips mirror around the pin, then the shape rotates around the pin.
 */
export function localToParent(xf: XForm): Matrix {
  const cos = Math.cos(xf.angle);
  const sin = Math.sin(xf.angle);
  const fx = xf.flipX ? -1 : 1;
  const fy = xf.flipY ? -1 : 1;
  // p = pin + R · F · (l - locPin)
  const a = cos * fx;
  const b = sin * fx;
  const c = -sin * fy;
  const d = cos * fy;
  const e = xf.pinX - (a * xf.locPinX + c * xf.locPinY);
  const f = xf.pinY - (b * xf.locPinX + d * xf.locPinY);
  return [a, b, c, d, e, f];
}

/** Page (Visio inches, Y up) -> screen (px, Y down). */
export function pageToScreen(pageHeightInches: number): Matrix {
  return [PX_PER_INCH, 0, 0, -PX_PER_INCH, 0, pageHeightInches * PX_PER_INCH];
}

/** Visio-unit local frame (Y up) -> px local frame (top-left origin, Y down). */
export function localToBox(heightInches: number): Matrix {
  return pageToScreen(heightInches);
}

/**
 * Turn the full local->page-screen matrix of a shape into the model's
 * frame + rotation + flip representation.
 *
 * `toScreen` maps the shape's Visio-unit local frame to page px (Y down).
 * Visio has no scaling in these transforms, so the linear part is a rotation
 * possibly combined with one mirror. A vertical flip is expressed as
 * flipX + 180° which is visually identical.
 */
export function decompose(
  toScreen: Matrix,
  widthInches: number,
  heightInches: number,
): Placement {
  const w = widthInches * PX_PER_INCH;
  const h = heightInches * PX_PER_INCH;
  // Box frame (px, top-left, Y down) -> page screen.
  const box = multiply(toScreen, invert(localToBox(heightInches)));
  const [cx, cy] = applyMatrix(box, w / 2, h / 2);
  const det = box[0] * box[3] - box[1] * box[2];
  const flipX = det < 0;
  const angle = flipX ? Math.atan2(-box[1], -box[0]) : Math.atan2(box[1], box[0]);
  return {
    x: cx - w / 2,
    y: cy - h / 2,
    width: w,
    height: h,
    rotation: normalizeDegrees((angle * 180) / Math.PI),
    flipX,
  };
}

export function normalizeDegrees(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  // avoid -0 and float dust
  return Math.abs(d) < 1e-9 ? 0 : d;
}
