import { describe, expect, it } from "vitest";
import type { DiagramShape } from "../model/types";
import {
  ATTACH_TOLERANCE,
  findAttachments,
  findContents,
  followAnchor,
  followEndpoints,
  lineVertices,
  nearBorder,
} from "./connectors";

const P = (x: number, y: number) => ({ x, y });

function box(id: string, x: number, y: number, w: number, h: number, extra: Partial<DiagramShape> = {}): DiagramShape {
  return {
    id,
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    rotation: 0,
    flipX: false,
    style: { fill: "#fff", stroke: "#000", strokeWidth: 1 },
    geometry: [
      {
        fill: true,
        stroke: true,
        commands: [
          { op: "M", x: 0, y: 0 },
          { op: "L", x: w, y: 0 },
          { op: "L", x: w, y: h },
          { op: "L", x: 0, y: h },
          { op: "L", x: 0, y: 0 },
          { op: "Z" },
        ],
      },
    ],
    ...extra,
  };
}

/** An open polyline through page points (page-space frame at the origin). */
function line(id: string, pts: { x: number; y: number }[], extra: Partial<DiagramShape> = {}): DiagramShape {
  return {
    id,
    type: "unknown",
    x: 0,
    y: 0,
    width: 1000,
    height: 1000,
    rotation: 0,
    flipX: false,
    style: { stroke: "#000", strokeWidth: 1 },
    geometry: [
      {
        fill: false,
        stroke: true,
        commands: pts.map((p, i) => ({ op: i === 0 ? "M" : "L", x: p.x, y: p.y }) as const),
      },
    ],
    ...extra,
  };
}

describe("followEndpoints", () => {
  it("a straight two-point line just follows", () => {
    expect(followEndpoints([P(0, 0), P(100, 0)], { start: P(10, 20) })).toEqual([P(10, 20), P(100, 0)]);
    expect(followEndpoints([P(0, 0), P(100, 0)], { end: P(90, 40) })).toEqual([P(0, 0), P(90, 40)]);
  });

  it("moving the end of a horizontal first segment up shifts its neighbour (L shape)", () => {
    // start (0,0) -> (100,0) -> (100,80); move start by (-20, +30)
    const r = followEndpoints([P(0, 0), P(100, 0), P(100, 80)], { start: P(-20, 30) });
    expect(r).toEqual([P(-20, 30), P(100, 30), P(100, 80)]);
  });

  it("moving along the first segment just stretches it", () => {
    const r = followEndpoints([P(0, 0), P(100, 0), P(100, 80)], { start: P(-50, 0) });
    expect(r).toEqual([P(-50, 0), P(100, 0), P(100, 80)]);
  });

  it("vertical first segment: neighbour follows in x, next segment stretches", () => {
    const r = followEndpoints([P(0, 0), P(0, 50), P(80, 50), P(80, 100)], { start: P(30, 10) });
    expect(r).toEqual([P(30, 10), P(30, 50), P(80, 50), P(80, 100)]);
  });

  it("works from the far end, mirrored", () => {
    const r = followEndpoints([P(0, 0), P(0, 50), P(80, 50), P(80, 100)], { end: P(95, 120) });
    // last segment vertical (x same): its neighbour follows in x; the next one stretches
    expect(r).toEqual([P(0, 0), P(0, 50), P(95, 50), P(95, 120)]);
  });

  it("a collinear run of vertices moves together, but never the far end", () => {
    const r = followEndpoints([P(0, 0), P(40, 0), P(80, 0), P(80, 60)], { start: P(0, 10) });
    expect(r).toEqual([P(0, 10), P(40, 10), P(80, 10), P(80, 60)]);
    // two-segment line moved so the shifted neighbour would be the far end: it stays put
    const r2 = followEndpoints([P(0, 0), P(50, 0), P(100, 0)], { start: P(0, 20) });
    expect(r2[2]).toEqual(P(100, 0));
    expect(r2[0]).toEqual(P(0, 20));
  });

  it("a diagonal first segment moves only the endpoint", () => {
    expect(followEndpoints([P(0, 0), P(50, 50), P(100, 50)], { start: P(10, 0) })).toEqual([
      P(10, 0),
      P(50, 50),
      P(100, 50),
    ]);
  });

  it("moves both ends, e.g. a line that starts and ends on the same shape", () => {
    const r = followEndpoints([P(0, 0), P(0, 50), P(100, 50), P(100, 0)], { start: P(10, 0), end: P(110, 0) });
    expect(r).toEqual([P(10, 0), P(10, 50), P(110, 50), P(110, 0)]);
  });

  it("removes segments that collapse to nothing", () => {
    const r = followEndpoints([P(0, 0), P(0, 50), P(40, 50), P(40, 100)], { start: P(40, 0) });
    expect(r).toEqual([P(40, 0), P(40, 50), P(40, 100)]);
  });
});

