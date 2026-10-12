/**
 * Geometry helpers on the model side: affine matrices and the placement
 * (frame + rotation + flip) representation used by DiagramShape.
 */

/** Affine matrix [a b c d e f], same layout as SVG `matrix(a b c d e f)`. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m1 ∘ m2`: apply m2 first, then m1. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
}

/** Matrix of a placed shape: box frame (px, top-left) -> page. Used by the renderer. */
export function placementMatrix(p: Placement): Matrix {
  const rad = (p.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const fx = p.flipX ? -1 : 1;
  // translate(c) · rotate · scale(fx,1) · translate(-w/2,-h/2)
  const a = cos * fx;
  const b = sin * fx;
  const c = -sin;
  const d = cos;
  const cx = p.x + p.width / 2;
  const cy = p.y + p.height / 2;
  const e = cx - (a * (p.width / 2) + c * (p.height / 2));
  const f = cy - (b * (p.width / 2) + d * (p.height / 2));
  return [a, b, c, d, e, f];
}
