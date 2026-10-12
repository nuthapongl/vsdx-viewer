import { describe, expect, it } from "vitest";
import type { Point } from "../model/types";
import { cleanPolyline, routeStats, spreadLanes } from "./tidy";

const P = (x: number, y: number): Point => ({ x, y });
const square = (pts: Point[]) => pts.slice(1).every((p, i) => Math.abs(p.x - pts[i].x) < 0.6 || Math.abs(p.y - pts[i].y) < 0.6);

describe("cleanPolyline", () => {
  it("snaps a nearly straight piece and drops points on a straight run", () => {
    const r = cleanPolyline([P(0, 0), P(50, 2), P(100, 2), P(100, 80)]);
    expect(r).toEqual([P(0, 0), P(100, 0), P(100, 80)]);
  });

  it("removes a tiny jog between two parallel runs but keeps the ends where they are", () => {
    const r = cleanPolyline([P(0, 0), P(40, 0), P(40, 6), P(90, 6), P(90, 80), P(140, 80)]);
    expect(r[0]).toEqual(P(0, 0));
    expect(r[r.length - 1]).toEqual(P(140, 80));
    expect(r.length).toBeLessThan(6);
    expect(square(r)).toBe(true);
  });
});

describe("spreadLanes", () => {
  // two lines that share a horizontal trunk, with their own first and last pieces
  const a = [P(0, 0), P(0, 100), P(200, 100), P(200, 200)];
  const b = [P(20, 0), P(20, 100), P(180, 100), P(180, 200)];
  const c = [P(40, 0), P(40, 103), P(160, 103), P(160, 200)]; // 3px away: too close

  it("moves lines that run on top of one another, or too close, into separate lanes", () => {
    const before = routeStats([a, b, c]);
    expect(before.tight).toBeGreaterThan(0);
    const r = spreadLanes([a, b, c]);
    const after = routeStats(r);
    expect(after.tight).toBe(0);
    for (const line of r) expect(square(line)).toBe(true);
    // the first piece of each line (where it attaches) did not move
    expect(r[0][0]).toEqual(P(0, 0));
    expect(r[1][0]).toEqual(P(20, 0));
    expect(r[2][r[2].length - 1]).toEqual(P(160, 200));
  });

  it("keeps a line out of a shape when moving it", () => {
    // the only free lane for b would be inside the box right below the trunk
    const box = { x: 80, y: 104, width: 40, height: 40 };
    const lone = spreadLanes([a, [P(20, 0), P(20, 100), P(180, 100), P(180, 200)]], { obstacles: [box] });
    for (const line of lone) expect(square(line)).toBe(true);
    const moved = lone[1].some((p) => p.y > 100 && p.y < 150 && p.x > 80 && p.x < 120);
    expect(moved).toBe(false);
  });

  it("leaves lines that are far apart alone", () => {
    const far = [P(0, 300), P(0, 400), P(200, 400), P(200, 500)];
    expect(spreadLanes([a, far])).toEqual([a, far]);
  });
});
