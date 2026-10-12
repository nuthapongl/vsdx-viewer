import { describe, expect, it } from "vitest";
import { applyMatrix, placementMatrix, type Placement } from "../model/transform";
import { handlePoint, resizePlacement, rotatePlacement } from "./interaction";

const base: Placement = { x: 100, y: 50, width: 200, height: 100, rotation: 0, flipX: false };

/** Page position of a box-frame point. */
const page = (p: Placement, x: number, y: number) => applyMatrix(placementMatrix(p), x, y);

describe("resizePlacement", () => {
  it("keeps the opposite corner fixed (unrotated)", () => {
    const r = resizePlacement(base, "se", { x: 400, y: 250 });
    expect(r).toMatchObject({ x: 100, y: 50, width: 300, height: 200 });
    const r2 = resizePlacement(base, "nw", { x: 50, y: 0 });
    expect(r2.x + r2.width).toBeCloseTo(300);
    expect(r2.y + r2.height).toBeCloseTo(150);
    expect(r2.width).toBeCloseTo(250);
  });

  it("an edge handle changes one dimension only", () => {
    const r = resizePlacement(base, "e", { x: 350, y: 999 });
    expect(r.width).toBeCloseTo(250);
    expect(r.height).toBeCloseTo(100);
    expect(r.y).toBeCloseTo(50);
  });

  it.each([30, 90, -45])("keeps the anchor fixed on screen when rotated by %i°", (rotation) => {
    const s = { ...base, rotation };
    const anchor = page(s, 0, 0); // dragging "se" must not move the top-left corner
    const target = page(s, 260, 180);
    const r = resizePlacement(s, "se", { x: target[0], y: target[1] });
    expect(r.width).toBeCloseTo(260);
    expect(r.height).toBeCloseTo(180);
    const [ax, ay] = page(r, 0, 0);
    expect(ax).toBeCloseTo(anchor[0]);
    expect(ay).toBeCloseTo(anchor[1]);
    expect(r.rotation).toBe(rotation);
  });

  it("keeps the anchor fixed on a mirrored shape", () => {
    const s = { ...base, flipX: true, rotation: 20 };
    const anchor = page(s, 0, 0);
    const target = page(s, 250, 140);
    const r = resizePlacement(s, "se", { x: target[0], y: target[1] });
    const [ax, ay] = page(r, 0, 0);
    expect(ax).toBeCloseTo(anchor[0]);
    expect(ay).toBeCloseTo(anchor[1]);
    expect(r.flipX).toBe(true);
  });

  it("never collapses below the minimum size", () => {
    const r = resizePlacement(base, "e", { x: -500, y: 0 });
    expect(r.width).toBeGreaterThanOrEqual(4);
    expect(r.x).toBeCloseTo(100);
  });
});

describe("rotatePlacement", () => {
  const cx = 200;
  const cy = 100;
  it("0° is straight up, angles grow clockwise", () => {
    expect(rotatePlacement(base, { x: cx, y: cy - 80 }).rotation).toBeCloseTo(0);
    expect(rotatePlacement(base, { x: cx + 80, y: cy }).rotation).toBeCloseTo(90);
    expect(rotatePlacement(base, { x: cx, y: cy + 80 }).rotation).toBeCloseTo(180);
    expect(rotatePlacement(base, { x: cx - 80, y: cy }).rotation).toBeCloseTo(-90);
  });
  it("snaps and keeps the centre", () => {
    const r = rotatePlacement(base, { x: cx + 70, y: cy - 60 }, 15);
    expect(r.rotation % 15).toBeCloseTo(0);
    expect(r.x).toBe(base.x);
    expect(r.y).toBe(base.y);
  });
});

describe("handlePoint", () => {
  it("lies on the box edges", () => {
    expect(handlePoint("nw", 200, 100)).toEqual([0, 0]);
    expect(handlePoint("e", 200, 100)).toEqual([200, 50]);
    expect(handlePoint("s", 200, 100)).toEqual([100, 100]);
  });
});
