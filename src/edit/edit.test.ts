// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { buildSampleVsdx } from "../../scripts/sampleVsdx";
import type { DiagramShape } from "../model/types";
import { placementMatrix } from "../model/transform";
import { loadVsdx } from "../visio/loadVsdx";
import { EditSession } from "./session";
import { lineVertices } from "./connectors";

const PAGE = "0";
let session: EditSession;

const shape = (id: string): DiagramShape =>
  session.document.pages.find((p) => p.id === PAGE)!.shapes.find((s) => s.id === id)!;
const centre = (s: DiagramShape) => [s.x + s.width / 2, s.y + s.height / 2];

/** Save, then open the saved bytes as a plain document (what a user would get on reopening). */
async function reopen() {
  const bytes = await session.save();
  const doc = await loadVsdx(bytes, "saved.vsdx");
  return doc.pages.find((p) => p.id === PAGE)!.shapes;
}

beforeEach(async () => {
  session = await EditSession.open(await buildSampleVsdx(), "sample.vsdx");
});

describe("placement", () => {
  it("is idempotent: writing every shape's current placement changes nothing", async () => {
    const original = (await loadVsdx(await buildSampleVsdx(), "o.vsdx")).pages[0].shapes;
    for (const id of ["1", "2", "3", "5", "6", "7", "8", "9", "10", "11"]) {
      session.setPlacement(PAGE, id, { ...shape(id) });
    }
    await session.idle();
    expect(session.canUndo).toBe(false); // no cell needed changing, so no undo step
    // Blob URLs are fresh on every load; everything else must be identical.
    const noUrl = (shapes: DiagramShape[]) =>
      shapes.map((s) => (s.image ? { ...s, image: { ...s.image, href: s.image.href ? "url" : undefined } } : s));
    expect(noUrl(await reopen())).toEqual(noUrl(original));
  });

  it("moves a top-level shape and the move survives save + reopen", async () => {
    const s = shape("3");
    session.setPlacement(PAGE, "3", { ...s, x: s.x + 96, y: s.y - 48 });
    await session.idle();
    const moved = shape("3");
    expect(moved.x).toBeCloseTo(s.x + 96);
    expect(moved.y).toBeCloseTo(s.y - 48);

    const reopened = (await reopen()).find((x) => x.id === "3")!;
    expect(reopened.x).toBeCloseTo(s.x + 96, 4);
    expect(reopened.y).toBeCloseTo(s.y - 48, 4);
    expect(reopened.width).toBeCloseTo(s.width, 4);
  });

  it("moves a group together with its children, including inside a rotated group", async () => {
    const g = shape("5");
    const child = shape("6");
    session.setPlacement(PAGE, "5", { ...g, x: g.x - 100, y: g.y + 60 });
    await session.idle();
    const [cx, cy] = centre(shape("6"));
    expect(cx).toBeCloseTo(centre(child)[0] - 100, 4);
    expect(cy).toBeCloseTo(centre(child)[1] + 60, 4);
    expect(shape("6").rotation).toBeCloseTo(child.rotation, 4);

    // Now move the child itself inside the (30°-rotated) group, in page space.
    const c = shape("7");
    session.setPlacement(PAGE, "7", { ...c, x: c.x + 20, y: c.y });
    await session.idle();
    const after = shape("7");
    expect(after.x).toBeCloseTo(c.x + 20, 4);
    expect(after.y).toBeCloseTo(c.y, 4);
    expect(after.rotation).toBeCloseTo(c.rotation, 4);
  });

  it("resizes a master instance whose geometry comes from inherited formulas", async () => {
    const s = shape("2");
    session.setPlacement(PAGE, "2", { ...s, width: s.width + 96, height: s.height - 24 }, "Resize");
    await session.idle();
    const r = shape("2");
    expect(r.width).toBeCloseTo(s.width + 96);
    expect(r.height).toBeCloseTo(s.height - 24);
    const xs = r.geometry[0].commands.flatMap((c) => ("x" in c ? [c.x] : []));
    expect(Math.max(...xs)).toBeCloseTo(r.width); // geometry follows the new size

    const re = (await reopen()).find((x) => x.id === "2")!;
    expect(re.width).toBeCloseTo(r.width, 4);
    expect(re.height).toBeCloseTo(r.height, 4);
    expect(re.textBlock!.width).toBeCloseTo(r.width, 4);
  });

  it("scales formula-driven geometry on resize, and leaves constant geometry alone (as Visio does)", async () => {
    const id = await session.addShape(PAGE, "ellipse", { x: 300, y: 300 }); // geometry built from Width/Height formulas
    const s = shape(id);
    session.setPlacement(PAGE, id, { ...s, width: s.width * 2 });
    await session.idle();
    const e = shape(id);
    expect(e.width).toBeCloseTo(s.width * 2);
    const arc = e.geometry[0].commands.find((c) => c.op === "A");
    expect(arc && arc.op === "A" && arc.rx).toBeCloseTo(s.width, 3); // rx = new width / 2
    const re = (await reopen()).find((x) => x.id === id)!;
    expect(re.width).toBeCloseTo(s.width * 2, 4);

    // Shape 3's ellipse is stored with constant coordinates: its box grows, its outline doesn't.
    const c = shape("3");
    session.setPlacement(PAGE, "3", { ...c, width: c.width * 2 });
    await session.idle();
    const arc3 = shape("3").geometry[0].commands.find((x) => x.op === "A");
    expect(arc3 && arc3.op === "A" && arc3.rx).toBeCloseTo(c.width / 2, 3);
  });

  it("rotates a shape about its centre", async () => {
    const s = shape("1");
    session.setPlacement(PAGE, "1", { ...s, rotation: 45 });
    await session.idle();
    const r = shape("1");
    expect(r.rotation).toBeCloseTo(45, 4);
    expect(centre(r)[0]).toBeCloseTo(centre(s)[0], 4);
    expect(centre(r)[1]).toBeCloseTo(centre(s)[1], 4);
    const re = (await reopen()).find((x) => x.id === "1")!;
    expect(re.rotation).toBeCloseTo(45, 4);
  });

  it("resizing a picture keeps its crop proportional (ImgWidth is a formula of Width)", async () => {
    const pic = shape("13");
    session.setPlacement(PAGE, "13", { ...pic, width: pic.width * 2 });
    await session.idle();
    const r = shape("13");
    expect(r.width).toBeCloseTo(192);
    expect(r.image).toMatchObject({ width: 288, height: 48 });
    expect(r.image!.x).toBeCloseTo(-48, 3); // ImgOffsetX = ImgWidth * -1/6
  });

  it("keeps a flipped shape flipped when it is moved", async () => {
    const s = shape("8");
    session.setPlacement(PAGE, "8", { ...s, x: s.x + 50 });
    await session.idle();
    expect(shape("8").flipX).toBe(true);
    expect(shape("8").x).toBeCloseTo(s.x + 50, 4);
  });

  it("drops the formula on cells it overwrites, so Visio can't snap the shape back", async () => {
    const JSZip = (await import("jszip")).default;
    const pinX = async () => {
      const zip = await JSZip.loadAsync(await session.save());
      const xml = await zip.file("visio/pages/page1.xml")!.async("string");
      return xml.match(/<Shape ID="6"[\s\S]*?(<Cell N="PinX"[^>]*>)/)![1];
    };
    session.setPlacement(PAGE, "6", { ...shape("6"), x: shape("6").x + 10 });
    const cellXml = await pinX();
    expect(cellXml).not.toContain("F=");
    expect(cellXml).toMatch(/V="[0-9.]+"/);
  });
});

