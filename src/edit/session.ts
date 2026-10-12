import type { DiagramDocument, DiagramPage } from "../model/types";
import { pageToScreen } from "../visio/coordinateTransform";
import { VsdxPackage } from "../visio/package";
import { parseDocumentFull } from "../visio/parseDocument";
import { makePageContext, parsePage } from "../visio/parsePage";
import { parseShape } from "../visio/parseShape";
import type { DocumentContext, PageInfo, ShapeRef } from "../visio/types";
import { child, children } from "../visio/xml";
import {
  addShape,
  applyStyle,
  removeShape,
  reorderShape,
  setCell,
  setShapeText,
  writePlacement,
  type NewShapeKind,
  type StylePatch,
} from "./xmlEdit";
import type { Placement } from "../model/transform";
import type { ConnectorRoute, Point } from "../model/types";
import {
  findAttachments,
  findContents,
  followAnchor,
  followEndpoints,
  lineVertices,
  subtreeIds,
  type LineAttachment,
} from "./connectors";
import {
  createConnector,
  dropEndFormulas,
  setGlue,
  translateLine,
  unglue,
  writeLine,
  writeHaGroup,
  writeLinks,
  writeRouteMeta,
} from "./lineXml";
import { endsOf, obstaclesFor, planBetween, planRoute, type ConnectTarget, type PlanEnd } from "./connectorPlan";

type Snap =
  | {
      kind: "shapes";
      pageId: string;
      items: { id: string; xml: string }[];
      /** Glue records (`Connect`) that start at one of the shapes: moving a connector drops them. */
      connects: { fromSheet: string; xml: string }[];
    }
  | { kind: "page"; pageId: string; shapes: string | null; connects: string | null };

interface Txn {
  label: string;
  before: Snap;
  after: Snap;
  coalesceKey?: string;
  time: number;
}

/** A group of changes that become one undo step when committed. */
export interface EditHandle {
  /**
   * Apply the change. For shape edits the shapes are first reverted to how they
   * were when the edit began, so calling this repeatedly (while dragging) is safe.
   * `refs[i].sheet` always describes the shape as it was before the edit.
   */
  apply(fn: (refs: (ShapeRef & { id: string })[], root: Element) => void): void;
  /** Record the undo step. Returns false (and records nothing) if nothing changed. */
  commit(label: string, coalesceKey?: string): boolean;
  cancel(): void;
}

/** A move/resize/rotate in progress, together with the lines that follow the shape. */
export interface TransformEdit {
  /** How many lines are re-routed along with the shape. */
  attachedLines: number;
  /** How many items inside a moved box travel with it. */
  carried: number;
  update(next: Placement): void;
  commit: EditHandle["commit"];
  cancel: EditHandle["cancel"];
}

const placementOf = (s: { x: number; y: number; width: number; height: number; rotation: number; flipX: boolean }): Placement => ({
  x: s.x,
  y: s.y,
  width: s.width,
  height: s.height,
  rotation: s.rotation,
  flipX: s.flipX,
});

/** New vertices of a line whose attached end(s) follow the shape from `start` to `next`. */
function reroute(a: LineAttachment, start: Placement, next: Placement): Point[] {
  return followEndpoints(a.vertices, {
    start: a.start && followAnchor(a.start, start, next),
    end: a.end && followAnchor(a.end, start, next),
  });
}

const MAX_HISTORY = 100;
const COALESCE_MS = 1500;
const NEW_SHAPE_SIZE = { width: 192, height: 96 };

const serialize = (n: Node) => new XMLSerializer().serializeToString(n);

function parseElement(xml: string, into: Document): Element {
  const d = new DOMParser().parseFromString(xml, "application/xml");
  return into.importNode(d.documentElement, true) as Element;
}

/**
 * An open .vsdx that can be edited and saved.
 *
 * Edits are written into the original XML (see xmlEdit.ts) and the diagram
 * model is refreshed from it, so what is drawn is always what will be saved.
 */
export class EditSession {
  readonly fileName: string;
  private pkg: VsdxPackage;
  private ctx: DocumentContext;
  private infos: Map<string, PageInfo>;
  private registries: Map<string, Map<string, ShapeRef>>;
  private roots = new Map<string, Element>();
  private doc: DiagramDocument;

