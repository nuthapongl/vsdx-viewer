import { describe, expect, it } from "vitest";
import type { Point } from "../model/types";
import { bestElbow, nearestPort, portsOf, rectOf, routeElbow, routeStraight, simplify, type Rect } from "./routing";

const P = (x: number, y: number): Point => ({ x, y });
const frame = (x: number, y: number, w: number, h: number, rotation = 0, flipX = false) => ({ x, y, width: w, height: h, rotation, flipX });

const orthogonal = (pts: Point[]) =>
  pts.slice(1).every((p, i) => Math.min(Math.abs(p.x - pts[i].x), Math.abs(p.y - pts[i].y)) < 1e-6);

/** Does any segment of the path cross the inside of the rectangle? */
function crosses(pts: Point[], r: Rect): boolean {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (x1 > r.x + 1e-6 && x0 < r.x + r.width - 1e-6 && y1 > r.y + 1e-6 && y0 < r.y + r.height - 1e-6) return true;
  }
  return false;
}
const dirOf = (a: Point, b: Point) => ({ x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) });

describe("ports", () => {
  it("are the middles of the four sides, facing outwards", () => {
    const p = portsOf(frame(100, 50, 200, 100));
    const by = Object.fromEntries(p.map((q) => [q.side, q.point]));
    expect(by.N).toEqual(P(200, 50));
    expect(by.E).toEqual(P(300, 100));
    expect(by.S).toEqual(P(200, 150));
    expect(by.W).toEqual(P(100, 100));
  });

  it("follow a rotated shape: the side that faces east after a 90° turn is the old north side", () => {
    const p = portsOf(frame(100, 50, 200, 100, 90)); // turns clockwise about (200, 100)
    const east = p.find((q) => q.side === "E")!;
    expect(east.point.x).toBeCloseTo(250); // 200 + half the height
    expect(east.point.y).toBeCloseTo(100);
    expect(p.map((q) => q.side).sort()).toEqual(["E", "N", "S", "W"]);
  });

  it("follow a mirrored shape", () => {
    const p = portsOf(frame(0, 0, 100, 40, 0, true));
    expect(p.map((q) => q.side).sort()).toEqual(["E", "N", "S", "W"]);
    const w = p.find((q) => q.side === "W")!;
    expect(w.point.x).toBeCloseTo(0);
  });

  it("nearestPort picks the closest side", () => {
    expect(nearestPort(frame(0, 0, 100, 100), P(95, 40)).side).toBe("E");
    expect(nearestPort(frame(0, 0, 100, 100), P(30, 5)).side).toBe("N");
  });

  it("rectOf bounds a rotated frame", () => {
    const r = rectOf(frame(100, 50, 200, 100, 90));
    expect(r.width).toBeCloseTo(100);
    expect(r.height).toBeCloseTo(200);
  });
});