describe("live drag (begin/apply/commit)", () => {
  it("applies repeatedly without accumulating, and is one undo step", async () => {
    const { writePlacement } = await import("./xmlEdit");
    const s = shape("3");
    const edit = session.begin(PAGE, ["3"]);
    for (let i = 1; i <= 5; i++) {
      edit.apply(([ref]) => writePlacement(ref, { ...s, x: s.x + i * 10, width: s.width + i * 4 }));
    }
    expect(edit.commit("Drag")).toBe(true);
    await session.idle();
    expect(shape("3").x).toBeCloseTo(s.x + 50, 4);
    expect(shape("3").width).toBeCloseTo(s.width + 20, 4);

    await session.undo();
    expect(shape("3").x).toBeCloseTo(s.x, 4);
    expect(shape("3").width).toBeCloseTo(s.width, 4);
    expect(session.canUndo).toBe(false);
    await session.redo();
    expect(shape("3").x).toBeCloseTo(s.x + 50, 4);
  });

  it("cancel puts everything back", async () => {
    const { writePlacement } = await import("./xmlEdit");
    const s = shape("3");
    const edit = session.begin(PAGE, ["3"]);
    edit.apply(([ref]) => writePlacement(ref, { ...s, x: s.x + 99 }));
    edit.cancel();
    await session.idle();
    expect(shape("3").x).toBeCloseTo(s.x, 6);
    expect(session.canUndo).toBe(false);
  });

  it("commit without any real change records nothing", async () => {
    const { writePlacement } = await import("./xmlEdit");
    const s = shape("3");
    const edit = session.begin(PAGE, ["3"]);
    edit.apply(([ref]) => writePlacement(ref, { ...s }));
    expect(edit.commit("Drag")).toBe(false);
  });
});

describe("text", () => {
  it("edits only the changed characters, keeping per-run formatting", async () => {
    const s = shape("1"); // "Start" (Arial bold) + " (italic)" (Calibri italic, red)
    expect(s.text).toBe("Start (italic)");
    session.setText(PAGE, "1", s.text!, "Begin (italic)");
    await session.idle();
    const t = shape("1");
    expect(t.text).toBe("Begin (italic)");
    expect(t.textRuns).toHaveLength(2);
    expect(t.textRuns![0]).toMatchObject({ text: "Begin", bold: true });
    expect(t.textRuns![1]).toMatchObject({ text: " (italic)", italic: true, color: "#c00000" });

    session.setText(PAGE, "1", "Begin (italic)", "Begin (italic) ok");
    await session.idle();
    expect(shape("1").textRuns![1].text).toBe(" (italic) ok"); // appended to the last run
    expect(shape("1").textRuns![1].italic).toBe(true);
  });

  it("handles Thai and newlines, and gives text to a shape that had none", async () => {
    session.setText(PAGE, "8", "", "สวัสดี\nบรรทัดสอง");
    await session.idle();
    expect(shape("8").text).toBe("สวัสดี\nบรรทัดสอง");
    const re = (await reopen()).find((x) => x.id === "8")!;
    expect(re.text).toBe("สวัสดี\nบรรทัดสอง");
  });

  it("editing text with a Shift+Enter line break keeps the original break characters", async () => {
    const JSZip = (await import("jszip")).default;
    expect(shape("9").text).toBe("Arc\nsecond line\tTabbed");
    session.setText(PAGE, "9", shape("9").text!, "Arc\nsecond line\tTabbed!");
    const xml = await (await JSZip.loadAsync(await session.save())).file("visio/pages/page1.xml")!.async("string");
    expect(xml).toContain("Arc\u2028second line\tTabbed!"); // the U+2028 was not rewritten
    expect(shape("9").text).toBe("Arc\nsecond line\tTabbed!");
  });

  it("deleting all text leaves an empty label", async () => {
    session.setText(PAGE, "10", "Free-floating text", "");
    await session.idle();
    expect(shape("10").text).toBeUndefined();
  });

  it("escapes XML special characters", async () => {
    session.setText(PAGE, "10", "Free-floating text", "a < b && c > d");
    const re = (await reopen()).find((x) => x.id === "10")!;
    expect(re.text).toBe("a < b && c > d");
  });
});

describe("style", () => {
  it("changes fill, stroke and weight, and applies to everything inside a group", async () => {
    session.setStyle(PAGE, ["1"], { fill: "#112233", stroke: "#445566", lineWidth: 4 });
    await session.idle();
    expect(shape("1").style).toMatchObject({ fill: "#112233", stroke: "#445566" });
    expect(shape("1").style.strokeWidth).toBeCloseTo(4);

    session.setStyle(PAGE, ["5"], { fill: "#abcdef" });
    await session.idle();
    expect(shape("6").style.fill).toBe("#abcdef");
    expect(shape("7").style.fill).toBe("#abcdef");

    session.setStyle(PAGE, ["1"], { fill: null, stroke: null });
    await session.idle();
    expect(shape("1").style.fill).toBeUndefined();
    expect(shape("1").style.stroke).toBeUndefined();

    const re = (await reopen()).find((x) => x.id === "1")!;
    expect(re.style.fill).toBeUndefined();
  });

  it("coalesces rapid changes of the same field into one undo step", async () => {
    for (const c of ["#111111", "#222222", "#333333"]) {
      session.setStyle(PAGE, ["1"], { fill: c }, "fill:1");
    }
    await session.idle();
    await session.undo();
    expect(session.canUndo).toBe(false);
    expect(shape("1").style.fill).toBe("#9dc3e6");
  });
});

describe("structure", () => {
  it("deletes a shape and the glue/references that pointed at it", async () => {
    session.deleteShapes(PAGE, ["1"]);
    await session.idle();
    const shapes = session.document.pages[0].shapes;
    expect(shapes.find((s) => s.id === "1")).toBeUndefined();
    const connector = shapes.find((s) => s.id === "4")!;
    expect(connector.connector!.begin.shapeId).toBeUndefined(); // glue record removed
    expect(connector.connector!.end.shapeId).toBe("2"); // the other end is untouched

    // Formulas that referenced Sheet.1 would dangle: they are replaced by their cached values.
    const JSZip = (await import("jszip")).default;
    const xml = await (await JSZip.loadAsync(await session.save())).file("visio/pages/page1.xml")!.async("string");
    expect(xml).not.toContain("Sheet.1!");
    expect(xml).toContain("Sheet.2!"); // the other end is still glued

    await session.undo();
    expect(session.document.pages[0].shapes.find((s) => s.id === "1")).toBeDefined();
    expect(session.document.pages[0].shapes.find((s) => s.id === "4")!.connector!.begin.shapeId).toBe("1");
  });

  it("deletes a group with its children", async () => {
    session.deleteShapes(PAGE, ["5"]);
    await session.idle();
    const ids = session.document.pages[0].shapes.map((s) => s.id);
    expect(ids).not.toContain("5");
    expect(ids).not.toContain("6");
    expect(ids).not.toContain("7");
  });

  it("adds shapes with unique ids that render and survive save + reopen", async () => {
    const id = await session.addShape(PAGE, "rectangle", { x: 400, y: 300 });
    const r = shape(id);
    expect(r.type).toBe("rectangle");
    expect(centre(r)[0]).toBeCloseTo(400);
    expect(centre(r)[1]).toBeCloseTo(300);
    expect(session.isEditable(PAGE, id)).toBe(true);

    const e = await session.addShape(PAGE, "ellipse", { x: 100, y: 100 });
    expect(shape(e).type).toBe("ellipse");
    const t = await session.addShape(PAGE, "text", { x: 200, y: 200 });
    expect(shape(t).type).toBe("text");
    expect(shape(t).text).toBe("Text");
    expect(new Set([id, e, t]).size).toBe(3);

    const re = await reopen();
    expect(re.find((x) => x.id === id)!.type).toBe("rectangle");
    expect(re.find((x) => x.id === t)!.text).toBe("Text");

    await session.undo();
    await session.undo();
    await session.undo();
    expect(session.document.pages[0].shapes.find((s) => s.id === id)).toBeUndefined();
  });

  it("reorders shapes", async () => {
    const order = () => session.document.pages[0].shapes.filter((s) => !s.parentId).map((s) => s.id);
    session.reorder(PAGE, "1", "front");
    await session.idle();
    expect(order().at(-1)).toBe("1");
    session.reorder(PAGE, "1", "back");
    await session.idle();
    expect(order().slice(0, 2)).toContain("1");
  });
});

