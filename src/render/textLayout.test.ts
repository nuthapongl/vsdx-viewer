// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { TextRun } from "../model/types";
import { layoutRuns } from "./textLayout";

const run = (text: string, extra: Partial<TextRun> = {}): TextRun => ({
  text,
  fontSize: 10,
  fontFamily: "sans-serif",
  color: "#000",
  bold: false,
  italic: false,
  underline: false,
  align: "left",
  ...extra,
});
const lines = (runs: TextRun[], w: number) => layoutRuns(runs, w).map((l) => l.segments.map((s) => s.text).join(""));

describe("layoutRuns", () => {
  it("breaks at explicit newlines, including a blank line", () => {
    expect(lines([run("a\nb\n\nc")], 0)).toEqual(["a", "b", "", "c"]);
  });
  it("a trailing line break ends in an empty line that takes up height", () => {
    expect(lines([run("a\n")], 0)).toEqual(["a", ""]);
    expect(lines([run("a\n\n")], 0)).toEqual(["a", "", ""]);
    expect(lines([run("a")], 0)).toEqual(["a"]);
  });
  it("wraps at spaces when the block is narrow (no canvas: 5.5 px per character at 10 px)", () => {
    expect(lines([run("aaaa bbbb cccc")], 5.5 * 9)).toEqual(["aaaa bbbb", "cccc"]);
  });
  it("keeps run boundaries on a line and uses the tallest font for the line height", () => {
    const l = layoutRuns([run("Big ", { fontSize: 20, bold: true }), run("small")], 0);
    expect(l).toHaveLength(1);
    expect(l[0].segments.map((s) => s.text)).toEqual(["Big ", "small"]);
    expect(l[0].fontSize).toBe(20);
  });
  it("shows a tab as a gap instead of dropping or mangling it", () => {
    const l = lines([run("a\tb")], 0);
    expect(l[0].startsWith("a")).toBe(true);
    expect(l[0].endsWith("b")).toBe(true);
    expect(l[0].length).toBeGreaterThan(3);
    expect(l[0]).not.toContain("\t");
  });
});
