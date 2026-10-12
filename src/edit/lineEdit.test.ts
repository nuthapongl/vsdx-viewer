import { describe, expect, it } from "vitest";
import type { Point } from "../model/types";
import { draggablePieces, moveBend, movePiece, normalise, pullTo, splitPiece } from "./lineEdit";

const P = (x: number, y: number): Point => ({ x, y });
// ┌─────┐   a Z-shaped line: right, down, right
const z = [P(0, 0), P(50, 0), P(50, 40), P(120, 40)];
const u = [P(0, 0), P(0, 60), P(100, 60), P(100, 10), P(150, 10)];

describe("draggablePieces", () => {
  it("offers the pieces between two bends, not the ones that touch an end", () => {
    expect(draggablePieces(z).map((p) => p.index)).toEqual([1]);
    expect(draggablePieces(u).map((p) => [p.index, p.kind])).toEqual([[1, "horizontal"], [2, "vertical"]]);
  });
  it("a straight line offers its middle, to add a bend", () => {
    const [p] = draggablePieces([P(0, 0), P(100, 100)]);
    expect(p).toMatchObject({ index: 0, split: true, mid: { x: 50, y: 50 } });
  });
  it("skips pieces too short to grab", () => {
    expect(draggablePieces([P(0, 0), P(0, 30), P(3, 30), P(3, 90), P(50, 90)]).map((p) => p.index)).toEqual([1 + 1]);
  });
});

describe("movePiece", () => {
  it("slides a vertical piece sideways only; the pieces next to it stretch", () => {
    const r = movePiece(z, 1, P(20, 15));
    expect(r).toEqual([P(0, 0), P(70, 0), P(70, 40), P(120, 40)]);
  });
  it("slides a horizontal piece up or down only", () => {
    const r = movePiece(u, 1, P(30, -25));
    expect(r).toEqual([P(0, 0), P(0, 35), P(100, 35), P(100, 10), P(150, 10)]);
  });
  it("merges pieces that end up in a straight run, and leaves the ends alone", () => {
    const r = movePiece(u, 2, P(-100, 0)); // pulls the vertical piece onto the first one
    expect(r[0]).toEqual(P(0, 0));
    expect(r[r.length - 1]).toEqual(P(150, 10));
    expect(r.every((p, k) => k === 0 || p.x === r[k - 1].x || p.y === r[k - 1].y)).toBe(true);
  });
  it("does not move the pieces that touch an end", () => {
    expect(movePiece(z, 0, P(0, 30))).toEqual(z);
    expect(movePiece(z, 2, P(0, 30))).toEqual(z);
  });
});

describe("splitPiece", () => {
  it("adds a bend to a straight line only", () => {
    expect(splitPiece([P(0, 0), P(100, 0)], P(50, 20))).toEqual([P(0, 0), P(50, 20), P(100, 0)]);
    expect(splitPiece(z, P(10, 10))).toEqual(z);
  });
});

describe("moveBend", () => {
  it("moves the bend and pulls the neighbouring bends so the pieces stay square", () => {
    const r = moveBend(u, 2, P(120, 80)); // bend (100,60) -> (120,80)
    // the piece before it was horizontal: bend 1 follows in y; the piece after was vertical: bend 3 follows in x
    expect(r).toEqual([P(0, 0), P(0, 80), P(120, 80), P(120, 10), P(150, 10)]);
  });
  it("leaves a neighbouring end where it is (the piece goes slanted rather than detaching)", () => {
    const r = moveBend(z, 1, P(60, 10)); // bend 1 is next to the first end
    expect(r[0]).toEqual(P(0, 0));
    expect(r[1]).toEqual(P(60, 10));
    expect(r[r.length - 1]).toEqual(P(120, 40));
  });
  it("cannot move an end (that is the end handle's job)", () => {
    expect(moveBend(z, 0, P(5, 5))).toEqual(z);
  });
});

describe("pullTo", () => {
  it("snaps to the nearest candidate within the tolerance", () => {
    expect(pullTo(52, [50, 60], 4)).toBe(50);
    expect(pullTo(57, [50, 60], 4)).toBe(60);
    expect(pullTo(55, [50, 60], 4)).toBe(55);
  });
});

describe("normalise", () => {
  it("merges a doubled bend and drops points on a straight run, keeping both ends", () => {
    const r = normalise([P(0, 0), P(0, 50), P(100, 50), P(100, 50.04), P(100.1, 0), P(150, 0)]);
    expect(r.length).toBe(5);
    expect(r[0]).toEqual(P(0, 0));
    expect(r[r.length - 1]).toEqual(P(150, 0));
    expect(normalise([P(0, 0), P(50, 0), P(100, 0)])).toEqual([P(0, 0), P(100, 0)]);
  });
});