describe("saving", () => {
  it("leaves untouched parts byte-identical and only rewrites the edited page", async () => {
    const original = await buildSampleVsdx();
    const JSZip = (await import("jszip")).default;
    const before = await JSZip.loadAsync(original);
    session.setStyle(PAGE, ["1"], { fill: "#ff0000" });
    const after = await JSZip.loadAsync(await session.save());

    const changed: string[] = [];
    for (const name of Object.keys(before.files)) {
      if (before.files[name].dir) continue;
      const a = await before.file(name)!.async("string");
      const b = await after.file(name)?.async("string");
      if (a !== b) changed.push(name);
    }
    expect(changed).toEqual(["visio/pages/page1.xml"]);
    expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
  });

  it("only changes the targeted shape's XML", async () => {
    const JSZip = (await import("jszip")).default;
    const before = await JSZip.loadAsync(await buildSampleVsdx());
    const a = await before.file("visio/pages/page1.xml")!.async("string");
    session.setPlacement(PAGE, "8", { ...shape("8"), x: shape("8").x + 10 }); // no line touches shape 8
    const after = await JSZip.loadAsync(await session.save());
    const b = await after.file("visio/pages/page1.xml")!.async("string");

    const whole = (xml: string, id: string) => xml.match(new RegExp(`<Shape ID="${id}"[\\s\\S]*?</Shape>`))![0];
    for (const id of ["1", "2", "3", "4", "9", "10", "11", "12"]) expect(b).toContain(whole(a, id));

    const strip = (xml: string) =>
      xml.replace(new RegExp(`<Shape ID="8"[\\s\\S]*?</Shape>`), "<SHAPE/>").replace(/<\?xml[^>]*\?>\s*/, "");
    expect(strip(b)).toBe(strip(a));
    const pinOf = (xml: string) => xml.match(/<Shape ID="8"[\s\S]*?<Cell N="PinX" V="([^"]+)"/)![1];
    expect(parseFloat(pinOf(b))).toBeCloseTo(parseFloat(pinOf(a)) + 10 / 96, 6);
  });

  it("reports unsaved changes until saved", async () => {
    expect(session.dirty).toBe(false);
    session.setStyle(PAGE, ["1"], { fill: "#ff0000" });
    expect(session.dirty).toBe(true);
    await session.save();
    expect(session.dirty).toBe(false);
  });
});

describe("placementMatrix sanity", () => {
  it("maps the box centre to the frame centre", () => {
    const s = shape("5");
    const m = placementMatrix(s);
    const [x, y] = [m[0] * (s.width / 2) + m[2] * (s.height / 2) + m[4], m[1] * (s.width / 2) + m[3] * (s.height / 2) + m[5]];
    expect(x).toBeCloseTo(s.x + s.width / 2);
    expect(y).toBeCloseTo(s.y + s.height / 2);
  });
});

