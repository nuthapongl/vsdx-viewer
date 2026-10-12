import type { DiagramPage } from "../model/types";
import { applyMatrix, placementMatrix } from "../model/transform";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of everything on the page plus the page rectangle itself. */
export function pageBounds(page: DiagramPage): Bounds {
  let minX = 0;
  let minY = 0;
  let maxX = page.width;
  let maxY = page.height;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const s of page.shapes) {
    if (s.type === "group") continue;
    const m = placementMatrix(s);
    for (const [x, y] of [
      [0, 0],
      [s.width, 0],
      [s.width, s.height],
      [0, s.height],
    ]) {
      add(...applyMatrix(m, x, y));
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
