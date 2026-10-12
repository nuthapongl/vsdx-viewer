import type { DiagramDocument, DiagramPage } from "../model/types";
import { PX_PER_INCH } from "./coordinateTransform";
import type { Relationship, VsdxPackage } from "./package";
import { relId } from "./package";
import { parsePage } from "./parsePage";
import { parseTheme, type ThemeInfo } from "./theme";
import type { DocumentContext, MasterInfo, PageInfo, ShapeRef, StyleSheet } from "./types";
import { child, children, readShapeData } from "./xml";

const REL_DOCUMENT = "/relationships/document";
const REL_PAGES = "/relationships/pages";
const REL_MASTERS = "/relationships/masters";
const REL_THEME = "/relationships/theme";

const DEFAULT_PAGE_WIDTH_IN = 11;
const DEFAULT_PAGE_HEIGHT_IN = 8.5;

function findByType(rels: Map<string, Relationship>, suffix: string): Relationship | undefined {
  for (const r of rels.values()) if (r.type.endsWith(suffix)) return r;
  return undefined;
}

async function locateDocumentPart(pkg: VsdxPackage): Promise<string> {
  const rootRels = await pkg.relationships("");
  const rel = findByType(rootRels, REL_DOCUMENT);
  if (rel && pkg.has(rel.target)) return rel.target;
  if (pkg.has("visio/document.xml")) return "visio/document.xml";
  throw new Error(
    "No Visio document found in this package (missing visio/document.xml). Is it really a .vsdx file? Legacy .vsd files are not supported.",
  );
}

async function loadTheme(pkg: VsdxPackage, docRels: Map<string, Relationship>): Promise<ThemeInfo | undefined> {
  const rel = findByType(docRels, REL_THEME);
  const path = rel && pkg.has(rel.target) ? rel.target : pkg.has("visio/theme/theme1.xml") ? "visio/theme/theme1.xml" : undefined;
  if (!path) return undefined;
  try {
    return parseTheme(await pkg.readXml(path));
  } catch {
    return undefined; // the shapes just keep the plain colours they carry
  }
}

function parseStyleSheets(docRoot: Element): Map<string, StyleSheet> {
  const out = new Map<string, StyleSheet>();
  const sheets = child(docRoot, "StyleSheets");
  if (!sheets) return out;
  for (const s of children(sheets, "StyleSheet")) {
    const id = s.getAttribute("ID");
    if (id === null) continue;
    out.set(id, {
      id,
      lineStyle: s.getAttribute("LineStyle") ?? undefined,
      fillStyle: s.getAttribute("FillStyle") ?? undefined,
      textStyle: s.getAttribute("TextStyle") ?? undefined,
      data: readShapeData(s),
    });
  }
  return out;
}

function parseFonts(docRoot: Element): Map<string, string> {
  const out = new Map<string, string>();
  const faces = child(docRoot, "FaceNames");
  if (!faces) return out;
  for (const f of children(faces, "FaceName")) {
    const id = f.getAttribute("ID");
    const name = f.getAttribute("Name") ?? f.getAttribute("NameU");
    if (id !== null && name) out.set(id, name);
  }
  return out;
}

async function parseMasters(
  pkg: VsdxPackage,
  docRels: Map<string, Relationship>,
  warnings: string[],
): Promise<Map<string, MasterInfo>> {
  const out = new Map<string, MasterInfo>();
  const indexRel = findByType(docRels, REL_MASTERS);
  if (!indexRel || !pkg.has(indexRel.target)) return out;

  const index = (await pkg.readXml(indexRel.target)).documentElement;
  const indexRels = await pkg.relationships(indexRel.target);
  for (const m of children(index, "Master")) {
    const id = m.getAttribute("ID");
    const rid = child(m, "Rel") ? relId(child(m, "Rel")!) : undefined;
    const rel = rid ? indexRels.get(rid) : undefined;
    if (id === null || !rel || !pkg.has(rel.target)) continue;
    try {
      const root = (await pkg.readXml(rel.target)).documentElement;
      const allShapes = new Map<string, Element>();
      for (const s of Array.from(root.getElementsByTagNameNS("*", "Shape"))) {
        const sid = s.getAttribute("ID");
        if (sid !== null) allShapes.set(sid, s);
      }
      const shapesEl = child(root, "Shapes");
      out.set(id, {
        id,
        name: m.getAttribute("NameU") ?? m.getAttribute("Name") ?? id,
        allShapes,
        topLevel: shapesEl ? children(shapesEl, "Shape") : [],
        rels: await pkg.relationships(rel.target),
      });
    } catch (e) {
      warnings.push(`Master ${id}: ${(e as Error).message}`);
    }
  }
  return out;
}