describe("lines follow the shapes they touch", () => {
  const verts = (id: string) => lineVertices(shape(id))!;
  const near = (a: { x: number; y: number }, x: number, y: number) => {
    expect(a.x).toBeCloseTo(x, 3);
    expect(a.y).toBeCloseTo(y, 3);
  };
  const ORIGINAL = { v0: [144, 192], v1: [144, 259.2], v2: [240, 259.2], v3: [240, 326.4] };

  it("starts from the geometry we expect", () => {
    const v = verts("12");
    near(v[0], ORIGINAL.v0[0], ORIGINAL.v0[1]);
    near(v[3], ORIGINAL.v3[0], ORIGINAL.v3[1]);
  });

  it("a glued 1-D connector's end follows its shape; the other end stays", async () => {
    const s = shape("1");
    session.setPlacement(PAGE, "1", { ...s, x: s.x + 96, y: s.y + 48 });
    await session.idle();
    const c = shape("4");
    near(c.connector!.begin.point, 384, 192); // right edge of shape 1, moved by (96, 48)
    near(c.connector!.end.point, 432, 144); // glued to shape 2, which did not move
    expect(c.rotation).toBeCloseTo(-45, 4); // now runs up and to the right
    expect(c.width).toBeCloseTo(Math.hypot(48, 48), 4);
    expect(c.connector!.begin.shapeId).toBe("1"); // glue is kept
    expect(c.connector!.end.shapeId).toBe("2");
  });

  it("keeps glue formulas on the connector and a consistent 1-D shape in the saved file", async () => {
    const s = shape("1");
    session.setPlacement(PAGE, "1", { ...s, x: s.x + 96, y: s.y + 48 });
    const JSZip = (await import("jszip")).default;
    const xml = await (await JSZip.loadAsync(await session.save())).file("visio/pages/page1.xml")!.async("string");
    const conn = xml.match(/<Shape ID="4"[\s\S]*?<\/Shape>/)![0];
    expect(conn).toContain('F="PAR(PNT(Sheet.1!Connections.X2,Sheet.1!Connections.Y2))"');
    expect(conn).toContain('F="(BeginX+EndX)/2"');
    expect(conn).toContain('F="SQRT((EndX-BeginX)^2+(EndY-BeginY)^2)"');
    expect(conn).toContain('F="ATAN2(EndY-BeginY,EndX-BeginX)"');
    // Pin is the midpoint of the new end points (inches, Y up): begin (4, 6.5), end (4.5, 7).
    const v = (n: string) => parseFloat(conn.match(new RegExp(`N="${n}" V="([^"]+)"`))![1]);
    expect(v("PinX")).toBeCloseTo(4.25, 6);
    expect(v("PinY")).toBeCloseTo(6.75, 6);
    expect(v("Width")).toBeCloseTo(Math.hypot(0.5, 0.5), 6);
    expect(v("Angle")).toBeCloseTo(Math.PI / 4, 6);
    // The geometry row that ends the line still follows Width.
    expect(conn).toMatch(/<Row T="LineTo" IX="2"><Cell N="X" V="0\.7071\d*" F="Width\*1"/);

    const re = (await loadVsdx(await session.save(), "r.vsdx")).pages[0].shapes.find((x) => x.id === "4")!;
    near(re.connector!.begin.point, 384, 192);
    near(re.connector!.end.point, 432, 144);
  });

  it("an unglued orthogonal polyline stays orthogonal and keeps its far end", async () => {
    const s = shape("1");
    session.setPlacement(PAGE, "1", { ...s, x: s.x + 48, y: s.y + 48 });
    await session.idle();
    const v = verts("12");
    near(v[0], 192, 240); // began on Start's bottom edge: moved with it
    near(v[1], 192, 259.2); // vertical first segment: neighbour follows in x
    near(v[2], 240, 259.2);
    near(v[3], 240, 326.4); // end on Decision, which did not move
    for (let i = 1; i < v.length; i++) {
      const dx = Math.abs(v[i].x - v[i - 1].x);
      const dy = Math.abs(v[i].y - v[i - 1].y);
      expect(Math.min(dx, dy)).toBeLessThan(1e-6); // every segment is horizontal or vertical
    }
  });

  it("the far end of a line follows when the shape at that end moves", async () => {
    const s = shape("3"); // Decision: the polyline ends on its top edge
    session.setPlacement(PAGE, "3", { ...s, x: s.x + 24, y: s.y + 48 });
    await session.idle();
    const v = verts("12");
    near(v[0], 144, 192);
    near(v[3], 264, 374.4);
    near(v[2], 264, 259.2); // last segment vertical: its neighbour follows in x
    near(v[1], 144, 259.2);
  });

  it("resizing keeps the end at the same relative place on the border", async () => {
    const s = shape("1");
    session.setPlacement(PAGE, "1", { ...s, width: s.width * 2 }); // frame x stays: 96 .. 480
    await session.idle();
    // The polyline start was 25% along the bottom edge (x = 96 + .25 * 192 = 144) -> 96 + .25 * 384
    near(verts("12")[0], 192, 192);
    near(shape("4").connector!.begin.point, 480, 144); // right edge
  });

  it("rotating turns attached ends with the shape", async () => {
    const s = shape("1");
    session.setPlacement(PAGE, "1", { ...s, rotation: 90 });
    await session.idle();
    near(verts("12")[0], 144, 96); // (-48,+48) about the centre (192,144), 90° clockwise
  });

  it("lines that touch nothing that moved are left alone", async () => {
    const before = JSON.stringify(shape("12"));
    const s = shape("8");
    session.setPlacement(PAGE, "8", { ...s, x: s.x + 40 });
    await session.idle();
    expect(JSON.stringify(shape("12"))).toBe(before);
  });

  it("moving, then undoing, restores the shape and its lines in one step", async () => {
    const before = [shape("4"), shape("12")].map((x) => JSON.stringify(x));
    const s = shape("1");
    session.setPlacement(PAGE, "1", { ...s, x: s.x + 48, y: s.y + 48 });
    await session.idle();
    expect(session.canUndo).toBe(true);
    await session.undo();
    expect([shape("4"), shape("12")].map((x) => JSON.stringify(x))).toEqual(before);
    expect(session.canUndo).toBe(false);
    await session.redo();
    near(verts("12")[0], 192, 240);
  });

  it("a drag is applied repeatedly without lines drifting", async () => {
    const s = shape("1");
    const edit = session.beginTransform(PAGE, "1");
    expect(edit.attachedLines).toBe(2); // the glued connector and the polyline
    for (let i = 1; i <= 6; i++) edit.update({ ...s, x: s.x + i * 8, y: s.y + i * 8 });
    expect(edit.commit("Move")).toBe(true);
    await session.idle();
    near(verts("12")[0], 144 + 48, 192 + 48);
    near(shape("4").connector!.begin.point, 288 + 48, 144 + 48);
  });

  it("a polyline survives save + reopen with the same shape", async () => {
    const s = shape("1");
    session.setPlacement(PAGE, "1", { ...s, x: s.x + 48, y: s.y + 48 });
    const re = (await reopen()).find((x) => x.id === "12")!;
    const now = shape("12");
    expect(lineVertices(re)).toEqual(lineVertices(now));
    expect(re.rotation).toBe(0);
    expect(re.flipX).toBe(false);
  });
});

describe("moving a connector by itself", () => {
  const near = (a: { x: number; y: number }, x: number, y: number) => {
    expect(a.x).toBeCloseTo(x, 3);
    expect(a.y).toBeCloseTo(y, 3);
  };
  const xmlOf = async () => {
    const JSZip = (await import("jszip")).default;
    return (await (await JSZip.loadAsync(await session.save())).file("visio/pages/page1.xml")!.async("string"));
  };

  it("shifts both ends, keeps length and angle, and detaches it", async () => {
    const c0 = shape("4"); // glued from shape 1 (3in, 7in) to shape 2 (4.5in, 7in)
    session.setPlacement(PAGE, "4", { ...c0, x: c0.x + 30, y: c0.y + 20 });
    await session.idle();
    const c = shape("4");
    near(c.connector!.begin.point, 288 + 30, 144 + 20);
    near(c.connector!.end.point, 432 + 30, 144 + 20);
    expect(c.width).toBeCloseTo(c0.width, 6);
    expect(c.rotation).toBeCloseTo(c0.rotation, 6);
    expect(c.connector!.begin.shapeId).toBeUndefined();
    expect(c.connector!.end.shapeId).toBeUndefined();
    // the shapes it was attached to stay where they are
    expect(shape("1").x).toBeCloseTo(96);
    expect(shape("2").x).toBeCloseTo(432);
  });

  it("writes plain end points (no glue formulas), keeps Pin/Width/Angle formulas, drops the Connect records", async () => {
    const c0 = shape("4");
    session.setPlacement(PAGE, "4", { ...c0, x: c0.x + 48, y: c0.y });
    const xml = await xmlOf();
    const conn = xml.match(/<Shape ID="4"[\s\S]*?<\/Shape>/)![0];
    expect(conn).not.toContain("PAR(PNT");
    expect(conn).not.toContain("Sheet.1!");
    expect(conn).toContain('F="(BeginX+EndX)/2"');
    expect(conn).toContain('F="SQRT((EndX-BeginX)^2+(EndY-BeginY)^2)"');
    const v = (n: string) => parseFloat(conn.match(new RegExp(`N="${n}" V="([^"]+)"`))![1]);
    expect(v("BeginX")).toBeCloseTo(3.5, 6);
    expect(v("EndX")).toBeCloseTo(5, 6);
    expect(v("PinX")).toBeCloseTo(4.25, 6);
    expect(v("Width")).toBeCloseTo(1.5, 6);
    expect(xml).not.toContain('FromSheet="4"');
  });

  it("undo brings the glue back exactly: formulas and Connect records", async () => {
    const before = await xmlOf();
    const c0 = shape("4");
    session.setPlacement(PAGE, "4", { ...c0, x: c0.x + 30, y: c0.y + 20 });
    await session.idle();
    await session.undo();
    const c = shape("4");
    expect(c.connector!.begin.shapeId).toBe("1");
    expect(c.connector!.end.shapeId).toBe("2");
    near(c.connector!.begin.point, 288, 144);
    const after = await xmlOf();
    expect(after).toContain('FromSheet="4" FromCell="BeginX"');
    expect(after).toContain('FromSheet="4" FromCell="EndX"');
    expect(after.match(/<Shape ID="4"[\s\S]*?<\/Shape>/)![0]).toBe(before.match(/<Shape ID="4"[\s\S]*?<\/Shape>/)![0]);
    await session.redo();
    expect(shape("4").connector!.begin.shapeId).toBeUndefined();
  });

  it("a live drag does not drift, and is one undo step", async () => {
    const c0 = shape("4");
    const edit = session.beginTransform(PAGE, "4");
    for (let i = 1; i <= 8; i++) edit.update({ ...c0, x: c0.x + i * 5, y: c0.y - i * 3 });
    expect(edit.commit("Move")).toBe(true);
    await session.idle();
    near(shape("4").connector!.begin.point, 288 + 40, 144 - 24);
    await session.undo();
    near(shape("4").connector!.begin.point, 288, 144);
    expect(session.canUndo).toBe(false);
  });

  it("survives save and reopen", async () => {
    const c0 = shape("4");
    session.setPlacement(PAGE, "4", { ...c0, x: c0.x - 20, y: c0.y + 70 });
    const re = (await reopen()).find((x) => x.id === "4")!;
    near(re.connector!.begin.point, 288 - 20, 144 + 70);
    near(re.connector!.end.point, 432 - 20, 144 + 70);
    expect(re.rotation).toBeCloseTo(0, 6);
    expect(re.connector!.begin.shapeId).toBeUndefined();
  });

  it("once moved away, it no longer follows the shape it used to touch", async () => {
    const c0 = shape("4");
    session.setPlacement(PAGE, "4", { ...c0, x: c0.x, y: c0.y + 200 });
    await session.idle();
    const before = JSON.stringify(shape("4"));
    const s1 = shape("1");
    session.setPlacement(PAGE, "1", { ...s1, x: s1.x + 40, y: s1.y + 40 });
    await session.idle();
    expect(JSON.stringify(shape("4"))).toBe(before);
  });

  it("the arrow keys move a connector too", async () => {
    const c0 = shape("4");
    session.setPlacement(PAGE, "4", { ...c0, x: c0.x + 10 }, "Nudge", "nudge:4");
    await session.idle(); // the key handler waits like this before reading the shape again
    session.setPlacement(PAGE, "4", { ...shape("4"), x: shape("4").x + 10 }, "Nudge", "nudge:4");
    await session.idle();
    near(shape("4").connector!.begin.point, 288 + 20, 144);
    await session.undo();
    near(shape("4").connector!.begin.point, 288, 144);
  });
});