  private version = 0;
  private savedVersion = 0;
  private listeners = new Set<() => void>();
  private undoStack: Txn[] = [];
  private redoStack: Txn[] = [];

  private pending = new Map<string, { all: boolean; ids: Set<string> }>();
  private loop: Promise<void> = Promise.resolve();
  private running = false;

  private constructor(
    fileName: string,
    pkg: VsdxPackage,
    parsed: Awaited<ReturnType<typeof parseDocumentFull>>,
  ) {
    this.fileName = fileName;
    this.pkg = pkg;
    this.ctx = parsed.ctx;
    this.infos = parsed.infos;
    this.registries = parsed.registries;
    this.doc = parsed.document;
  }

  static async open(
    input: File | Blob | ArrayBuffer | Uint8Array,
    fileName = "diagram.vsdx",
  ): Promise<EditSession> {
    const pkg = await VsdxPackage.open(input);
    try {
      const parsed = await parseDocumentFull(pkg, fileName.replace(/\.vsdx$/i, ""));
      const session = new EditSession(fileName, pkg, parsed);
      for (const id of parsed.registries.keys()) {
        const info = parsed.infos.get(id)!;
        session.roots.set(id, (await pkg.readXml(info.path)).documentElement);
      }
      parsed.document.dispose = () => session.dispose();
      return session;
    } catch (e) {
      pkg.dispose();
      throw e;
    }
  }

  // --- observable state (for useSyncExternalStore) ---------------------------------

