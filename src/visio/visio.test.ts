// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { buildSampleVsdx } from "../../scripts/sampleVsdx";
import type { DiagramDocument, DiagramShape } from "../model/types";
import { decompose, localToParent, multiply, pageToScreen } from "./coordinateTransform";
import { evalFormula } from "./formula";
import { cssFontFamily } from "./text";
import { loadVsdx } from "./loadVsdx";

describe("evalFormula", () => {
  it("evaluates arithmetic over Width/Height", () => {
    expect(evalFormula("Width*0.5", { Width: 4, Height: 2 })).toBe(2);
    expect(evalFormula("GUARD(Height-0.25)", { Width: 4, Height: 2 })).toBe(1.75);
    expect(evalFormula("-(Width+1)*2", { Width: 4, Height: 2 })).toBe(-10);
    expect(evalFormula("MAX(Width,Height)/2", { Width: 4, Height: 6 })).toBe(3);
    expect(evalFormula("2^3^2", {})).toBe(512);
    expect(evalFormula("-2^2", {})).toBe(-4);
    expect(evalFormula("SQRT((EndX-BeginX)^2+(EndY-BeginY)^2)", { BeginX: 1, BeginY: 1, EndX: 4, EndY: 5 })).toBe(5);
    expect(evalFormula("ATAN2(EndY-BeginY,EndX-BeginX)", { BeginX: 0, BeginY: 0, EndX: 0, EndY: 2 })).toBeCloseTo(Math.PI / 2);
    expect(evalFormula("(BeginX+EndX)/2", { BeginX: 1, EndX: 4 })).toBe(2.5);
  });
  it("gives up on unsupported references", () => {
    expect(evalFormula("Sheet.5!Width*2", { Width: 4, Height: 2 })).toBeUndefined();
    expect(evalFormula("THEMEVAL()", { Width: 4, Height: 2 })).toBeUndefined();
  });
});

describe("cssFontFamily", () => {
  it("lists the file's fonts first, then substitutes and a matching generic family", () => {
    expect(cssFontFamily(["Calibri"])).toBe('"Calibri", "Carlito", sans-serif');
    expect(cssFontFamily(["Times New Roman", "Cordia New"])).toBe(
      '"Times New Roman", "Times", "Liberation Serif", "Cordia New", serif',
    );
    expect(cssFontFamily(["Courier New"])).toContain("monospace");
  });
});

describe("coordinateTransform", () => {
  it("turns a CCW Visio rotation into a CW-negative screen rotation and detects flips", () => {
    const toScreen = multiply(
      pageToScreen(10),
      localToParent({ pinX: 3, pinY: 4, locPinX: 1, locPinY: 0.5, angle: Math.PI / 6, flipX: false, flipY: false }),
    );
    const p = decompose(toScreen, 2, 1);
    expect(p.rotation).toBeCloseTo(-30, 6);
    expect(p.flipX).toBe(false);

    const flipY = decompose(
      multiply(pageToScreen(10), localToParent({ pinX: 3, pinY: 4, locPinX: 1, locPinY: 0.5, angle: 0, flipX: false, flipY: true })),
      2,
      1,
    );
    // A vertical flip is represented as mirror + 180°.
    expect(flipY.flipX).toBe(true);
    expect(Math.abs(flipY.rotation)).toBeCloseTo(180, 6);
  });
});