describe("text on connectors and lines", () => {
  it("adds a label to a connector, centred on the line, and it stays a connector", async () => {
    session.setText(PAGE, "4", "", "TCP 443");
    await session.idle();
    const c = shape("4");
    expect(c.type).toBe("connector");
    expect(c.text).toBe("TCP 443");
    const tb = c.textBlock!;
    const m = placementMatrix(c);
    const [cx, cy] = [
      m[0] * (tb.x + tb.width / 2) + m[2] * (tb.y + tb.height / 2) + m[4],
      m[1] * (tb.x + tb.width / 2) + m[3] * (tb.y + tb.height / 2) + m[5],
    ];
    expect(cx).toBeCloseTo(360, 3); // midpoint of (288,144) and (432,144)
    expect(cy).toBeCloseTo(144, 3);
    const re = (await reopen()).find((x) => x.id === "4")!;
    expect(re.text).toBe("TCP 443");
    expect(re.type).toBe("connector");
  });

  it("the label travels with the connector when it is moved", async () => {
    session.setText(PAGE, "4", "", "TCP 443");
    await session.idle();
    const c0 = shape("4");
    session.setPlacement(PAGE, "4", { ...c0, x: c0.x + 60, y: c0.y + 30 });
    await session.idle();
    const c = shape("4");
    expect(c.text).toBe("TCP 443");
    const tb = c.textBlock!;
    const m = placementMatrix(c);
    expect(m[0] * (tb.x + tb.width / 2) + m[2] * (tb.y + tb.height / 2) + m[4]).toBeCloseTo(360 + 60, 3);
    expect(m[1] * (tb.x + tb.width / 2) + m[3] * (tb.y + tb.height / 2) + m[5]).toBeCloseTo(144 + 30, 3);
  });

  it("edits the text of a polyline", async () => {
    session.setText(PAGE, "12", "", "uplink");
    await session.idle();
    expect(shape("12").text).toBe("uplink");
    expect((await reopen()).find((x) => x.id === "12")!.text).toBe("uplink");
    session.setText(PAGE, "12", "uplink", "uplink 2");
    await session.idle();
    expect(shape("12").text).toBe("uplink 2");
  });

  it("an existing label on a connector keeps its formatting when edited", async () => {
    session.setText(PAGE, "4", "", "abc");
    await session.idle();
    session.setText(PAGE, "4", "abc", "abcd");
    await session.idle();
    expect(shape("4").text).toBe("abcd");
    expect(shape("4").textRuns).toHaveLength(1);
  });
});

describe("moving a box takes its contents and their lines along", () => {
  // Zone 14 (frame x 48..768, y -...): contains shapes 1, 2 and the connector 4 between them.
  const near = (a: { x: number; y: number }, x: number, y: number) => {
    expect(a.x).toBeCloseTo(x, 3);
    expect(a.y).toBeCloseTo(y, 3);
  };
  const json = (id: string) => JSON.stringify(shape(id));
  const OUTSIDE = ["3", "5", "6", "7", "8", "9", "10", "11", "13"];
  const move14 = (dx: number, dy: number) => {
    const z = shape("14");
    session.setPlacement(PAGE, "14", { ...z, x: z.x + dx, y: z.y + dy });
  };

  it("carries the shapes inside it by the same amount", async () => {
    const [b1, b2] = [shape("1"), shape("2")];
    move14(48, 48);
    await session.idle();
    expect([shape("1").x - b1.x, shape("1").y - b1.y]).toEqual([48, 48].map((v) => expect.closeTo(v, 4)));
    expect([shape("2").x - b2.x, shape("2").y - b2.y]).toEqual([48, 48].map((v) => expect.closeTo(v, 4)));
    // the box itself: frame was at x=48, y=38.4 (PinX 4.25in - half of 7.5in; PinY 7.1in with a 2in height)
    near(shape("14"), 48 + 48, 38.4 + 48);
  });

  it("leaves everything outside the box where it was", async () => {
    const before = OUTSIDE.map(json);
    move14(48, 48);
    await session.idle();
    expect(OUTSIDE.map(json)).toEqual(before);
  });

  it("moves a connector between two carried shapes as a whole and keeps it glued", async () => {
    move14(48, 48);
    await session.idle();
    const c = shape("4");
    near(c.connector!.begin.point, 288 + 48, 144 + 48);
    near(c.connector!.end.point, 432 + 48, 144 + 48);
    expect(c.connector!.begin.shapeId).toBe("1");
    expect(c.connector!.end.shapeId).toBe("2");
    const JSZip = (await import("jszip")).default;
    const xml = await (await JSZip.loadAsync(await session.save())).file("visio/pages/page1.xml")!.async("string");
    expect(xml).toContain('FromSheet="4" FromCell="BeginX"');
    expect(xml.match(/<Shape ID="4"[\s\S]*?<\/Shape>/)![0]).toContain("PAR(PNT(Sheet.1!Connections.X2");
  });

  it("a line that leaves the box follows only the end that is inside it", async () => {
    move14(48, 48);
    await session.idle();
    const v = lineVertices(shape("12"))!;
    near(v[0], 192, 240); // started on shape 1's bottom edge: carried
    near(v[1], 192, 259.2); // neighbour follows in x, stays orthogonal
    near(v[2], 240, 259.2);
    near(v[3], 240, 326.4); // ends on shape 3, which did not move
  });

  it("is one undo step that puts back the box, its contents, the connector and the line", async () => {
    const ids = ["14", "1", "2", "4", "12"];
    const before = ids.map(json);
    move14(48, 48);
    await session.idle();
    expect(ids.map(json)).not.toEqual(before);
    await session.undo();
    expect(ids.map(json)).toEqual(before);
    expect(session.canUndo).toBe(false);
    await session.redo();
    near(lineVertices(shape("12"))![0], 192, 240); // the redo applies the same move again
  });

  it("only the moved box, its contents and the lines that follow change in the saved file", async () => {
    const JSZip = (await import("jszip")).default;
    const a = await (await JSZip.loadAsync(await buildSampleVsdx())).file("visio/pages/page1.xml")!.async("string");
    move14(48, 48);
    const b = await (await JSZip.loadAsync(await session.save())).file("visio/pages/page1.xml")!.async("string");
    const whole = (xml: string, id: string) => xml.match(new RegExp(`<Shape ID="${id}"[\\s\\S]*?</Shape>`))![0];
    for (const id of ["3", "8", "9", "10", "11", "13"]) expect(b).toContain(whole(a, id));
    for (const id of ["14", "1", "2", "4", "12"]) expect(b).not.toContain(whole(a, id));
  });

  it("resizing or turning the box does not move what is inside it", async () => {
    const z = shape("14");
    const before = ["1", "2", "4"].map(json);
    session.setPlacement(PAGE, "14", { ...z, width: z.width + 96 });
    await session.idle();
    expect(["1", "2", "4"].map(json)).toEqual(before);
    session.setPlacement(PAGE, "14", { ...shape("14"), rotation: 20 });
    await session.idle();
    expect(["1", "2", "4"].map(json)).toEqual(before);
  });

  it("a live drag reports what it carries and does not drift", async () => {
    const z = shape("14");
    const b1 = shape("1");
    const edit = session.beginTransform(PAGE, "14");
    expect(edit.carried).toBe(3); // shape 1, shape 2 and the connector
    for (let i = 1; i <= 6; i++) edit.update({ ...z, x: z.x + i * 8, y: z.y + i * 4 });
    edit.commit("Move");
    await session.idle();
    expect(shape("1").x).toBeCloseTo(b1.x + 48, 4);
    expect(shape("1").y).toBeCloseTo(b1.y + 24, 4);
    near(shape("4").connector!.begin.point, 288 + 48, 144 + 24);
  });

  it("moving a shape that is inside the box moves only that shape", async () => {
    const z = json("14");
    const b2 = json("2");
    const s1 = shape("1");
    session.setPlacement(PAGE, "1", { ...s1, x: s1.x + 24 });
    await session.idle();
    expect(json("14")).toBe(z);
    expect(json("2")).toBe(b2);
  });

  it("survives save + reopen", async () => {
    move14(60, -30);
    const re = await reopen();
    const at = (id: string) => re.find((x) => x.id === id)!;
    expect(at("1").x).toBeCloseTo(96 + 60, 4);
    expect(at("1").y).toBeCloseTo(96 - 30, 4);
    expect(at("4").connector!.begin.shapeId).toBe("1");
  });
});

