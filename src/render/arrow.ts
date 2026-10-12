/**
 * Arrow head dimensions.
 *
 * Visio sizes a head from the line weight, but never smaller than a 1 pt line
 * would give (thin lines don't get hairline arrows), and by a size index
 * (0 very small .. 6 colossal, 2 = medium). Calibrated against Visio's own
 * rendering of medium heads: about 9.4x a 1 pt line, wider than tall by 1.36 : 1.
 */
const PX_PER_PT = 96 / 72;
const MEDIUM_LENGTH_PER_PT = 9.4;
/** Relative to medium. */
const SIZE_FACTOR = [0.5, 0.75, 1, 1.4, 2, 2.8, 4];
const ASPECT = 0.73; // head width / head length

export interface ArrowHead {
  /** px, along the line. */
  length: number;
  /** px, across the line. */
  width: number;
}

export function arrowHead(strokeWidthPx: number, sizeIndex = 2): ArrowHead {
  const idx = Math.min(6, Math.max(0, Math.round(sizeIndex)));
  const weightPt = Math.max(strokeWidthPx / PX_PER_PT, 1);
  const length = weightPt * MEDIUM_LENGTH_PER_PT * SIZE_FACTOR[idx] * PX_PER_PT;
  return { length, width: length * ASPECT };
}