async function parsePageIndex(
  pkg: VsdxPackage,
  docRels: Map<string, Relationship>,
): Promise<PageInfo[]> {
  const rel = findByType(docRels, REL_PAGES);
  if (!rel || !pkg.has(rel.target)) {
    throw new Error("This Visio file has no pages part (visio/pages/pages.xml).");
  }
  const index = (await pkg.readXml(rel.target)).documentElement;
  const rels = await pkg.relationships(rel.target);

  const pages: PageInfo[] = [];
  for (const p of children(index, "Page")) {
    const id = p.getAttribute("ID");
    const rid = child(p, "Rel") ? relId(child(p, "Rel")!) : undefined;
    const pageRel = rid ? rels.get(rid) : undefined;
    if (id === null || !pageRel) continue;

    const sheet = child(p, "PageSheet");
    const cells = sheet ? readShapeData(sheet).cells : new Map();
    const num = (n: string, d: number) => {
      const v = parseFloat(cells.get(n)?.v ?? "");
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    pages.push({
      id,
      name: p.getAttribute("Name") ?? p.getAttribute("NameU") ?? `Page ${id}`,
      path: pageRel.target,
      background: p.getAttribute("Background") === "1",
      backPageId: p.getAttribute("BackPage") ?? undefined,
      width: num("PageWidth", DEFAULT_PAGE_WIDTH_IN),
      height: num("PageHeight", DEFAULT_PAGE_HEIGHT_IN),
    });
  }
  return pages;
}

export interface ParsedDocument {
  document: DiagramDocument;
  /** Needed later to re-parse edited pages. */
  ctx: DocumentContext;
  infos: Map<string, PageInfo>;
  /** Per foreground page: shape id -> source XML. */
  registries: Map<string, Map<string, ShapeRef>>;
}

/** Read the document-level parts of a package and parse every foreground page. */
export async function parseDocumentFull(pkg: VsdxPackage, name: string): Promise<ParsedDocument> {
  const warnings: string[] = [];
  const docPath = await locateDocumentPart(pkg);
  const docRoot = (await pkg.readXml(docPath)).documentElement;
  const docRels = await pkg.relationships(docPath);

  const ctx: DocumentContext = {
    styles: parseStyleSheets(docRoot),
    fonts: parseFonts(docRoot),
    masters: await parseMasters(pkg, docRels, warnings),
    theme: await loadTheme(pkg, docRels),
  };

  const pageInfos = await parsePageIndex(pkg, docRels);
  const byId = new Map(pageInfos.map((p) => [p.id, p]));

  const pages: DiagramPage[] = [];
  const registries = new Map<string, Map<string, ShapeRef>>();
  for (const info of pageInfos) {
    if (info.background) continue;
    const registry = new Map<string, ShapeRef>();
    registries.set(info.id, registry);
    try {
      pages.push(await parsePage(pkg, info, ctx, byId, warnings, registry));
    } catch (e) {
      warnings.push(`Page "${info.name}": ${(e as Error).message}`);
      pages.push({
        id: info.id,
        name: info.name,
        width: info.width * PX_PER_INCH,
        height: info.height * PX_PER_INCH,
        shapes: [],
      });
    }
  }
  if (pages.length === 0) warnings.push("The file contains no foreground pages.");
  return { document: { name, pages, warnings }, ctx, infos: byId, registries };
}

export async function parseDocument(pkg: VsdxPackage, name: string): Promise<DiagramDocument> {
  return (await parseDocumentFull(pkg, name)).document;
}