describe("connectors: create, route, reconnect", () => {
  const near = (a: { x: number; y: number }, x: number, y: number) => {
    expect(a.x).toBeCloseTo(x, 3);
    expect(a.y).toBeCloseTo(y, 3);
  };
  const orthogonal = (v: { x: number; y: number }[]) =>
    v.slice(1).every((p, i) => Math.min(Math.abs(p.x - v[i].x), Math.abs(p.y - v[i].y)) < 1e-6);
  const verts = (id: string) => lineVertices(shape(id))!;
  const crossesRect = (v: { x: number; y: number }[], r: { x: number; y: number; width: number; height: number }) =>
    v.slice(1).some((b, i) => {
      const a = v[i];
      return (
        Math.max(a.x, b.x) > r.x + 1e-6 &&
        Math.min(a.x, b.x) < r.x + r.width - 1e-6 &&
        Math.max(a.y, b.y) > r.y + 1e-6 &&
        Math.min(a.y, b.y) < r.y + r.height - 1e-6
      );
    });
  const frame = (id: string) => ({ x: shape(id).x, y: shape(id).y, width: shape(id).width, height: shape(id).height });
  const xml = async () => {
    const JSZip = (await import("jszip")).default;
    return (await JSZip.loadAsync(await session.save())).file("visio/pages/page1.xml")!.async("string");
  };

  it("creates an elbow connector glued to both shapes, leaving and entering through their sides", async () => {
    // Shape 1 (Start) is above shape 3 (Decision): bottom of one to the top of the other.
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    const c = shape(id);
    expect(c.type).toBe("connector");
    expect(c.connector!.begin.shapeId).toBe("1");
    expect(c.connector!.end.shapeId).toBe("3");
    expect(c.connector!.route).toMatchObject({ style: "elbow", beginSide: "S", endSide: "N" });
    expect(c.style.endArrow).toBe(5);
    near(c.connector!.begin.point, 192, 192); // middle of shape 1's bottom edge
    near(c.connector!.end.point, 192, 326.4); // middle of shape 3's top edge
    expect(session.isEditable(PAGE, id)).toBe(true);
  });

  it("routes around a shape that is in the way", async () => {
    // Shape 3 sits between shape 1 and shape 9 (all share the same column).
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "9", side: "N" }, "elbow");
    const v = verts(id);
    expect(orthogonal(v)).toBe(true);
    expect(v.length).toBeGreaterThan(2);
    const f3 = frame("3");
    const inflated = { x: f3.x - 8, y: f3.y - 8, width: f3.width + 16, height: f3.height + 16 };
    expect(crossesRect(v, inflated)).toBe(false);
    near(v[0], 192, 192);
    near(v[v.length - 1], 192, 576);
  });

  it("is not blocked by a zone outline that merely contains both shapes", async () => {
    // Zone 14 has no fill and no text: connectors run inside it.
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "E" }, { shapeId: "2", side: "W" }, "elbow");
    expect(verts(id)).toHaveLength(2); // a straight line: the zone is not an obstacle
  });

  it("can create a straight connector, or one that ends in empty space", async () => {
    const straight = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "straight");
    expect(verts(straight)).toHaveLength(2);
    expect(shape(straight).connector!.route!.style).toBe("straight");

    const free = await session.createConnector(PAGE, { shapeId: "8", side: "E" }, { point: { x: 800, y: 600 } }, "elbow");
    const c = shape(free);
    expect(c.connector!.begin.shapeId).toBe("8");
    expect(c.connector!.end.shapeId).toBeUndefined();
    near(c.connector!.end.point, 800, 600);
  });

  it("writes a proper 1-D shape: formulas for Pin/Width/Angle, glue records and routing metadata", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    const x = await xml();
    const conn = x.match(new RegExp(`<Shape ID="${id}"[\\s\\S]*?</Shape>`))![0];
    expect(conn).toContain('F="(BeginX+EndX)/2"');
    expect(conn).toContain('F="SQRT((EndX-BeginX)^2+(EndY-BeginY)^2)"');
    expect(conn).toContain('F="ATAN2(EndY-BeginY,EndX-BeginX)"');
    expect(conn).toMatch(/<Cell N="EndArrow" V="5"\/>/);
    expect(conn).toContain('<Row N="vsdxStyle"><Cell N="Value" V="1"/></Row>');
    expect(x).toContain(`<Connect FromSheet="${id}" FromCell="BeginX" FromPart="9" ToSheet="1" ToCell="PinX" ToPart="3"/>`);
    expect(x).toContain(`<Connect FromSheet="${id}" FromCell="EndX" FromPart="12" ToSheet="3" ToCell="PinX" ToPart="3"/>`);
  });

  it("survives save + reopen with glue, route style and sides", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    const before = verts(id);
    const re = (await reopen()).find((s) => s.id === id)!;
    expect(re.connector!.begin.shapeId).toBe("1");
    expect(re.connector!.end.shapeId).toBe("3");
    expect(re.connector!.route).toMatchObject({ style: "elbow", beginSide: "S", endSide: "N" });
    const rv = lineVertices(re)!;
    expect(rv).toHaveLength(before.length);
    rv.forEach((p, i) => near(p, before[i].x, before[i].y));
  });

  it("undo removes the connector and its glue", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    await session.undo();
    expect(session.document.pages[0].shapes.find((s) => s.id === id)).toBeUndefined();
    expect(await xml()).not.toContain(`FromSheet="${id}"`);
  });

  it("re-routes when a glued shape moves: it keeps its sides and stays orthogonal", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    const s3 = shape("3");
    session.setPlacement(PAGE, "3", { ...s3, x: s3.x + 300, y: s3.y + 100 });
    await session.idle();
    const c = shape(id);
    expect(c.connector!.begin.shapeId).toBe("1");
    expect(c.connector!.end.shapeId).toBe("3");
    const v = verts(id);
    expect(orthogonal(v)).toBe(true);
    near(v[0], 192, 192); // still the middle of shape 1's bottom edge
    near(v[v.length - 1], 192 + 300, 326.4 + 100); // the middle of shape 3's top edge, where it now is
    expect(crossesRect(v, frame("3"))).toBe(false);
  });

  it("re-routes when a glued shape is resized: the port moves with the side", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    const s1 = shape("1");
    session.setPlacement(PAGE, "1", { ...s1, height: s1.height + 48 });
    await session.idle();
    near(verts(id)[0], 192, 192 + 48);
  });

  it("re-routes for a connector that was already in the file, from its own glue", async () => {
    // Connector 4 starts glued from shape 1 to shape 2.
    const s2 = shape("2");
    session.setPlacement(PAGE, "2", { ...s2, y: s2.y + 200 });
    await session.idle();
    const c = shape("4");
    expect(c.connector!.begin.shapeId).toBe("1");
    expect(c.connector!.end.shapeId).toBe("2");
    near(c.connector!.begin.point, 288, 144); // unchanged: shape 1 did not move
    const end = c.connector!.end.point;
    expect(end.x).toBeCloseTo(432, 3); // west port of shape 2
    expect(end.y).toBeCloseTo(144 + 200, 3);
  });

  it("a live drag re-routes every frame without drifting, in one undo step", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    const s3 = shape("3");
    const before = JSON.stringify(shape(id));
    const edit = session.beginTransform(PAGE, "3");
    for (let i = 1; i <= 8; i++) edit.update({ ...s3, x: s3.x + i * 20, y: s3.y + i * 10 });
    edit.commit("Move");
    await session.idle();
    near(verts(id).at(-1)!, 192 + 160, 326.4 + 80);
    await session.undo();
    expect(JSON.stringify(shape(id))).toBe(before);
  });

  it("moves one end to another shape, re-routes, and updates the glue", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    session.reconnectEnd(PAGE, id, "end", { shapeId: "9", side: "N" });
    await session.idle();
    const c = shape(id);
    expect(c.connector!.begin.shapeId).toBe("1");
    expect(c.connector!.end.shapeId).toBe("9");
    near(verts(id).at(-1)!, 192, 576);
    const x = await xml();
    expect(x).toContain(`<Connect FromSheet="${id}" FromCell="EndX" FromPart="12" ToSheet="9"`);
    expect(x).not.toContain(`FromSheet="${id}" FromCell="EndX" FromPart="12" ToSheet="3"`);
  });

  it("dropping an end in empty space detaches it", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    session.reconnectEnd(PAGE, id, "end", { point: { x: 700, y: 700 } });
    await session.idle();
    const c = shape(id);
    expect(c.connector!.end.shapeId).toBeUndefined();
    near(c.connector!.end.point, 700, 700);
    expect(c.connector!.begin.shapeId).toBe("1");
    expect(await xml()).not.toContain(`FromSheet="${id}" FromCell="EndX"`);
  });

  it("reconnecting a connector that came with Visio glue replaces its glue formulas", async () => {
    session.reconnectEnd(PAGE, "4", "end", { shapeId: "3", side: "N" });
    await session.idle();
    expect(shape("4").connector!.end.shapeId).toBe("3");
    const conn = (await xml()).match(/<Shape ID="4"[\s\S]*?<\/Shape>/)![0];
    expect(conn).not.toContain("Sheet.2!"); // the formulas that pointed at shape 2 are gone
    expect(conn).toContain("Sheet.1!"); // the begin end is still glued to shape 1
  });

  it("undo puts a reconnected end back, glue and all", async () => {
    const before = JSON.stringify(shape("4"));
    const x0 = (await xml()).match(/<Shape ID="4"[\s\S]*?<\/Shape>/)![0];
    session.reconnectEnd(PAGE, "4", "end", { shapeId: "3", side: "N" });
    await session.idle();
    await session.undo();
    expect(JSON.stringify(shape("4"))).toBe(before);
    expect((await xml()).match(/<Shape ID="4"[\s\S]*?<\/Shape>/)![0]).toBe(x0);
  });

  it("switches between straight and elbow", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "9", side: "N" }, "elbow");
    expect(verts(id).length).toBeGreaterThan(2);
    session.setConnectorStyle(PAGE, id, { style: "straight" });
    await session.idle();
    expect(verts(id)).toHaveLength(2);
    expect(shape(id).connector!.route!.style).toBe("straight");
    session.setConnectorStyle(PAGE, id, { style: "elbow" });
    await session.idle();
    expect(verts(id).length).toBeGreaterThan(2);
    expect(orthogonal(verts(id))).toBe(true);
    expect(shape(id).connector!.begin.shapeId).toBe("1"); // glue is untouched
  });

  it("turns arrow heads on and off at either end", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    session.setConnectorStyle(PAGE, id, { endArrow: false, beginArrow: true });
    await session.idle();
    expect(shape(id).style.endArrow).toBeUndefined();
    expect(shape(id).style.beginArrow).toBe(5);
    session.setConnectorStyle(PAGE, id, { beginArrow: false, endArrow: true });
    await session.idle();
    expect(shape(id).style.beginArrow).toBeUndefined();
    expect(shape(id).style.endArrow).toBe(5);
  });

  it("only changes the new connector, the shapes it touches and its glue in the saved file", async () => {
    const JSZip = (await import("jszip")).default;
    const a = await (await JSZip.loadAsync(await buildSampleVsdx())).file("visio/pages/page1.xml")!.async("string");
    await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    const b = await xml();
    const whole = (x: string, id: string) => x.match(new RegExp(`<Shape ID="${id}"[\\s\\S]*?</Shape>`))![0];
    for (const id of ["1", "2", "3", "4", "5", "8", "9", "10", "11", "12", "13", "14"]) expect(b).toContain(whole(a, id));
  });
});

