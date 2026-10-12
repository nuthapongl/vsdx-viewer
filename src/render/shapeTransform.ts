import type { DiagramShape } from "../model/types";

/** Number formatted for SVG attributes: at most 3 decimals. */
export const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** SVG `transform` taking a shape's box frame (px, top-left origin) to the page. */
export function shapeTransform(s: DiagramShape): string {
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  return (
    `translate(${n(cx)} ${n(cy)}) rotate(${n(s.rotation)}) ` +
    `scale(${s.flipX ? -1 : 1} 1) translate(${n(-s.width / 2)} ${n(-s.height / 2)})`
  );
}

