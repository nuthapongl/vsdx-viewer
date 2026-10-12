import type { Cell, Row, Section, ShapeData } from "./types";

/** Parse XML text; throws a readable error on malformed input. */
export function parseXml(text: string, what: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) {
    throw new Error(`Could not parse ${what}: ${err.textContent?.slice(0, 200)}`);
  }
  return doc;
}

/** Direct child elements by local name (namespace-agnostic). */
export function children(el: Element, localName?: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (!localName || c.localName === localName) out.push(c);
  }
  return out;
}

export function child(el: Element, localName: string): Element | undefined {
  for (let i = 0; i < el.children.length; i++) {
    if (el.children[i].localName === localName) return el.children[i];
  }
  return undefined;
}

/** Attribute lookup that ignores the namespace prefix (`r:id` -> `id`). */
export function attr(el: Element, name: string): string | undefined {
  const direct = el.getAttribute(name);
  if (direct !== null) return direct;
  for (let i = 0; i < el.attributes.length; i++) {
    if (el.attributes[i].localName === name) return el.attributes[i].value;
  }
  return undefined;
}

function readCell(el: Element): Cell {
  return {
    v: el.getAttribute("V") ?? "",
    f: el.getAttribute("F") ?? undefined,
    u: el.getAttribute("U") ?? undefined,
  };
}

function readCells(el: Element, into = new Map<string, Cell>()): Map<string, Cell> {
  for (const c of children(el, "Cell")) {
    const n = c.getAttribute("N");
    if (n) into.set(n, readCell(c));
  }
  return into;
}

function sectionKey(name: string, ix: string): string {
  return name === "Geometry" ? `${name}#${ix}` : name;
}

function readRow(el: Element, fallbackIx: string): Row {
  return {
    name: el.getAttribute("N") ?? undefined,
    type: el.getAttribute("T") ?? "",
    ix: el.getAttribute("IX") ?? fallbackIx,
    deleted: el.getAttribute("Del") === "1",
    cells: readCells(el),
  };
}

function readSection(el: Element): Section {
  const name = el.getAttribute("N") ?? "";
  const ix = el.getAttribute("IX") ?? "0";
  const rows = new Map<string, Row>();
  let n = 0;
  for (const r of children(el, "Row")) {
    const row = readRow(r, String(n));
    rows.set(row.ix, row);
    n++;
  }
  return { name, ix, cells: readCells(el), rows };
}

/** Read the cells and sections that belong directly to a `<Shape>`/`<StyleSheet>`. */
export function readShapeData(el: Element): ShapeData {
  const data: ShapeData = { cells: readCells(el), sections: new Map() };
  for (const s of children(el, "Section")) {
    const sec = readSection(s);
    data.sections.set(sectionKey(sec.name, sec.ix), sec);
  }
  return data;
}

function markInherited(c: Cell): Cell {
  return { ...c, inherited: true };
}

function mergeCells(base: Map<string, Cell>, over: Map<string, Cell>): Map<string, Cell> {
  const out = new Map<string, Cell>();
  for (const [k, v] of base) out.set(k, markInherited(v));
  for (const [k, v] of over) out.set(k, v);
  return out;
}

function mergeRows(base: Map<string, Row>, over: Map<string, Row>): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const [k, r] of base) {
    out.set(k, { ...r, cells: mergeCells(r.cells, new Map()) });
  }
  for (const [k, r] of over) {
    const b = out.get(k);
    if (r.deleted) {
      out.delete(k);
    } else if (b) {
      out.set(k, { name: r.name ?? b.name, type: r.type || b.type, ix: r.ix, cells: mergeCells(b.cells, r.cells) });
    } else {
      out.set(k, r);
    }
  }
  return out;
}

/** Layer `over` on top of `base` (cells and rows in `base` are flagged inherited). */
export function mergeShapeData(base: ShapeData, over: ShapeData): ShapeData {
  const sections = new Map<string, Section>();
  for (const [k, s] of base.sections) {
    sections.set(k, {
      ...s,
      cells: mergeCells(s.cells, new Map()),
      rows: mergeRows(s.rows, new Map()),
    });
  }
  for (const [k, s] of over.sections) {
    const b = sections.get(k);
    sections.set(
      k,
      b
        ? {
            name: s.name,
            ix: s.ix,
            cells: mergeCells(b.cells, s.cells),
            rows: mergeRows(b.rows, s.rows),
          }
        : s,
    );
  }
  return { cells: mergeCells(base.cells, over.cells), sections };
}