describe("confirmed connections (for the diagram analysis)", () => {
  it("are kept on the line, survive save + reopen, and undo", async () => {
    session.setLineLinks(PAGE, "12", { begin: ["1"], end: ["3", "9"] });
    await session.idle();
    expect(shape("12").links).toEqual({ begin: ["1"], end: ["3", "9"] });
    const re = (await reopen()).find((x) => x.id === "12")!;
    expect(re.links).toEqual({ begin: ["1"], end: ["3", "9"] });

    await session.undo();
    expect(shape("12").links).toBeUndefined();
  });

  it("are written as plain numbers in user-defined rows, and can be cleared", async () => {
    const JSZip = (await import("jszip")).default;
    const xml = async () =>
      (await (await JSZip.loadAsync(await session.save())).file("visio/pages/page1.xml")!.async("string")).match(/<Shape ID="12"[\s\S]*?<\/Shape>/)![0];
    session.setLineLinks(PAGE, "12", { begin: ["1"], end: ["3"] });
    const written = await xml();
    expect(written).toContain('<Row N="vsdxLinkBegin1"><Cell N="Value" V="1"/></Row>');
    expect(written).toContain('<Row N="vsdxLinkEnd1"><Cell N="Value" V="3"/></Row>');

    session.setLineLinks(PAGE, "12", {});
    await session.idle();
    expect(shape("12").links).toBeUndefined();
    expect(await xml()).not.toContain("vsdxLink");
    expect(await xml()).not.toContain('<Section N="User">'); // the empty section is removed too
  });

  it("do not disturb a connector's routing settings", async () => {
    const id = await session.createConnector(PAGE, { shapeId: "1", side: "S" }, { shapeId: "3", side: "N" }, "elbow");
    session.setLineLinks(PAGE, id, { begin: ["1"], end: ["3"] });
    await session.idle();
    const c = shape(id);
    expect(c.links).toEqual({ begin: ["1"], end: ["3"] });
    expect(c.connector!.route).toMatchObject({ style: "elbow", beginSide: "S", endSide: "N" });
    session.setLineLinks(PAGE, id, {});
    await session.idle();
    expect(shape(id).connector!.route).toMatchObject({ style: "elbow", beginSide: "S", endSide: "N" });
  });

  it("touch nothing else in the saved file", async () => {
    const JSZip = (await import("jszip")).default;
    const a = await (await JSZip.loadAsync(await buildSampleVsdx())).file("visio/pages/page1.xml")!.async("string");
    session.setLineLinks(PAGE, "12", { begin: ["1"], end: ["3"] });
    const b = await (await JSZip.loadAsync(await session.save())).file("visio/pages/page1.xml")!.async("string");
    const whole = (x: string, id: string) => x.match(new RegExp(`<Shape ID="${id}"[\\s\\S]*?</Shape>`))![0];
    for (const id of ["1", "2", "3", "4", "5", "8", "9", "10", "11", "13", "14"]) expect(b).toContain(whole(a, id));
  });
});