describe("lineVertices", () => {
  it("returns page-space vertices of an open straight path", () => {
    const l = line("l", [P(10, 10), P(10, 60), P(70, 60)]);
    expect(lineVertices(l)).toEqual([P(10, 10), P(10, 60), P(70, 60)]);
  });
  it("rejects closed shapes, curves, filled shapes and groups", () => {
    expect(lineVertices(box("b", 0, 0, 10, 10))).toBeNull();
    const curved = line("c", [P(0, 0), P(10, 10)]);
    curved.geometry[0].commands.push({ op: "Q", x1: 1, y1: 1, x: 5, y: 5 });
    expect(lineVertices(curved)).toBeNull();
    const filled = line("f", [P(0, 0), P(10, 10), P(20, 0)]);
    filled.geometry[0].fill = true;
    filled.style.fill = "#f00";
    expect(lineVertices(filled)).toBeNull();
    expect(lineVertices(line("g", [P(0, 0), P(1, 1)], { type: "group" }))).toBeNull();
    expect(lineVertices(line("loop", [P(0, 0), P(10, 0), P(10, 10), P(0, 0)]))).toBeNull();
  });
});

describe("nearBorder / findAttachments", () => {
  const tile = box("tile", 100, 100, 200, 100);
  it("uses the border, within the tolerance", () => {
    expect(nearBorder(tile, P(100 + 50, 200 + ATTACH_TOLERANCE - 1))).toBe(true); // just below the bottom edge
    expect(nearBorder(tile, P(150, 200 + ATTACH_TOLERANCE + 2))).toBe(false);
    expect(nearBorder(tile, P(200, 150))).toBe(false); // the middle of the tile is not its border
  });

  it("attaches line ends on the border of the moved shape, nothing else", () => {
    const l1 = line("l1", [P(150, 200), P(150, 260), P(400, 260)]); // starts on the tile's bottom edge
    const l2 = line("l2", [P(500, 500), P(600, 500)]); // far away
    const l3 = line("l3", [P(200, 150), P(260, 150)]); // starts inside the tile, not on the border
    const found = findAttachments([tile, l1, l2, l3], "tile", () => true);
    expect(found.map((f) => f.lineId)).toEqual(["l1"]);
    expect(found[0].start).toEqual(P(150, 200));
    expect(found[0].end).toBeUndefined();
  });

  it("honours glue even when the end is not near the border, and skips non-editable lines", () => {
    const glued = line("g", [P(500, 500), P(600, 500)], {
      type: "connector",
      connector: { begin: { point: P(500, 500), shapeId: "tile" }, end: { point: P(600, 500) } },
    });
    expect(findAttachments([tile, glued], "tile", () => true).map((f) => f.lineId)).toEqual(["g"]);
    expect(findAttachments([tile, glued], "tile", () => false)).toEqual([]);
  });

  it("moving a group follows ends on the borders of anything inside it", () => {
    const group = box("grp", 0, 0, 400, 300, { type: "group", geometry: [] });
    const inner = box("inner", 50, 50, 100, 60, { parentId: "grp" });
    const l = line("l", [P(100, 110), P(100, 200)]); // starts on the inner box's bottom edge
    const found = findAttachments([group, inner, l], "grp", () => true);
    expect(found.map((f) => f.lineId)).toEqual(["l"]);
  });

  it("does not treat lines inside the moved group as attachments", () => {
    const group = box("grp", 0, 0, 400, 300, { type: "group", geometry: [] });
    const inner = line("l", [P(0, 0), P(10, 10)], { parentId: "grp" });
    expect(findAttachments([group, inner], "grp", () => true)).toEqual([]);
  });
});

describe("followAnchor", () => {
  const start = { x: 100, y: 100, width: 200, height: 100, rotation: 0, flipX: false };
  it("translates with the shape", () => {
    expect(followAnchor(P(150, 200), start, { ...start, x: 130, y: 90 })).toEqual(P(180, 190));
  });
  it("keeps its relative place when the shape is resized", () => {
    const p = followAnchor(P(150, 200), start, { ...start, width: 400, height: 50 });
    expect(p.x).toBeCloseTo(100 + 0.25 * 400);
    expect(p.y).toBeCloseTo(100 + 50);
  });
  it("rotates with the shape", () => {
    const p = followAnchor(P(200, 200), start, { ...start, rotation: 90 }); // bottom-centre
    expect(p.x).toBeCloseTo(150);
    expect(p.y).toBeCloseTo(150);
  });
});

