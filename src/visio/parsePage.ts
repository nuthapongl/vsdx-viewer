import type { DiagramPage, DiagramShape } from "../model/types";
import { PX_PER_INCH, pageToScreen } from "./coordinateTransform";
import type { VsdxPackage } from "./package";
import { parseShape, type PageContext } from "./parseShape";
import type { Connect, DocumentContext, PageInfo, ShapeRef } from "./types";
import { child, children } from "./xml";

/** Everything `parseShape` needs for one page part, read from its current (possibly edited) XML. */
export async function makePageContext(
  pkg: VsdxPackage,
  info: PageInfo,
  doc: DocumentContext,
  pageHeightIn: number,
  idPrefix: string,
  registry?: Map<string, ShapeRef>,
): Promise<{ page: PageContext; root: Element }> {
  if (!pkg.has(info.path)) throw new Error(`missing part ${info.path}`);
  const root = (await pkg.readXml(info.path)).documentElement;

  const connects: Connect[] = [];
  const connectsEl = child(root, "Connects");
  if (connectsEl) {
    for (const c of children(connectsEl, "Connect")) {
      connects.push({
        fromSheet: c.getAttribute("FromSheet") ?? "",
        fromCell: c.getAttribute("FromCell") ?? "",
        toSheet: c.getAttribute("ToSheet") ?? "",
        toCell: c.getAttribute("ToCell") ?? "",
      });
    }
  }
  return {
    root,
    page: {
      doc,
      pkg,
      pageRels: await pkg.relationships(info.path),
      pageHeightIn,
      connects,
      idPrefix,
      registry,
    },
  };
}

async function parseContents(
  pkg: VsdxPackage,
  info: PageInfo,
  doc: DocumentContext,
  pageHeightIn: number,
  idPrefix: string,
  warnings: string[],
  registry?: Map<string, ShapeRef>,
): Promise<DiagramShape[]> {
  const { page, root } = await makePageContext(pkg, info, doc, pageHeightIn, idPrefix, registry);
  const frame = { toScreen: pageToScreen(pageHeightIn) };

  const shapes: DiagramShape[] = [];
  const shapesEl = child(root, "Shapes");
  if (!shapesEl) return shapes;
  for (const el of children(shapesEl, "Shape")) {
    try {
      shapes.push(...(await parseShape(el, page, frame)));
    } catch (e) {
      // One broken shape shouldn't take the whole page down.
      warnings.push(
        `Page "${info.name}", shape ${el.getAttribute("ID") ?? "?"}: ${(e as Error).message}`,
      );
    }
  }
  return shapes;
}

/**
 * Parse one foreground page (background page shapes are painted underneath).
 * Editable shapes of the page itself are recorded in `registry`.
 */
export async function parsePage(
  pkg: VsdxPackage,
  info: PageInfo,
  doc: DocumentContext,
  pages: Map<string, PageInfo>,
  warnings: string[],
  registry?: Map<string, ShapeRef>,
): Promise<DiagramPage> {
  const shapes: DiagramShape[] = [];

  const back = info.backPageId ? pages.get(info.backPageId) : undefined;
  if (back && back.id !== info.id) {
    try {
      shapes.push(...(await parseContents(pkg, back, doc, info.height, `bg${back.id}:`, warnings)));
    } catch (e) {
      warnings.push(`Background page "${back.name}": ${(e as Error).message}`);
    }
  }
  shapes.push(...(await parseContents(pkg, info, doc, info.height, "", warnings, registry)));

  return {
    id: info.id,
    name: info.name,
    width: info.width * PX_PER_INCH,
    height: info.height * PX_PER_INCH,
    shapes,
  };
}