describe("high-availability groups (for the diagram analysis)", () => {
  it("are kept on the node shapes, survive save + reopen, and undo", async () => {
    session.setHaGroups(PAGE, [{ id: "1", group: 1 }, { id: "3", group: 1 }]);
    await session.idle();
    expect(shape("1").ha).toBe(1);
    expect(shape("3").ha).toBe(1);
    const re = await reopen();
    expect(re.find((x) => x.id === "1")!.ha).toBe(1);
    expect(re.find((x) => x.id === "3")!.ha).toBe(1);

    session.setHaGroups(PAGE, [{ id: "1" }]);
    await session.idle();
    expect(shape("1").ha).toBeUndefined();
    expect(shape("3").ha).toBe(1);

    await session.undo();
    await session.undo();
    expect(shape("3").ha).toBeUndefined();
  });

  it("are one plain number in a user-defined row, which is removed again", async () => {
    const JSZip = (await import("jszip")).default;
    const xml = async () =>
      (await (await JSZip.loadAsync(await session.save())).file("visio/pages/page1.xml")!.async("string")).match(/<Shape ID="3"[\s\S]*?<\/Shape>/)![0];
    session.setHaGroups(PAGE, [{ id: "3", group: 2 }]);
    expect(await xml()).toContain('<Row N="vsdxHaGroup"><Cell N="Value" V="2"/></Row>');
    session.setHaGroups(PAGE, [{ id: "3" }]);
    await session.idle();
    expect(await xml()).not.toContain("vsdxHaGroup");
  });
});

describe("tidy lines", () => {
  it("gives lines new routes in one undo step, and the file reopens with them", async () => {
    const before12 = lineVertices(shape("12"))!;
    const before4 = lineVertices(shape("4"))!;
    const p12 = before12.map((p, i) => (i > 0 && i < before12.length - 1 ? { x: p.x + 7.5, y: p.y } : p));
    session.tidyLines(PAGE, [{ id: "12", points: p12 }]);
    await session.idle();
    expect(lineVertices(shape("12"))!.map((p) => [Math.round(p.x * 10), Math.round(p.y * 10)])).toEqual(
      p12.map((p) => [Math.round(p.x * 10), Math.round(p.y * 10)]),
    );
    expect(lineVertices(shape("4"))).toEqual(before4); // untouched
    const re = await reopen();
    expect(lineVertices(re.find((x) => x.id === "12")!)!.map((p) => Math.round(p.x))).toEqual(p12.map((p) => Math.round(p.x)));

    await session.undo();
    expect(lineVertices(shape("12"))!.map((p) => Math.round(p.x))).toEqual(before12.map((p) => Math.round(p.x)));
  });

  it("changes several lines as one step", async () => {
    const a = lineVertices(shape("12"))!;
    const b = lineVertices(shape("4"))!;
    const shift = (pts: { x: number; y: number }[]) => pts.map((p, i) => (i > 0 && i < pts.length - 1 ? { x: p.x, y: p.y + 5 } : p));
    session.tidyLines(PAGE, [{ id: "12", points: shift(a) }, { id: "4", points: shift(b) }]);
    await session.idle();
    await session.undo();
    expect(lineVertices(shape("12"))!.map((p) => Math.round(p.y))).toEqual(a.map((p) => Math.round(p.y)));
    expect(lineVertices(shape("4"))!.map((p) => Math.round(p.y))).toEqual(b.map((p) => Math.round(p.y)));
  });
});

describe("moving the end of a plain line", () => {
  it("moves the end, keeps the line square and undoes", async () => {
    const before = lineVertices(shape("12"))!;
    const last = before[before.length - 1];
    session.moveLineEnd(PAGE, "12", "end", { x: last.x + 30, y: last.y + 20 });
    await session.idle();
    const v = lineVertices(shape("12"))!;
    expect(v[v.length - 1].x).toBeCloseTo(last.x + 30, 0);
    expect(v[v.length - 1].y).toBeCloseTo(last.y + 20, 0);
    expect(v[0].x).toBeCloseTo(before[0].x, 3);
    expect(v[0].y).toBeCloseTo(before[0].y, 3);
    const re = lineVertices((await reopen()).find((x) => x.id === "12")!)!;
    expect(re[re.length - 1].x).toBeCloseTo(last.x + 30, 0);
    await session.undo();
    expect(lineVertices(shape("12"))!.length).toBe(before.length);
    expect(lineVertices(shape("12"))![before.length - 1].x).toBeCloseTo(last.x, 0);
  });
});

describe("reshaping a line", () => {
  it("gives a line a new route as one undo step", async () => {
    const before = lineVertices(shape("12"))!;
    const bent = [before[0], { x: (before[0].x + before[before.length - 1].x) / 2, y: before[0].y - 40 }, before[before.length - 1]];
    session.setLinePoints(PAGE, "12", bent);
    await session.idle();
    expect(lineVertices(shape("12"))!.length).toBe(3);
    expect((await reopen()).find((x) => x.id === "12")!.id).toBe("12");
    await session.undo();
    expect(lineVertices(shape("12"))!.length).toBe(before.length);
  });
});
