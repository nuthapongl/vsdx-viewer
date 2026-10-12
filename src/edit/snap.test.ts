import { describe, expect, it } from "vitest";
import type { DiagramShape } from "../model/types";
import { snapPoint } from "./snap";

const box = (id: string, x: number, y: number, w: number, h: number, extra: Partial<DiagramShape> = {}): DiagramShape =>
  ({ id, type: "rectangle", x, y, width: w, height: h, rotation: 0, flipX: false, geometry: [], style: { strokeWidth: 1, fill: "#fff", stroke: "#000" }, text: "n", ...extra }) as DiagramShape;

const shapes = [box("a", 100, 100, 100, 60), box("zone", 0, 0, 400, 300, { text: undefined, style: { strokeWidth: 1, stroke: "#f00" } })];

describe("snapPoint (the magnet)", () => {
  it("pulls onto the middle of a side when near it", () => {
    const hit = snapPoint(shapes, { x: 152, y: 96 }, 1)!;
    expect(hit).toMatchObject({ shapeId: "a", kind: "port", side: "N", point: { x: 150, y: 100 } });
  });

  it("pulls onto the outline when near it, but not a port", () => {
    const hit = snapPoint(shapes, { x: 120, y: 103 }, 1)!;
    expect(hit).toMatchObject({ shapeId: "a", kind: "edge" });
    expect(hit.point).toEqual({ x: 120, y: 100 });
  });

  it("does nothing when far from every shape, or well inside one", () => {
    expect(snapPoint(shapes, { x: 250, y: 200 }, 1)).toBeUndefined();
    expect(snapPoint(shapes, { x: 150, y: 130 }, 1)).toBeUndefined();
  });

  it("the pull is in screen px: it shrinks in page units as you zoom in", () => {
    expect(snapPoint(shapes, { x: 152, y: 96 }, 4)).toBeUndefined(); // 14 / 4 = 3.5 px of page, and it is 4.5 away
    expect(snapPoint(shapes, { x: 151, y: 97.5 }, 4)?.kind).toBe("port");
  });

  it("works on a zone's border too, and prefers the smaller shape when both are near", () => {
    const hit = snapPoint(shapes, { x: 3, y: 100 }, 1)!;
    expect(hit).toMatchObject({ shapeId: "zone", kind: "edge" });
    const near = [box("big", 0, 0, 200, 200), box("small", 150, 150, 50, 50)];
    expect(snapPoint(near, { x: 199, y: 175 }, 1)!.shapeId).toBe("small"); // both outlines within reach: the smaller wins
  });

  it("ignores excluded shapes, lines and loose text", () => {
    expect(snapPoint(shapes, { x: 152, y: 96 }, 1, new Set(["a"]))).toBeUndefined();
    const line = box("l", 100, 100, 100, 60, {
      geometry: [{ fill: false, stroke: true, commands: [{ op: "M", x: 0, y: 0 }, { op: "L", x: 100, y: 0 }] }],
    });
    const text = box("t", 100, 100, 100, 60, { type: "text" });
    expect(snapPoint([line, text], { x: 152, y: 96 }, 1)).toBeUndefined();
  });
});