describe("routeElbow", () => {
  it("is a straight line when the ports face each other on one level", () => {
    const r = routeElbow({ point: P(100, 100), side: "E" }, { point: P(300, 100), side: "W" }, { obstacles: [] });
    expect(r.points).toEqual([P(100, 100), P(300, 100)]);
    expect(r.bends).toBe(0);
  });

  it("makes a Z with two bends between facing ports at different heights", () => {
    const r = routeElbow({ point: P(100, 100), side: "E" }, { point: P(300, 200), side: "W" }, { obstacles: [] });
    expect(orthogonal(r.points)).toBe(true);
    expect(r.bends).toBe(2);
    expect(r.points[0]).toEqual(P(100, 100));
    expect(r.points.at(-1)).toEqual(P(300, 200));
    expect(dirOf(r.points[0], r.points[1])).toEqual({ x: 1, y: 0 }); // leaves east
    expect(dirOf(r.points.at(-2)!, r.points.at(-1)!)).toEqual({ x: 1, y: 0 }); // enters going east into a west port
  });

  it("makes an L with one bend for perpendicular ports", () => {
    const r = routeElbow({ point: P(100, 100), side: "E" }, { point: P(300, 250), side: "N" }, { obstacles: [] });
    expect(r.bends).toBe(1);
    expect(r.points).toEqual([P(100, 100), P(300, 100), P(300, 250)]);
  });

  it("goes around an obstacle that is in the way", () => {
    const wall: Rect = { x: 180, y: 40, width: 40, height: 120 };
    const r = routeElbow({ point: P(100, 100), side: "E" }, { point: P(300, 100), side: "W" }, { obstacles: [wall] });
    expect(orthogonal(r.points)).toBe(true);
    expect(crosses(r.points, wall)).toBe(false);
    expect(r.points[0]).toEqual(P(100, 100));
    expect(r.points.at(-1)).toEqual(P(300, 100));
    expect(r.bends).toBeGreaterThanOrEqual(2);
  });

  it("keeps clear of obstacles by the margin", () => {
    const wall: Rect = { x: 180, y: 40, width: 40, height: 120 };
    const r = routeElbow({ point: P(100, 100), side: "E" }, { point: P(300, 100), side: "W" }, { obstacles: [wall], margin: 10 });
    const inflated = { x: wall.x - 10, y: wall.y - 10, width: wall.width + 20, height: wall.height + 20 };
    expect(crosses(r.points, inflated)).toBe(false);
  });

  it("prefers fewer bends over a slightly shorter, twistier path", () => {
    const r = routeElbow({ point: P(0, 0), side: "E" }, { point: P(400, 300), side: "W" }, { obstacles: [] });
    expect(r.bends).toBe(2);
  });

  it("leaves a port in its own direction, even when the target is behind it", () => {
    // exit east but the target is to the west: it has to swing out first, never back through the shape
    const own: Rect = { x: 0, y: 60, width: 100, height: 80 };
    const r = routeElbow({ point: P(100, 100), side: "E" }, { point: P(-200, 100), side: "E" }, { obstacles: [own] });
    expect(orthogonal(r.points)).toBe(true);
    expect(dirOf(r.points[0], r.points[1])).toEqual({ x: 1, y: 0 });
    expect(crosses(r.points, own)).toBe(false);
  });

  it("enters the target through its side", () => {
    const target: Rect = { x: 250, y: 150, width: 100, height: 100 };
    const r = routeElbow({ point: P(100, 100), side: "E" }, { point: P(300, 250), side: "S" }, { obstacles: [target] });
    expect(crosses(r.points, target)).toBe(false);
    expect(dirOf(r.points.at(-2)!, r.points.at(-1)!)).toEqual({ x: 0, y: -1 }); // going up into the south port
  });

  it("a free end has no stub and accepts any approach", () => {
    const r = routeElbow({ point: P(100, 100), side: "E" }, { point: P(300, 250) }, { obstacles: [] });
    expect(r.points.at(-1)).toEqual(P(300, 250));
    expect(orthogonal(r.points)).toBe(true);
    expect(r.bends).toBe(1);
  });

  it("falls back to a tidy elbow when the way is walled in", () => {
    const ring: Rect[] = [
      { x: 150, y: -300, width: 20, height: 700 },
      { x: 150, y: -300, width: 400, height: 20 },
    ];
    const r = routeElbow({ point: P(100, 100), side: "E" }, { point: P(300, 100), side: "W" }, { obstacles: ring, margin: 0 });
    expect(orthogonal(r.points)).toBe(true);
    expect(r.points[0]).toEqual(P(100, 100));
    expect(r.points.at(-1)).toEqual(P(300, 100));
  });

  it("ignores obstacles far from the connector and ones that swallow an endpoint", () => {
    const far: Rect = { x: 5000, y: 5000, width: 50, height: 50 };
    const swallow: Rect = { x: 90, y: 80, width: 60, height: 40 }; // contains the first stub point
    const r = routeElbow({ point: P(100, 100), side: "E" }, { point: P(300, 100), side: "W" }, { obstacles: [far, swallow] });
    expect(r.points).toEqual([P(100, 100), P(300, 100)]);
  });

  it("is fast with many obstacles", () => {
    const obstacles: Rect[] = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 8; j++) obstacles.push({ x: 150 + i * 90, y: 20 + j * 70, width: 50, height: 40 });
    const t = performance.now();
    const r = routeElbow({ point: P(100, 50), side: "E" }, { point: P(1300, 560), side: "W" }, { obstacles });
    expect(performance.now() - t).toBeLessThan(500);
    expect(orthogonal(r.points)).toBe(true);
    for (const o of obstacles) expect(crosses(r.points, o)).toBe(false);
  });
});

describe("routeStraight / simplify", () => {
  it("straight is just the two ends", () => {
    expect(routeStraight({ point: P(0, 0) }, { point: P(10, 5) }).points).toEqual([P(0, 0), P(10, 5)]);
  });
  it("simplify drops duplicates and mid-run points but keeps real corners", () => {
    expect(simplify([P(0, 0), P(0, 0), P(5, 0), P(10, 0), P(10, 10), P(10, 20)])).toEqual([P(0, 0), P(10, 0), P(10, 20)]);
  });
});

describe("bestElbow", () => {
  it("chooses facing sides, and a straight line, for shapes side by side on one level", () => {
    const a = frame(0, 0, 100, 60);
    const b = frame(300, 0, 100, 60);
    const r = bestElbow(a, b, { obstacles: [rectOf(a), rectOf(b)] });
    expect(r.from.side).toBe("E");
    expect(r.to!.side).toBe("W");
    expect(r.route.bends).toBe(0);
  });

  it("uses a single bend when a perpendicular pair of sides allows it", () => {
    // B is lower and to the right: east out of A, then down into B's top beats a Z with two bends.
    const a = frame(0, 0, 100, 60);
    const b = frame(300, 100, 100, 60);
    const r = bestElbow(a, b, { obstacles: [rectOf(a), rectOf(b)] });
    expect(r.route.bends).toBe(1);
    expect(r.from.side).toBe("E");
    expect(r.to!.side).toBe("N");
  });

  it("chooses vertical sides for shapes stacked", () => {
    const a = frame(0, 0, 100, 60);
    const b = frame(10, 300, 100, 60);
    const r = bestElbow(a, b, { obstacles: [rectOf(a), rectOf(b)] });
    expect(r.from.side).toBe("S");
    expect(r.to!.side).toBe("N");
  });

  it("honours sides that are fixed", () => {
    const a = frame(0, 0, 100, 60);
    const b = frame(300, 100, 100, 60);
    const r = bestElbow(a, b, { obstacles: [rectOf(a), rectOf(b)] }, { from: "N", to: "N" });
    expect(r.from.side).toBe("N");
    expect(r.to!.side).toBe("N");
  });

  it("routes to a free point", () => {
    const a = frame(0, 0, 100, 60);
    const r = bestElbow(a, P(300, 30), { obstacles: [rectOf(a)] });
    expect(r.to).toBeUndefined();
    expect(r.route.points.at(-1)).toEqual(P(300, 30));
    expect(r.from.side).toBe("E");
  });
});