  get document(): DiagramDocument {
    return this.doc;
  }
  /** Changes whenever the document, history or dirty state changes. */
  getVersion = () => this.version;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  get dirty(): boolean {
    return this.version !== this.savedVersion;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  private notify() {
    this.listeners.forEach((l) => l());
  }

  /** Shapes of the page itself (not background pages, not parts of a master). */
  isEditable(pageId: string, id: string): boolean {
    return this.registries.get(pageId)?.has(id) ?? false;
  }

  dispose() {
    this.pkg.dispose();
  }

  // --- snapshots & history -----------------------------------------------------------

  private snapshot(pageId: string, ids: string[], kind: Snap["kind"]): Snap {
    if (kind === "shapes") {
      const reg = this.registries.get(pageId)!;
      const connectsEl = child(this.roots.get(pageId)!, "Connects");
      return {
        kind,
        pageId,
        items: ids.flatMap((id) => {
          const ref = reg.get(id);
          return ref ? [{ id, xml: serialize(ref.el) }] : [];
        }),
        connects: connectsEl
          ? children(connectsEl, "Connect")
              .filter((c) => ids.includes(c.getAttribute("FromSheet") ?? ""))
              .map((c) => ({ fromSheet: c.getAttribute("FromSheet")!, xml: serialize(c) }))
          : [],
      };
    }
    const root = this.roots.get(pageId)!;
    const shapes = child(root, "Shapes");
    const connects = child(root, "Connects");
    return {
      kind,
      pageId,
      shapes: shapes ? serialize(shapes) : null,
      connects: connects ? serialize(connects) : null,
    };
  }

  /** Put the XML back as it was in `snap`. Does not refresh the model. */
  private restoreXml(snap: Snap) {
    const reg = this.registries.get(snap.pageId)!;
    if (snap.kind === "shapes") {
      for (const item of snap.items) {
        const ref = reg.get(item.id);
        if (!ref) continue;
        const el = parseElement(item.xml, ref.el.ownerDocument);
        ref.el.replaceWith(el);
        ref.el = el;
      }
      // Glue records of these shapes go back exactly as they were.
      const root = this.roots.get(snap.pageId)!;
      const ids = new Set(snap.items.map((i) => i.id));
      let connectsEl = child(root, "Connects");
      if (connectsEl) {
        for (const c of children(connectsEl, "Connect")) {
          if (ids.has(c.getAttribute("FromSheet") ?? "")) c.remove();
        }
      }
      if (snap.connects.length > 0) {
        if (!connectsEl) {
          connectsEl = root.ownerDocument.createElementNS(root.namespaceURI, "Connects");
          root.appendChild(connectsEl);
        }
        for (const c of snap.connects) connectsEl.appendChild(parseElement(c.xml, root.ownerDocument));
      }
      return;
    }
    const root = this.roots.get(snap.pageId)!;
    for (const [name, xml] of [
      ["Shapes", snap.shapes],
      ["Connects", snap.connects],
    ] as const) {
      const current = child(root, name);
      if (xml === null) {
        current?.remove();
      } else {
        const el = parseElement(xml, root.ownerDocument);
        if (current) current.replaceWith(el);
        else root.appendChild(el);
      }
    }
  }

  private touch(pageId: string, snap: Snap) {
    this.pkg.markXmlDirty(this.infos.get(pageId)!.path);
    this.version++;
    this.schedule(pageId, snap.kind === "shapes" ? snap.items.map((i) => i.id) : "all");
  }

  private push(txn: Txn) {
    const last = this.undoStack[this.undoStack.length - 1];
    if (
      txn.coalesceKey &&
      last?.coalesceKey === txn.coalesceKey &&
      last.before.pageId === txn.before.pageId &&
      txn.time - last.time < COALESCE_MS
    ) {
      last.after = txn.after;
      last.time = txn.time;
    } else {
      this.undoStack.push(txn);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  async undo(): Promise<void> {
    const txn = this.undoStack.pop();
    if (!txn) return;
    this.restoreXml(txn.before);
    this.redoStack.push(txn);
    this.touch(txn.before.pageId, txn.before);
    await this.idle();
  }

  async redo(): Promise<void> {
    const txn = this.redoStack.pop();
    if (!txn) return;
    this.restoreXml(txn.after);
    this.undoStack.push(txn);
    this.touch(txn.after.pageId, txn.after);
    await this.idle();
  }

  // --- editing --------------------------------------------------------------------------

  begin(pageId: string, ids: string[], kind: Snap["kind"] = "shapes"): EditHandle {
    const before = this.snapshot(pageId, ids, kind);
    const root = this.roots.get(pageId)!;
    const base = ids.map((id) => {
      const ref = this.registries.get(pageId)!.get(id);
      return ref ? { frame: ref.frame, sheet: ref.sheet, masterText: ref.masterText } : undefined;
    });
    let applied = false;

    return {
      apply: (fn) => {
        if (applied && kind === "shapes") this.restoreXml(before);
        applied = true;
        const reg = this.registries.get(pageId)!;
        const refs = ids.flatMap((id, i) => {
          const live = reg.get(id);
          const b = base[i];
          return live && b ? [{ ...live, ...b, id }] : [];
        });
        fn(refs, root);
        this.touch(pageId, before);
      },
      commit: (label, coalesceKey) => {
        const after = this.snapshot(pageId, ids, kind);
        if (JSON.stringify(after) === JSON.stringify(before)) return false;
        this.push({ label, before, after, coalesceKey, time: Date.now() });
        this.version++;
        this.notify();
        return true;
      },
      cancel: () => {
        if (!applied) return;
        this.restoreXml(before);
        this.touch(pageId, before);
      },
    };
  }

  private transact(
    pageId: string,
    ids: string[],
    kind: Snap["kind"],
    label: string,
    fn: (refs: (ShapeRef & { id: string })[], root: Element) => void,
    coalesceKey?: string,
  ) {
    const edit = this.begin(pageId, ids, kind);
    edit.apply(fn);
    edit.commit(label, coalesceKey);
  }

  /**
   * Start moving, resizing or rotating a shape. Lines whose ends touch the shape
   * (glued to it, or lying on its border) are re-routed along with it, and
   * everything is one undo step.
   */
  beginTransform(pageId: string, id: string): TransformEdit {
    const page = this.doc.pages.find((p) => p.id === pageId)!;
    const moved = page.shapes.find((s) => s.id === id)!;
    const start = placementOf(moved);
    // A 1-D connector moves as a whole: its end points and glue are rewritten, nothing follows it.
    if (moved.connector) {
      const edit = this.begin(pageId, [id]);
      return {
        attachedLines: 0,
        carried: 0,
        update: (next) =>
          edit.apply(([ref], root) => {
            if (!ref) return;
            translateLine(ref, next.x - start.x, next.y - start.y);
            unglue(root, id);
          }),
        commit: edit.commit,
        cancel: edit.cancel,
      };
    }

    const editable = (sid: string) => this.isEditable(pageId, sid);
    const byShape = new Map(page.shapes.map((s) => [s.id, s]));

    // A box takes what is inside it along when it is moved (not when it is resized or turned).
    const contents = findContents(page.shapes, moved, editable);
    const carried = [...contents.shapes, ...contents.lines];
    // Lines that end on the box, or on anything it carries, follow those ends.
    const attachedToMoved = findAttachments(page.shapes, id, editable);
    const attachedToAll = findAttachments(page.shapes, [id, ...carried], editable);

    // Connectors that are glued to the moved shapes are re-routed (not stretched): they keep the
    // side they leave from and find their way round everything else.
    const insideSubtree = new Set<string>();
    for (const root of [id, ...carried]) for (const x of subtreeIds(page.shapes, root)) insideSubtree.add(x);
    const gluedToMoved = (lineId: string) => {
      const c = byShape.get(lineId)?.connector;
      return !!c && [c.begin.shapeId, c.end.shapeId].some((g) => g !== undefined && insideSubtree.has(g));
    };
    const currentFrame = (sid: string) => {
      const sh = byShape.get(sid);
      return sh && placementOf(sh);
    };
    const routed = new Map<string, NonNullable<ReturnType<typeof endsOf>>>();
    for (const a of [...attachedToAll, ...attachedToMoved]) {
      if (routed.has(a.lineId) || !gluedToMoved(a.lineId)) continue;
      const line = byShape.get(a.lineId);
      const ends = line && endsOf(line, currentFrame);
      if (ends) routed.set(a.lineId, ends);
    }
    const stretchAll = attachedToAll.filter((a) => !routed.has(a.lineId));
    const stretchMoved = attachedToMoved.filter((a) => !routed.has(a.lineId));

    const ids = [
      ...new Set([
        id,
        ...carried,
        ...attachedToAll.map((a) => a.lineId),
        ...attachedToMoved.map((a) => a.lineId),
      ]),
    ];
    const edit = this.begin(pageId, ids);

    return {
      attachedLines: attachedToAll.length,
      carried: carried.length,
      update: (next) =>
        edit.apply((refs) => {
          const byId = new Map(refs.map((r) => [r.id, r]));
          const shape = byId.get(id);
          if (shape) writePlacement(shape, next);

          const translation =
            Math.abs(next.width - start.width) < 1e-6 &&
            Math.abs(next.height - start.height) < 1e-6 &&
            next.rotation === start.rotation &&
            next.flipX === start.flipX;
          if (translation) {
            const dx = next.x - start.x;
            const dy = next.y - start.y;
            for (const cid of carried) {
              const ref = byId.get(cid);
              const item = byShape.get(cid);
              if (!ref || !item) continue;
              if (item.connector) {
                // Everything it is glued to moves by the same amount, so the glue stays valid.
                translateLine(ref, dx, dy, true);
              } else {
                writePlacement(ref, { ...placementOf(item), x: item.x + dx, y: item.y + dy });
              }
            }
          }

          // Frames the moved shapes will have, for routing the glued connectors.
          const override = new Map<string, Placement>([[id, next]]);
          if (translation) {
            for (const cid of carried) {
              const item = byShape.get(cid);
              if (item && !item.connector && !lineVertices(item)) {
                override.set(cid, { ...placementOf(item), x: item.x + (next.x - start.x), y: item.y + (next.y - start.y) });
              }
            }
          }
          const obstacles = obstaclesFor(page.shapes, override);
          for (const [lineId, ends] of routed) {
            const ref = byId.get(lineId);
            if (!ref) continue;
            const line = byShape.get(lineId)!;
            const rebuilt = (e: PlanEnd, shapeId: string | undefined): PlanEnd =>
              e.shape && shapeId !== undefined ? { shape: override.get(shapeId) ?? e.shape, side: e.side } : e;
            const plan = planRoute(
              rebuilt(ends.a, line.connector!.begin.shapeId),
              rebuilt(ends.b, line.connector!.end.shapeId),
              ends.style,
              obstacles,
            );
            const now = lineVertices(line);
            const same =
              !!now &&
              now.length === plan.points.length &&
              now.every((p, i) => Math.hypot(p.x - plan.points[i].x, p.y - plan.points[i].y) < 1e-6);
            if (same) continue; // nothing to change: leave the connector's XML exactly as it was
            writeLine(ref, plan.points);
            writeRouteMeta(ref.el, { style: ends.style, beginSide: plan.beginSide, endSide: plan.endSide });
          }

          for (const a of translation ? stretchAll : stretchMoved) {
            const ref = byId.get(a.lineId);
            if (!ref) continue;
            const points = reroute(a, start, next);
            const unchanged =
              points.length === a.vertices.length &&
              points.every((p, i) => Math.hypot(p.x - a.vertices[i].x, p.y - a.vertices[i].y) < 1e-6);
            if (!unchanged) writeLine(ref, points); // untouched lines keep their XML exactly
          }
        }),
      commit: edit.commit,
      cancel: edit.cancel,
    };
  }

  /** One-shot move/resize/rotate (the viewer uses `beginTransform` while dragging). */
  setPlacement(pageId: string, id: string, p: Placement, label = "Move", coalesceKey?: string) {
    const edit = this.beginTransform(pageId, id);
    edit.update(p);
    edit.commit(label, coalesceKey);
  }

  // --- connectors ---------------------------------------------------------------------------

  /** Plan (without changing anything) the path a connector between two targets would take. */
  planConnector(pageId: string, from: ConnectTarget, to: ConnectTarget, style: ConnectorRoute["style"]) {
    const page = this.doc.pages.find((p) => p.id === pageId)!;
    return planBetween(page.shapes, from, to, style);
  }

  /**
   * Add a connector between two targets, glued to those that are shapes. The path is
   * routed around other shapes. Returns the new connector's id.
   */
  async createConnector(
    pageId: string,
    from: ConnectTarget,
    to: ConnectTarget,
    style: ConnectorRoute["style"] = "elbow",
  ): Promise<string> {
    const info = this.infos.get(pageId)!;
    const plan = this.planConnector(pageId, from, to, style);
    let id = "";
    this.transact(pageId, [], "page", "Add connector", (_refs, root) => {
      id = createConnector(root, {
        points: plan.points,
        pageToScreen: pageToScreen(info.height),
        beginShapeId: from.shapeId,
        endShapeId: to.shapeId,
        route: { style, beginSide: plan.beginSide, endSide: plan.endSide },
      });
    });
    await this.idle();
    return id;
  }

  /**
   * Move one end of a connector to a new target (a shape, or a free point) and
   * re-route it. The glue follows: attached to a shape, or detached for a point.
   */
  reconnectEnd(pageId: string, connectorId: string, end: "begin" | "end", target: ConnectTarget) {
    const page = this.doc.pages.find((p) => p.id === pageId)!;
    const line = page.shapes.find((s) => s.id === connectorId);
    const ends = line && endsOf(line, (sid) => {
      const sh = page.shapes.find((x) => x.id === sid);
      return sh && placementOf(sh);
    });
    if (!line || !ends) return;

    const other = end === "begin" ? ends.b : ends.a;
    const mine: ConnectTarget = target;
    const otherTarget: ConnectTarget = {
      shapeId: end === "begin" ? line.connector!.end.shapeId : line.connector!.begin.shapeId,
      side: other.side,
      point: other.point,
    };
    const plan =
      end === "begin"
        ? planBetween(page.shapes, mine, otherTarget, ends.style)
        : planBetween(page.shapes, otherTarget, mine, ends.style);

    this.transact(pageId, [connectorId], "shapes", "Reconnect", ([ref], root) => {
      if (!ref) return;
      dropEndFormulas(ref.el, end);
      writeLine(ref, plan.points);
      setGlue(root, connectorId, end, target.shapeId);
      writeRouteMeta(ref.el, { style: ends.style, beginSide: plan.beginSide, endSide: plan.endSide });
    });
  }

  /** Give one line a new route (page px): a piece or a bend dragged. One undo step. */
  setLinePoints(pageId: string, lineId: string, points: Point[]) {
    this.transact(pageId, [lineId], "shapes", "Reshape line", ([ref]) => {
      if (ref) writeLine(ref, points);
    });
  }

  /**
   * Drag one end of a plain line (a polyline that is not a connector) to `to` - a point the magnet
   * may have snapped onto a shape. Square pieces stay square: the neighbouring piece stretches.
   */
  moveLineEnd(pageId: string, lineId: string, end: "begin" | "end", to: Point) {
    const page = this.doc.pages.find((p) => p.id === pageId)!;
    const line = page.shapes.find((s) => s.id === lineId);
    const verts = line && lineVertices(line);
    if (!verts) return;
    const pts = followEndpoints(verts, end === "begin" ? { start: to } : { end: to });
    this.transact(pageId, [lineId], "shapes", "Move line end", ([ref]) => {
      if (ref) writeLine(ref, pts);
    });
  }

  /** Switch a connector between straight and elbow, and/or turn its arrow heads on or off. */
  setConnectorStyle(
    pageId: string,
    connectorId: string,
    patch: { style?: ConnectorRoute["style"]; beginArrow?: boolean; endArrow?: boolean },
  ) {
    const page = this.doc.pages.find((p) => p.id === pageId)!;
    const line = page.shapes.find((s) => s.id === connectorId);
    const ends =
      line &&
      endsOf(line, (sid) => {
        const sh = page.shapes.find((x) => x.id === sid);
        return sh && placementOf(sh);
      });
    if (!line || !ends) return;
    const style = patch.style ?? ends.style;
    const plan = patch.style
      ? planRoute(ends.a, ends.b, style, obstaclesFor(page.shapes))
      : undefined;

    this.transact(pageId, [connectorId], "shapes", "Connector style", ([ref]) => {
      if (!ref) return;
      if (plan) {
        writeLine(ref, plan.points);
        writeRouteMeta(ref.el, { style, beginSide: plan.beginSide, endSide: plan.endSide });
      }
      if (patch.beginArrow !== undefined) setCell(ref.el, "BeginArrow", patch.beginArrow ? 5 : 0);
      if (patch.endArrow !== undefined) setCell(ref.el, "EndArrow", patch.endArrow ? 5 : 0);
    });
  }

  /**
   * Record which nodes the ends of a line connect to (shape ids), for the diagram analysis.
   * An empty list clears that end's answer.
   */
  setLineLinks(pageId: string, lineId: string, links: { begin?: string[]; end?: string[] }) {
    this.transact(pageId, [lineId], "shapes", "Confirm connection", ([ref]) => {
      if (ref) writeLinks(ref.el, links);
    });
  }

  /**
   * Put nodes into high-availability groups (nodes with the same number stand in for one
   * another) or take them out (`group` undefined), as one undo step.
   */
  setHaGroups(pageId: string, changes: { id: string; group?: number }[]) {
    this.transact(pageId, changes.map((c) => c.id), "shapes", "Change HA groups", (refs) => {
      for (const ref of refs) writeHaGroup(ref.el, changes.find((c) => c.id === ref.id)?.group);
    });
  }

  /**
   * Give lines new routes (page px), all as one undo step. Used by "Tidy lines": the proposal
   * is computed by `tidyRoutes` and previewed before this is called.
   */
  tidyLines(pageId: string, changes: { id: string; points: Point[] }[]) {
    this.transact(pageId, changes.map((c) => c.id), "shapes", "Tidy lines", (refs) => {
      for (const ref of refs) {
        const c = changes.find((x) => x.id === ref.id);
        if (c) writeLine(ref, c.points);
      }
    });
  }

  setStyle(pageId: string, ids: string[], patch: StylePatch, coalesceKey?: string) {
    this.transact(
      pageId,
      ids,
      "shapes",
      "Change style",
      (refs) => refs.forEach((r) => applyStyle(r.el, patch)),
      coalesceKey,
    );
  }

  setText(pageId: string, id: string, oldText: string, newText: string) {
    this.transact(pageId, [id], "shapes", "Edit text", ([ref]) => {
      if (ref) setShapeText(ref, oldText, newText);
    });
  }

  deleteShapes(pageId: string, ids: string[]) {
    this.transact(pageId, ids, "page", "Delete", (refs, root) => {
      for (const r of refs) removeShape(root, r.el);
    });
  }

  reorder(pageId: string, id: string, where: "front" | "back") {
    this.transact(pageId, [id], "page", where === "front" ? "Bring to front" : "Send to back", ([ref]) => {
      if (ref) reorderShape(ref.el, where);
    });
  }

  /** Add a shape centred at `centre` (page px). Returns its id once it is in the model. */
  async addShape(pageId: string, kind: NewShapeKind, centre: { x: number; y: number }): Promise<string> {
    const info = this.infos.get(pageId)!;
    let id = "";
    this.transact(pageId, [], "page", "Add shape", (_refs, root) => {
      id = addShape(root, kind, centre, NEW_SHAPE_SIZE, pageToScreen(info.height));
    });
    await this.idle();
    return id;
  }

  // --- keeping the model in step with the XML --------------------------------------------

  private schedule(pageId: string, ids: string[] | "all") {
    const entry = this.pending.get(pageId) ?? { all: false, ids: new Set<string>() };
    if (ids === "all") entry.all = true;
    else ids.forEach((i) => entry.ids.add(i));
    this.pending.set(pageId, entry);
    if (!this.running) {
      this.running = true;
      this.loop = this.drain().finally(() => {
        this.running = false;
      });
    }
  }

  /** Resolves when the model reflects every edit made so far. */
  idle(): Promise<void> {
    return this.loop;
  }

  private async drain() {
    while (this.pending.size > 0) {
      const [pageId, entry] = this.pending.entries().next().value!;
      this.pending.delete(pageId);
      try {
        if (entry.all) await this.reparsePage(pageId);
        else await this.reparseShapes(pageId, [...entry.ids]);
      } catch (e) {
        console.error("Re-parse after edit failed", e);
      }
      this.notify();
    }
  }

  private replacePage(page: DiagramPage) {
    this.doc = { ...this.doc, pages: this.doc.pages.map((p) => (p.id === page.id ? page : p)) };
    // Subscribers compare versions: a new document must look like a new snapshot, even
    // when the version was already bumped by the (earlier) commit that caused this re-parse.
    this.version++;
  }

  private async reparsePage(pageId: string) {
    const info = this.infos.get(pageId)!;
    const registry = new Map<string, ShapeRef>();
    this.registries.set(pageId, registry);
    const warnings: string[] = [];
    this.replacePage(await parsePage(this.pkg, info, this.ctx, this.infos, warnings, registry));
  }

  private async reparseShapes(pageId: string, ids: string[]) {
    const info = this.infos.get(pageId)!;
    const registry = this.registries.get(pageId)!;
    const { page } = await makePageContext(this.pkg, info, this.ctx, info.height, "", registry);

    for (const id of ids) {
      const ref = registry.get(id);
      if (!ref) continue;
      const parsed = await parseShape(ref.el, page, ref.frame);
      const current = this.doc.pages.find((p) => p.id === pageId)!;
      const shapes = [...current.shapes];
      const idx = shapes.findIndex((s) => s.id === id);
      if (idx < 0) continue;
      // The shape and everything nested in it are contiguous in paint order.
      const inside = new Set([id]);
      let end = idx + 1;
      while (end < shapes.length && shapes[end].parentId && inside.has(shapes[end].parentId!)) {
        inside.add(shapes[end].id);
        end++;
      }
      shapes.splice(idx, end - idx, ...parsed);
      this.replacePage({ ...current, shapes });
    }
  }

  // --- saving ----------------------------------------------------------------------------

  /** The edited document as .vsdx bytes. Doesn't change the "unsaved" state; see `markSaved`. */
  async exportBytes(): Promise<Uint8Array> {
    await this.idle();
    return this.pkg.toBytes();
  }

  /** Call once the bytes from `exportBytes` have actually been written somewhere. */
  markSaved() {
    this.savedVersion = this.version;
    this.notify();
  }

  async save(): Promise<Uint8Array> {
    const bytes = await this.exportBytes();
    this.markSaved();
    return bytes;
  }
}
