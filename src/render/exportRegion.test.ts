import { describe, expect, it } from "vitest";
import type { DiagramShape } from "../model/types";
import { fitScale, MAX_SIDE, regionBetween, shapeBounds } from "./exportRegion";

const box = (over: Partial<DiagramShape>): DiagramShape =>
  ({ id: "1", type: "shape", x: 100, y: 50, width: 80, height: 40, rotation: 0, flipX: false, flipY: false, geometry: [], style: {}, ...over }) as DiagramShape;

describe("export region", () => {
  it("builds the box whichever corner is dragged first", () => {
    expect(regionBetween({ x: 50, y: 40 }, { x: 10, y: 90 })).toEqual({ x: 10, y: 40, width: 40, height: 50 });
  });

  it("surrounds a shape, with padding", () => {
    const b = shapeBounds(box({}), 10);
    expect(b).toEqual({ x: 90, y: 40, width: 100, height: 60 });
  });

  it("keeps the asked scale for a small area and shrinks it for a huge one", () => {
    expect(fitScale({ x: 0, y: 0, width: 400, height: 300 }, 2)).toBe(2);
    const big = fitScale({ x: 0, y: 0, width: 6000, height: 4000 }, 4);
    expect(big).toBeLessThan(4);
    expect(6000 * big).toBeLessThanOrEqual(MAX_SIDE);
  });
});