describe("loadVsdx (synthetic sample)", () => {
  let doc: DiagramDocument;
  let byId: Map<string, DiagramShape>;

  beforeAll(async () => {
    doc = await loadVsdx(await buildSampleVsdx(), "sample.vsdx");
    byId = new Map(doc.pages[0].shapes.map((s) => [s.id, s]));
  });

  const centre = (s: DiagramShape) => [s.x + s.width / 2, s.y + s.height / 2];

  it("detects foreground pages only, and reports no warnings", () => {
    expect(doc.name).toBe("sample");
    expect(doc.pages.map((p) => p.name)).toEqual(["Flowchart", "Second page"]);
    expect(doc.warnings).toEqual([]);
    expect(doc.pages[0].width).toBeCloseTo(11 * 96);
    expect(doc.pages[1].height).toBeCloseTo(4 * 96);
  });

  it("paints background page shapes first, with distinct ids", () => {
    const shapes = doc.pages[0].shapes;
    expect(shapes[0].id).toBe("bg2:1");
    expect(shapes[0].text).toBe("Background page title");
    expect(shapes[0].type).toBe("text");
  });

  it("inherits master geometry and style, re-evaluating formulas for resized instances", () => {
    const s1 = byId.get("1")!;
    expect(s1.type).toBe("rectangle");
    expect(s1.width).toBeCloseTo(192);
    expect(s1.style.fill).toBe("#9dc3e6");
    expect(s1.style.stroke).toBe("#2f528f");
    expect(s1.style.strokeWidth).toBeCloseTo(1.92);
    expect(s1.source?.master).toBe("Process");

    const s2 = byId.get("2")!;
    expect(s2.type).toBe("rectangle");
    expect(s2.width).toBeCloseTo(288);
    expect(s2.height).toBeCloseTo(144);
    expect(s2.x).toBeCloseTo(432);
    expect(s2.y).toBeCloseTo(72);
    const xs = s2.geometry[0].commands.flatMap((c) => ("x" in c ? [c.x] : []));
    const ys = s2.geometry[0].commands.flatMap((c) => ("y" in c ? [c.y] : []));
    expect(Math.max(...xs)).toBeCloseTo(288);
    expect(Math.max(...ys)).toBeCloseTo(144);
  });

  it("extracts text with its style resolved through the style sheet", () => {
    const free = byId.get("10")!;
    expect(free.type).toBe("text");
    expect(free.textStyle?.align).toBe("left");
    expect(free.textRuns).toHaveLength(1);
    // Size 0.1667in and Font index 0 (-> "Calibri") come from style sheet 0.
    expect(free.textRuns![0].fontSize).toBeCloseTo(16, 1);
    expect(free.textRuns![0].fontFamily).toContain('"Calibri"');
    expect(free.textRuns![0].color).toBe("#000000");
  });

  it("keeps per-run font, size, weight, style and colour", () => {
    const s = byId.get("1")!;
    expect(s.text).toBe("Start (italic)");
    expect(s.textBlock).toMatchObject({ x: 0, y: 0, width: 192, height: 96 });
    const [a, b] = s.textRuns!;
    expect(a).toMatchObject({ text: "Start", bold: true, italic: false });
    expect(a.fontSize).toBeCloseTo(16, 1);
    expect(a.fontFamily.startsWith('"Arial"')).toBe(true);
    expect(a.fontFamily.endsWith("sans-serif")).toBe(true);
    expect(b).toMatchObject({ text: " (italic)", bold: false, italic: true, color: "#c00000" });
    expect(b.fontSize).toBeCloseTo(12, 1);
    expect(b.fontFamily).toContain('"Calibri"');
    expect(b.align).toBe("center");
  });

  it("resolves 'Themed' values through the style chain and adds complex-script fonts", () => {
    const [run] = byId.get("3")!.textRuns!;
    expect(run.text).toBe("Decision การตัดสินใจ");
    expect(run.color).toBe("#000000"); // "Themed" -> style sheet colour 0
    expect(run.fontFamily.startsWith('"Calibri"')).toBe(true); // "Themed" -> style sheet font 0
    expect(run.fontFamily).toContain('"Cordia New"');
    expect(run.fontSize).toBeCloseTo(14.4, 1);
  });

  it("the last newline only ends the paragraph; further ones are kept as blank lines", async () => {
    // Real files: "...(VIP)\n" + "\n" is a line of text followed by an empty line.
    const { parseTextRuns } = await import("./text");
    const xml = new DOMParser().parseFromString(
      `<Text xmlns="http://schemas.microsoft.com/office/visio/2012/main"><cp IX="0"/>one\ntwo<cp IX="1"/>\n</Text>`,
      "application/xml",
    ).documentElement;
    const sheet = { sectionValue: () => undefined, num: () => 0, fontName: () => undefined } as never;
    expect(parseTextRuns(xml, sheet).map((r) => r.text).join("")).toBe("one\ntwo");
    const xml2 = new DOMParser().parseFromString(
      `<Text xmlns="http://schemas.microsoft.com/office/visio/2012/main"><cp IX="0"/>one\n<cp IX="1"/>\n</Text>`,
      "application/xml",
    ).documentElement;
    expect(parseTextRuns(xml2, sheet).map((r) => r.text).join("")).toBe("one\n");
  });

  it("treats Visio's Shift+Enter (U+2028) as a line break and keeps tabs", () => {
    const a = byId.get("9")!;
    expect(a.text).toBe("Arc\nsecond line\tTabbed");
    expect(a.textRuns!.map((r) => r.text).join("")).not.toMatch(/\u2028/);
  });

  it("places a picture at its own offset and size (larger than the frame; the frame crops it)", () => {
    const pic = byId.get("13")!;
    expect(pic.type).toBe("image");
    expect(pic.image?.href).toBeTruthy();
    expect([pic.width, pic.height]).toEqual([96, 48]);
    // ImgOffsetX -0.25in, ImgWidth 1.5in, ImgHeight 0.5in, bottom offset 0
    expect(pic.image).toMatchObject({ x: -24, y: 0, width: 144, height: 48 });
  });

  it("recognises ellipses", () => {
    const e = byId.get("3")!;
    expect(e.type).toBe("ellipse");
    expect(e.style.fill).toBe("#ffd966");
    expect(e.geometry[0].commands.some((c) => c.op === "A")).toBe(true);
  });

  it("reads glued connectors with end points in page px", () => {
    const c = byId.get("4")!;
    expect(c.type).toBe("connector");
    expect(c.connector!.begin.shapeId).toBe("1");
    expect(c.connector!.end.shapeId).toBe("2");
    expect(c.connector!.begin.point.x).toBeCloseTo(288);
    expect(c.connector!.begin.point.y).toBeCloseTo(144);
    expect(c.connector!.end.point.x).toBeCloseTo(432);
    expect(c.style.endArrow).toBe(4);
    expect(c.style.stroke).toBe("#404040");
    expect(c.geometry[0].fill).toBe(false);
  });

  it("composes group transforms for children", () => {
    const g = byId.get("5")!;
    expect(g.type).toBe("group");
    expect(g.rotation).toBeCloseTo(-30, 4);
    const child = byId.get("6")!;
    expect(child.parentId).toBe("5");
    expect(child.rotation).toBeCloseTo(-30, 4);
    const [cx, cy] = centre(child);
    expect(cx).toBeCloseTo(8.5 * 96);
    expect(cy).toBeCloseTo((8.5 - 4) * 96);
    expect(byId.get("7")!.parentId).toBe("5");
  });

  it("handles flips and rotation", () => {
    const f = byId.get("8")!;
    expect(f.flipX).toBe(true);
    expect(f.rotation).toBeCloseTo(0, 6);
    const r = byId.get("11")!;
    expect(r.rotation).toBeCloseTo(-45, 4);
    expect(r.style.fill).toBeUndefined();
    expect(r.style.dash).toBeDefined();
    expect(r.style.stroke).toBe("#c00000");
  });

  it("converts EllipticalArcTo into an SVG arc with the right flags", () => {
    const a = byId.get("9")!;
    const arc = a.geometry[0].commands.find((c) => c.op === "A");
    expect(arc).toBeDefined();
    if (arc?.op !== "A") throw new Error("unreachable");
    expect(arc.rx).toBeCloseTo(0.625 * 96, 4);
    expect(arc.ry).toBeCloseTo(0.625 * 96, 4);
    expect(arc.largeArc).toBe(true);
    // Travelling up on the right-hand side is counter-clockwise on screen.
    expect(arc.sweep).toBe(false);
  });

  it("parses every page, including ones using masters", () => {
    const p2 = doc.pages[1].shapes;
    expect(p2).toHaveLength(1);
    expect(p2[0].width).toBeCloseTo(192);
    expect(p2[0].text).toBe("Page two");
  });
});

describe("loadVsdx errors", () => {
  it("rejects non-zip input with a readable message", async () => {
    await expect(loadVsdx(new Uint8Array([1, 2, 3, 4]), "x.vsdx")).rejects.toThrow(/ZIP/);
  });
});
