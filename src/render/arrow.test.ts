import { describe, expect, it } from "vitest";
import { arrowHead } from "./arrow";

describe("arrowHead", () => {
  it("a medium head on a hairline is about 12.5 px long, not hairline-sized", () => {
    const h = arrowHead(0.75, 2);
    expect(h.length).toBeCloseTo(12.53, 1);
    expect(h.width).toBeCloseTo(h.length * 0.73, 5);
  });
  it("grows with the line weight once it is thicker than 1 pt, and with the size index", () => {
    expect(arrowHead(4, 2).length).toBeGreaterThan(arrowHead(0.75, 2).length * 2);
    expect(arrowHead(1, 4).length).toBeGreaterThan(arrowHead(1, 2).length);
    expect(arrowHead(1, 0).length).toBeLessThan(arrowHead(1, 2).length);
  });
  it("clamps the size index", () => {
    expect(arrowHead(1, 99).length).toBe(arrowHead(1, 6).length);
    expect(arrowHead(1, -3).length).toBe(arrowHead(1, 0).length);
  });
});