describe("findContents", () => {
  const zone = box("zone", 0, 0, 400, 300);
  const all = () => true;

  it("takes the siblings that lie inside, and no others", () => {
    const inside = box("in", 50, 50, 100, 60);
    const partly = box("partly", 350, 250, 100, 100); // a quarter inside
    const outside = box("out", 500, 500, 10, 10);
    const edge = box("edge", 0, 0, 400, 300); // exactly the same frame
    const c = findContents([zone, inside, partly, outside, edge], zone, all);
    expect(c.shapes.sort()).toEqual(["edge", "in"]);
  });

  it("takes a label whose frame pokes out over the edge, as long as its centre and most of it are inside", () => {
    // Like "External" in the real file: a 33 px tall label frame 6 px above the box's top edge.
    const label = box("label", 300, -6, 52, 33);
    expect(findContents([zone, label], zone, all).shapes).toEqual(["label"]);
    const mostlyOut = box("mostlyOut", 300, -20, 52, 33); // 13 of 33 px inside, centre outside
    expect(findContents([zone, mostlyOut], zone, all).shapes).toEqual([]);
    // Like "LOS DC1": left aligned, so its frame sticks out left and up while the words are inside (~50%).
    const corner = box("corner", -25, -6, 75, 25);
    expect(findContents([zone, corner], zone, all).shapes).toEqual(["corner"]);
    // Like a line's ":8943" label straddling the box's edge: 35% inside, left to stay where it is.
    const straddle = box("straddle", 380, 280, 30, 40);
    expect(findContents([zone, straddle], zone, all).shapes).toEqual([]);
  });

  it("does not take a shape just because its centre is inside: a big shape that covers the box stays", () => {
    const huge = box("huge", -300, -300, 1000, 900); // the box is a small part of it, centre inside
    expect(findContents([zone, huge], zone, all).shapes).toEqual([]);
  });

  it("does not take a shape that is mostly inside but whose centre is outside", () => {
    // a wide shape lying across the right edge with 60% inside has its centre inside; 45% does not
    const wide = box("wide", 400 - 90, 100, 200, 20); // 90 of 200 inside, centre at x=400+10 (outside)
    expect(findContents([zone, wide], zone, all).shapes).toEqual([]);
  });

  it("counts a group as one item and never reaches into other groups", () => {
    const grp = box("grp", 20, 20, 200, 100, { type: "group", geometry: [] });
    const part = box("part", 30, 30, 50, 50, { parentId: "grp" });
    const other = box("other", 300, 10, 80, 80, { type: "group", geometry: [] });
    const otherChild = box("oc", 310, 20, 20, 20, { parentId: "other" });
    const c = findContents([zone, grp, part, other, otherChild], zone, all);
    expect(c.shapes).toEqual(["grp", "other"]); // children come along inside their groups
  });

  it("only looks at siblings: a container inside a group does not take the page's shapes", () => {
    const grp = box("grp", 0, 0, 500, 400, { type: "group", geometry: [] });
    const inner = box("inner", 10, 10, 300, 200, { parentId: "grp" });
    const sibling = box("sib", 50, 50, 20, 20, { parentId: "grp" });
    const topLevel = box("top", 60, 60, 10, 10);
    const c = findContents([grp, inner, sibling, topLevel], inner, all);
    expect(c.shapes).toEqual(["sib"]);
  });

  it("carries lines that lie inside as a whole", () => {
    const l = line("l", [P(50, 50), P(50, 100), P(120, 100)]);
    const crossing = line("x", [P(50, 50), P(500, 50)]);
    const c = findContents([zone, l, crossing], zone, all);
    expect(c.lines).toEqual(["l"]);
  });

  it("leaves out a line glued to something outside the box, but keeps one glued to its contents", () => {
    const inside = box("in", 50, 50, 100, 60);
    const outside = box("out", 800, 50, 10, 10);
    const mk = (id: string, to: string) =>
      line(id, [P(150, 80), P(250, 80)], {
        type: "connector",
        connector: { begin: { point: P(150, 80), shapeId: "in" }, end: { point: P(250, 80), shapeId: to } },
      });
    const c = findContents([zone, inside, outside, mk("a", "in"), mk("b", "out")], zone, all);
    expect(c.lines).toEqual(["a"]);
  });

  it("recognises a curved 1-D connector by its end points", () => {
    const curved = line("c", [P(10, 10), P(50, 50)], {
      type: "connector",
      connector: { begin: { point: P(10, 10) }, end: { point: P(50, 50) } },
    });
    curved.geometry[0].commands.push({ op: "Q", x1: 1, y1: 1, x: 5, y: 5 }); // curve: no vertex list
    expect(lineVertices(curved)).toBeNull();
    expect(findContents([zone, curved], zone, all).lines).toEqual(["c"]);
  });

  it("works for a rotated container", () => {
    const rotated = box("rot", 100, 100, 200, 100, { rotation: 90 }); // turns about (200, 150)
    const inside = box("in", 190, 100, 20, 100); // spans the rotated frame's height (x 190..210, y 100..200)
    const out = box("out", 90, 140, 10, 10);
    expect(findContents([rotated, inside, out], rotated, all).shapes).toEqual(["in"]);
  });

  it("ignores shapes that can't be edited, and containers without area", () => {
    const inside = box("in", 50, 50, 10, 10);
    expect(findContents([zone, inside], zone, (id) => id !== "in").shapes).toEqual([]);
    expect(findContents([box("flat", 0, 0, 100, 0), inside], box("flat", 0, 0, 100, 0), all).shapes).toEqual([]);
  });
});
