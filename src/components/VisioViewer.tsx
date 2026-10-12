import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  handlePoint,
  resizePlacement,
  rotatePlacement,
  type Handle,
} from "../edit/interaction";
import { buildTopology } from "../analysis/graph";
import { computeImpactView } from "../analysis/impact";
import { readGroups } from "../analysis/groups";
import { followEndpoints, frameCorners, lineVertices } from "../edit/connectors";
import type { ConnectTarget } from "../edit/connectorPlan";
import { nearestPort, rectOf } from "../edit/routing";
import { saveToDisk } from "../edit/saveFile";
import type { EditSession, TransformEdit } from "../edit/session";
import type { StylePatch } from "../edit/xmlEdit";
import { applyMatrix, placementMatrix, type Placement } from "../model/transform";
import type { DiagramPage, DiagramShape, Point, Side } from "../model/types";
import { pageBounds, type Bounds } from "../render/bounds";
import { AnalysisOverlay } from "./AnalysisOverlay";
import { ExportBar, RegionOverlay } from "./ExportBar";
import { TidyBar, TidyOverlay } from "./TidyPreview";
import { routeStats, tidyRoutes } from "../edit/tidy";
import { downloadBlob, renderPng } from "../render/exportPng";
import { regionBetween, shapeBounds } from "../render/exportRegion";
import { snapPoint, type SnapHit } from "../edit/snap";
import { moveBend, movePiece, normalise, pieceKind, pullTo, splitPiece } from "../edit/lineEdit";
import type { Role } from "./analysisRoles";
import { AnalysisPanel } from "./AnalysisPanel";
import { MonitorOverlay } from "./MonitorOverlay";
import { MonitorPanel } from "./MonitorPanel";
import { simulate } from "../analysis/simulate";
import { DiagramRenderer } from "./DiagramRenderer";
import { EditToolbar, type Mode, type Tool } from "./EditToolbar";
import { BendMarks, EndpointHandles, LineHandles, PathHighlight, PortsOverlay, RoutePreview, SnapMarker } from "./ConnectorOverlay";
import { Inspector, type ConnectorPatch } from "./Inspector";
import { SelectionOverlay } from "./SelectionOverlay";
import { TextEditor } from "./TextEditor";
import { ViewerToolbar } from "./ViewerToolbar";

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 40;
const BUTTON_ZOOM = 1.25;
const FIT_PADDING = 24;
const DRAG_THRESHOLD = 3; // screen px before a press becomes a drag

const clamp = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

/** Scale and offset that centre `b` in a viewport of `w`×`h`, shrinking it to fit if `fit`. */
function viewFor(b: Bounds, w: number, h: number, fit: boolean): View {
  const scale = fit
    ? clamp(
        Math.min(
          (w - 2 * FIT_PADDING) / Math.max(b.width, 1),
          (h - 2 * FIT_PADDING) / Math.max(b.height, 1),
        ),
      )
    : 1;
  return {
    scale,
    tx: (w - b.width * scale) / 2 - b.x * scale,
    ty: (h - b.height * scale) / 2 - b.y * scale,
  };
}

/** Zoom by `factor`, keeping the viewport point (cx, cy) fixed. */
function zoomAt(v: View, factor: number, cx: number, cy: number): View {
  const scale = clamp(v.scale * factor);
  const k = scale / v.scale;
  return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
}

const placementOf = (s: DiagramShape): Placement => ({
  x: s.x,
  y: s.y,
  width: s.width,
  height: s.height,
  rotation: s.rotation,
  flipX: s.flipX,
});

const isLineLike = (s: DiagramShape) => s.type === "connector" || s.type === "line";

type Drag =
  | {
      mode: "pan";
      last: { x: number; y: number };
      /** Where the press began, and whether the pointer has travelled: a click on empty space lets go of the node under analysis. */
      start: { x: number; y: number };
      onEmpty: boolean;
      moved: boolean;
      /** Monitor: the node a click switches off or on. */
      toggle?: string;
    }
  | { mode: "none" }
  | {
      /** Dragging a piece or a bend of the selected line. */
      mode: "reshape";
      id: string;
      kind: "piece" | "bend" | "split";
      index: number;
      verts: Point[];
      startPt: Point;
      startClient: { x: number; y: number };
      rect: DOMRect;
      points?: Point[];
    }
  | {
      /** Drawing a new connector from `from`; `to` follows the pointer. */
      mode: "connect";
      from: ConnectTarget;
      to: ConnectTarget;
      /** Target the preview was last computed for (shape targets don't depend on the exact pointer position). */
      planned?: string;
      startClient: { x: number; y: number };
      rect: DOMRect;
    }
  | {
      /** Drawing the box of an area to export. */
      mode: "marquee";
      from: Point;
      rect: DOMRect;
      /** The shape (outermost group) under the press, for a click without a drag. */
      hit: string | null;
    }
  | {
      /** Dragging one end of an existing connector. */
      mode: "endpoint";
      /** A plain line (not a connector): its end moves to a point, which the magnet may snap onto a shape. */
      polyline?: boolean;
      toPoint?: Point;
      id: string;
      end: "begin" | "end";
      to: ConnectTarget;
      planned?: string;
      startClient: { x: number; y: number };
      rect: DOMRect;
    }
  | {
      mode: "move" | "resize" | "rotate";
      id: string;
      handle?: Handle;
      start: Placement;
      startClient: { x: number; y: number };
      startPt: { x: number; y: number };
      /** Canvas position when the press happened. */
      rect: DOMRect;
      /** Where inside the handle it was grabbed, so the shape doesn't jump when the drag starts. */
      grab: { x: number; y: number };
      edit?: TransformEdit;
      /** Child to select if this press turns out to be a plain click. */
      drill: string | null;
    };

interface Props {
  session: EditSession;
  page: DiagramPage;
  /** Page tabs, placed beside the zoom controls. */
  pageTabs?: React.ReactNode;
  /** Viewer: nothing can be changed by accident. Editor: shapes can be moved, restyled, drawn and deleted. */
  mode: Mode;
  onMode: (m: Mode) => void;
}

export function VisioViewer({ session, page, pageTabs, mode, onMode }: Props) {
  const canEdit = mode === "editor";
  useSyncExternalStore(session.subscribe, session.getVersion); // re-render on any edit/undo/save

  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view; // read by pointer handlers, which must see the latest view mid-drag
  });
  const [panning, setPanning] = useState(false);
  const drag = useRef<Drag | null>(null);
  const fitted = useRef(false);

  const [tool, setTool] = useState<Tool>("select");
  /** The part of the page chosen for a PNG export, in page px. */
  const [region, setRegion] = useState<Bounds | null>(null);
  const [exporting, setExporting] = useState(false);
  /** Tidy-lines preview, when open. */
  const [tidy, setTidy] = useState<{ scope: "page" | "selection" } | null>(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  /** The network monitor (simulated traffic), and the nodes switched off in it. */
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [off, setOff] = useState<string[]>([]);
  /** The node whose failure is being examined. */
  const [sources, setSources] = useState<string[]>([]);
  const source = sources[0] ?? null;
  const setSource = (id: string | null) => setSources(id ? [id] : []);
  /** Pick a failed node on the diagram; with Shift, add it to (or take it out of) the ones already down. */
  const pickSource = (id: string, add: boolean) =>
    setSources((cur) => (add ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]));
  /** A line under review in the analysis panel. */
  const [focusLine, setFocusLine] = useState<string | null>(null);
  /** Route shown while a connector is drawn or one of its ends is dragged. */
  const [preview, setPreview] = useState<{
    points: Point[];
    target?: ConnectTarget;
    /** The connector end being dragged (its handle is replaced by the preview). */
    dragging?: "begin" | "end";
    /** Where the magnet holds the end, and onto what. */
    snap?: SnapHit;
    /** A piece or bend is being dragged (no end dot). */
    reshape?: boolean;
  } | null>(null);
  /** The shape under the pointer, which shows its ports. */
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const shapeById = useMemo(() => new Map(page.shapes.map((s) => [s.id, s])), [page]);
  // The diagram's topology and the result for the chosen node, only while the analysis is open.
  const topology = useMemo(() => (analysisOpen || monitorOpen ? buildTopology(page.shapes) : null), [analysisOpen, monitorOpen, page]);
  const ha = useMemo(() => (topology ? readGroups(topology.nodes, shapeById) : null), [topology, shapeById]);
  const sim = useMemo(() => (monitorOpen && topology ? simulate(topology, off, ha?.groupOf) : null), [monitorOpen, topology, off, ha]);
  // The monitor's picture: every node's state, and each line drawn the way its traffic runs.
  const monitorView = useMemo(() => {
    if (!sim || !topology) return null;
    const lineInfo = new Map(topology.lines.map((l) => [l.lineId, l]));
    const ends = (e: { kind: string; nodeIds: string[]; candidates: string[] }) => (e.kind === "node" ? e.nodeIds : e.candidates);
    const oriented = (f: { lineId: string; from: string }) => {
      const shape = shapeById.get(f.lineId);
      const v = shape && lineVertices(shape);
      const info = lineInfo.get(f.lineId);
      if (!v || !info) return null;
      const reversed = !ends(info.begin).includes(f.from) && ends(info.end).includes(f.from);
      return reversed ? [...v].reverse() : v;
    };
    return {
      nodes: [...sim.state.entries()].flatMap(([id, state]) => {
        const shape = shapeById.get(id);
        return shape ? [{ shape, state }] : [];
      }),
      flows: sim.flows.map(oriented).filter((v): v is Point[] => !!v),
      stopped: sim.stopped.map(oriented).filter((v): v is Point[] => !!v),
    };
  }, [sim, topology, shapeById]);
  const result = useMemo(
    () =>
      topology && sources.length > 0 && sources.every((x) => topology.nodes.has(x))
        ? computeImpactView(topology, sources, ha?.groupOf)
        : null,
    [topology, sources, ha],
  );
  const overlay = useMemo(() => {
    if (!topology || !result) return null;
    const { impact } = result;
    const nodes: { shape: DiagramShape; role: Role }[] = [];
    const lines: { vertices: { x: number; y: number }[]; colour: string }[] = [];
    const add = (id: string, role: Role) => {
      const shape = shapeById.get(id);
      if (shape) nodes.push({ shape, role });
    };
    // Each line is drawn from the caller to the callee: a dependent calls towards the failed
    // node, and what is cut off is called from it - so the dashes run the way requests travel.
    const lineInfo = new Map(topology.lines.map((l) => [l.lineId, l]));
    const drawn = new Set<string>();
    const endNodes = (e: { kind: string; nodeIds: string[]; candidates: string[] }) =>
      e.kind === "node" ? e.nodeIds : e.candidates;
    const addLines = (items: typeof impact.dependents, colour: string, towardsSource: boolean) => {
      for (const item of items) {
        for (let i = 1; i < item.path.length; i++) {
          const [p, q] = [item.path[i - 1], item.path[i]];
          const from = towardsSource ? q : p;
          const edge = topology.edges.find((e) => (e.a === p && e.b === q) || (e.a === q && e.b === p));
          const info = edge && lineInfo.get(edge.lineId);
          const shape = edge && shapeById.get(edge.lineId);
          const v = shape && lineVertices(shape);
          if (!edge || !info || !v || drawn.has(`${edge.lineId}:${from}`)) continue;
          drawn.add(`${edge.lineId}:${from}`);
          const startsAtEnd = !endNodes(info.begin).includes(from) && endNodes(info.end).includes(from);
          lines.push({ vertices: startsAtEnd ? [...v].reverse() : v, colour });
        }
      }
    };
    for (const src of result.impact.sources) add(src, "source");
    for (const d of impact.dependents) add(d.nodeId, "dependent");
    for (const g of impact.degraded) add(g.nodeId, "degraded");
    for (const u of impact.unreachable ?? []) add(u.nodeId, "cutoff");
    addLines(impact.dependents, "#f08c00", true);
    addLines(impact.degraded.filter((d) => d.reason.kind === "caller"), "#d4a017", true);
    addLines(impact.unreachable ?? [], "#7b3fe4", false);
    return { nodes, lines };
  }, [topology, result, shapeById]);
  const focusLineVertices = useMemo(() => {
    const s = analysisOpen && focusLine ? shapeById.get(focusLine) : undefined;
    return s ? (lineVertices(s) ?? undefined) : undefined;
  }, [analysisOpen, focusLine, shapeById]);

  const selected = selectedId ? shapeById.get(selectedId) : undefined;
  /** A plain line is selected as a line (its path and two ends), not as a box. */
  const selectedVerts = selected && !selected.connector ? lineVertices(selected) : null;
  /** The body of any selected line (plain or connector), for its piece and bend handles. */
  const editVerts = useMemo(() => {
    const v = selected ? lineVertices(selected) : null;
    return v ? normalise(v) : null;
  }, [selected]);

  // The tidy-lines proposal for the page: every line gets a candidate, those that change are shown.
  const tidyAll = useMemo(() => (tidy ? tidyRoutes(page.shapes, buildTopology(page.shapes)) : []), [tidy, page]);
  const tidyChanged = useMemo(() => {
    const key = (pts: { x: number; y: number }[]) => pts.map((p) => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`).join(";");
    return tidyAll.filter((i) => key(i.before) !== key(i.after));
  }, [tidyAll]);
  const selectedLine = selected && lineVertices(selected) ? selected.id : null;
  const tidyShown = tidy?.scope === "selection" ? tidyChanged.filter((i) => i.lineId === selectedLine) : tidyChanged;
  const editing = editingId ? shapeById.get(editingId) : undefined;

  // --- view -------------------------------------------------------------------------------

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit once when the page is first shown; edits and window resizes must not move the view.
  useLayoutEffect(() => {
    if (!size || fitted.current) return;
    fitted.current = true;
    setView(viewFor(pageBounds(page), size.w, size.h, true));
  }, [page, size]);

  const fit = useCallback(() => {
    if (size) setView(viewFor(pageBounds(page), size.w, size.h, true));
  }, [page, size]);

  const reset = useCallback(() => {
    if (size) {
      setView(viewFor({ x: 0, y: 0, width: page.width, height: page.height }, size.w, size.h, false));
    }
  }, [page, size]);

  const zoomCentre = useCallback(
    (factor: number) => {
      if (size) setView((v) => zoomAt(v, factor, size.w / 2, size.h / 2));
    },
    [size],
  );

  /** Bring a region of the page into view, without zooming in past 150%. */
  const focusOn = useCallback(
    (b: Bounds) => {
      if (!size) return;
      const padded = { x: b.x - 140, y: b.y - 100, width: b.width + 280, height: b.height + 200 };
      const fitted = viewFor(padded, size.w, size.h, true);
      if (fitted.scale <= 1.5) return setView(fitted);
      setView({
        scale: 1.5,
        tx: size.w / 2 - (b.x + b.width / 2) * 1.5,
        ty: size.h / 2 - (b.y + b.height / 2) * 1.5,
      });
    },
    [size],
  );

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const lineScale = e.deltaMode === 1 ? 16 : 1;
      const speed = e.ctrlKey ? 0.01 : 0.0015;
      const factor = Math.exp(-e.deltaY * lineScale * speed);
      setView((v) => zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /**
   * Client coordinates -> page px. During a drag the canvas position from the moment of
   * the press is used, so a layout change mid-drag can't make the shape jump.
   */
  const toPage = (e: { clientX: number; clientY: number }, rect?: DOMRect) => {
    const r = rect ?? host.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (e.clientX - r.left - v.tx) / v.scale, y: (e.clientY - r.top - v.ty) / v.scale };
  };

  // --- selection helpers ------------------------------------------------------------------

  /** Editable shapes under a hit, innermost first, ending at the outermost group. */
  const chainOf = (id: string): string[] => {
    const out: string[] = [];
    let cur = shapeById.get(id);
    while (cur) {
      if (session.isEditable(page.id, cur.id)) out.push(cur.id);
      cur = cur.parentId ? shapeById.get(cur.parentId) : undefined;
    }
    return out;
  };
  const hitShapeId = (target: EventTarget | null) =>
    (target as Element | null)?.closest?.("[data-shape-id]")?.getAttribute("data-shape-id") ?? null;

  const currentShape = (id: string) =>
    session.document.pages.find((p) => p.id === page.id)?.shapes.find((s) => s.id === id);

  /** The shape (whole group, not a part) a connector could attach to at this hit, if any. */
  const connectableAt = (hit: string | null): DiagramShape | undefined => {
    const chain = hit ? chainOf(hit) : [];
    const root = chain.length ? shapeById.get(chain[chain.length - 1]) : undefined;
    return root && !root.connector && !lineVertices(root) ? root : undefined;
  };

  /**
   * What a connector end dropped at the pointer would attach to: a port (snapped when the
   * pointer is near one), a shape (best side chosen automatically), or just empty space.
   */
  const targetAt = (e: { clientX: number; clientY: number }, pt: Point, exclude?: string): ConnectTarget => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const port = el?.closest("[data-port]")?.getAttribute("data-port");
    if (port) {
      const k = port.lastIndexOf(":");
      if (port.slice(0, k) !== exclude) return { shapeId: port.slice(0, k), side: port.slice(k + 1) as Side };
    }
    const root = connectableAt(hitShapeId(el));
    if (root && root.id !== exclude) {
      const near = nearestPort(root, pt);
      const snapped = Math.hypot(near.point.x - pt.x, near.point.y - pt.y) < 18 / viewRef.current.scale;
      return snapped ? { shapeId: root.id, side: near.side } : { shapeId: root.id };
    }
    // Nothing under the pointer: the magnet still pulls it onto a port or an outline close by.
    const hit = snapPoint(page.shapes, pt, viewRef.current.scale, exclude ? new Set([exclude]) : undefined);
    if (hit) return hit.kind === "port" ? { shapeId: hit.shapeId, side: hit.side } : { shapeId: hit.shapeId };
    return { point: pt };
  };

  const createShape = async (kind: Exclude<Tool, "select" | "connector" | "area">, pt: { x: number; y: number }) => {
    setTool("select");
    const id = await session.addShape(page.id, kind, pt);
    setSelectedId(id);
    if (kind === "text") setEditingId(id);
  };

  // --- pointer ------------------------------------------------------------------------------

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || editingId) return;
    const target = e.target as Element;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (some touch/pen/synthetic events): dragging still works without capture.
    }
    const rect = host.current!.getBoundingClientRect();
    const pt = toPage(e, rect);
    const client = { x: e.clientX, y: e.clientY };

    // Start drawing a connector: from a port, from a shape, or (with the connector tool) from empty space.
    const startConnect = (): boolean => {
      const port = target.closest("[data-port]")?.getAttribute("data-port");
      let from: ConnectTarget | undefined;
      if (port) {
        const k = port.lastIndexOf(":");
        from = { shapeId: port.slice(0, k), side: port.slice(k + 1) as Side };
      } else if (tool === "connector") {
        const root = connectableAt(hitShapeId(target));
        from = root ? { shapeId: root.id, side: nearestPort(root, pt).side } : { point: pt };
      }
      if (!from) return false;
      drag.current = { mode: "connect", from, to: { point: pt }, startClient: client, rect };
      return true;
    };
    if (tool === "area") {
      // A drag draws the box; a plain click on a shape boxes that shape (its whole group).
      let top = hitShapeId(target);
      while (top && shapeById.get(top)?.parentId) top = shapeById.get(top)!.parentId!;
      drag.current = { mode: "marquee", from: pt, rect, hit: top };
      setRegion({ x: pt.x, y: pt.y, width: 0, height: 0 });
      return;
    }
    if (monitorOpen) {
      // Monitor: a click on a node switches it off or on (on release, so a drag still pans).
      let top = hitShapeId(target);
      while (top && shapeById.get(top)?.parentId) top = shapeById.get(top)!.parentId!;
      drag.current = { mode: "pan", last: client, start: client, onEmpty: false, moved: false, toggle: top && topology?.nodes.has(top) ? top : undefined };
      setPanning(true);
      return;
    }
    if (!canEdit) {
      // Viewer: a press picks a shape (for the analysis) and a drag only pans.
      const hit = hitShapeId(target);
      const chain = hit ? chainOf(hit) : [];
      const id = chain.length ? chain[chain.length - 1] : null;
      setSelectedId(id);
      if (id && analysisOpen && topology?.nodes.has(id)) pickSource(id, e.shiftKey);
      drag.current = { mode: "pan", last: client, start: client, onEmpty: !id, moved: false };
      setPanning(true);
      return;
    }
    if (tool === "connector") {
      startConnect();
      return;
    }
    if (tool !== "select") {
      drag.current = { mode: "none" };
      void createShape(tool, pt);
      return;
    }
    if (startConnect()) return;

    const endpoint = target.closest("[data-endpoint]")?.getAttribute("data-endpoint");
    if (selected && endpoint && (selected.connector || selectedVerts)) {
      drag.current = {
        mode: "endpoint",
        polyline: !selected.connector,
        id: selected.id,
        end: endpoint as "begin" | "end",
        to: { point: pt },
        startClient: client,
        rect,
      };
      return;
    }

    const bend = target.closest("[data-bend]")?.getAttribute("data-bend");
    const piece = target.closest("[data-piece]");
    if (selected && editVerts && (bend || piece)) {
      drag.current = {
        mode: "reshape",
        id: selected.id,
        kind: bend ? "bend" : piece!.getAttribute("data-split") ? "split" : "piece",
        index: Number(bend ?? piece!.getAttribute("data-piece")),
        verts: editVerts,
        startPt: pt,
        startClient: client,
        rect,
      };
      return;
    }

    const handle = target.closest("[data-handle]")?.getAttribute("data-handle");
    if (handle && selected) {
      const start = placementOf(selected);
      const resizing = handle !== "rot";
      let grab = { x: 0, y: 0 };
      if (resizing) {
        const [hx, hy] = handlePoint(handle as Handle, start.width, start.height);
        const [px, py] = applyMatrix(placementMatrix(start), hx, hy);
        grab = { x: pt.x - px, y: pt.y - py };
      }
      drag.current = {
        mode: resizing ? "resize" : "rotate",
        handle: resizing ? (handle as Handle) : undefined,
        id: selected.id,
        start,
        startClient: client,
        startPt: pt,
        rect,
        grab,
        drill: null,
      };
      return;
    }

    const hit = hitShapeId(target);
    const chain = hit ? chainOf(hit) : [];
    if (chain.length === 0) {
      setSelectedId(null);
      drag.current = { mode: "pan", last: client, start: client, onEmpty: true, moved: false };
      setPanning(true);
      return;
    }

    // A press inside the current selection drags it; a plain click then drills into the child.
    const k = selectedId ? chain.indexOf(selectedId) : -1;
    const id = k >= 0 ? selectedId! : chain[chain.length - 1];
    const drill = k > 0 ? chain[k - 1] : null;
    if (k < 0) {
      setSelectedId(id);
      if (analysisOpen && topology?.nodes.has(id)) pickSource(id, e.shiftKey);
    }
    const shape = shapeById.get(id)!;
    drag.current = {
      mode: "move",
      id,
      start: placementOf(shape),
      startClient: client,
      startPt: pt,
      rect,
      grab: { x: 0, y: 0 },
      drill,
    };
  };

  /** Recompute the route preview for a connector drag. */
  const updatePreview = (e: React.PointerEvent, d: Extract<Drag, { mode: "connect" | "endpoint" }>) => {
    if (Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y) < DRAG_THRESHOLD) return;
    const pt = toPage(e, d.rect);
    // Attached to a shape, the route only depends on the shape and side, not on the pointer.
    const stillThere = (to: ConnectTarget) => {
      const key = to.shapeId !== undefined ? `${to.shapeId}:${to.side ?? ""}` : undefined;
      if (key !== undefined && key === d.planned) return true;
      d.planned = key;
      return false;
    };
    if (d.mode === "connect") {
      const to = targetAt(e, pt, d.from.shapeId);
      d.to = to;
      if (stillThere(to)) return;
      const plan = session.planConnector(page.id, d.from, to, "elbow");
      setPreview({ points: plan.points, target: to });
      return;
    }
    if (d.polyline) {
      const verts = lineVertices(shapeById.get(d.id)!);
      if (!verts) return;
      const hit = snapPoint(page.shapes, pt, viewRef.current.scale, new Set([d.id]));
      const to = hit?.point ?? pt;
      d.toPoint = to;
      setPreview({
        points: followEndpoints(verts, d.end === "begin" ? { start: to } : { end: to }),
        target: hit ? { shapeId: hit.shapeId, side: hit.side } : undefined,
        dragging: d.end,
        snap: hit,
      });
      return;
    }
    const line = shapeById.get(d.id);
    const c = line?.connector;
    if (!c) return;
    d.to = targetAt(e, pt, d.id);
    if (stillThere(d.to)) return;
    const fixed: ConnectTarget =
      d.end === "begin"
        ? { shapeId: c.end.shapeId, side: c.route?.endSide, point: c.end.point }
        : { shapeId: c.begin.shapeId, side: c.route?.beginSide, point: c.begin.point };
    const style = c.route?.style ?? "straight";
    const plan =
      d.end === "begin"
        ? session.planConnector(page.id, d.to, fixed, style)
        : session.planConnector(page.id, fixed, d.to, style);
    setPreview({ points: plan.points, target: d.to, dragging: d.end });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) {
      // No button down: show the ports of the shape under the pointer.
      if (!editingId && canEdit) {
        const id = connectableAt(hitShapeId(e.target) ?? ((e.target as Element).closest("[data-port]")?.getAttribute("data-port")?.split(":")[0] ?? null))?.id ?? null;
        setHoverId((cur) => (cur === id ? cur : id));
      }
      return;
    }
    if (d.mode === "none") return;
    if (d.mode === "marquee") {
      setRegion(regionBetween(d.from, toPage(e, d.rect)));
      return;
    }
    if (d.mode === "connect" || d.mode === "endpoint") {
      updatePreview(e, d);
      return;
    }
    if (d.mode === "reshape") {
      if (!d.points && Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y) < DRAG_THRESHOLD) return;
      const pt = toPage(e, d.rect);
      const tol = 6 / viewRef.current.scale;
      const v = d.verts;
      let pts: Point[];
      if (d.kind === "bend") {
        const others = v.filter((_, k) => k !== d.index);
        pts = moveBend(v, d.index, { x: pullTo(pt.x, others.map((p) => p.x), tol), y: pullTo(pt.y, others.map((p) => p.y), tol) });
      } else if (d.kind === "split") {
        pts = splitPiece(v, { x: pullTo(pt.x, v.map((p) => p.x), tol), y: pullTo(pt.y, v.map((p) => p.y), tol) });
      } else {
        const kind = pieceKind(v[d.index], v[d.index + 1]);
        const delta = { x: pt.x - d.startPt.x, y: pt.y - d.startPt.y };
        // a piece lines up with the pieces on either side of it when it passes them
        if (kind === "horizontal") delta.y = pullTo(v[d.index].y + delta.y, [v[d.index - 1].y, v[d.index + 2].y], tol) - v[d.index].y;
        if (kind === "vertical") delta.x = pullTo(v[d.index].x + delta.x, [v[d.index - 1].x, v[d.index + 2].x], tol) - v[d.index].x;
        pts = movePiece(v, d.index, delta);
      }
      d.points = pts;
      setPreview({ points: pts, reshape: true });
      return;
    }
    if (d.mode === "pan") {
      if (Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) >= DRAG_THRESHOLD) d.moved = true;
      const dx = e.clientX - d.last.x;
      const dy = e.clientY - d.last.y;
      d.last = { x: e.clientX, y: e.clientY };
      setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
      return;
    }
    if (
      !d.edit &&
      Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y) < DRAG_THRESHOLD
    ) {
      return;
    }
    d.edit ??= session.beginTransform(page.id, d.id);

    const pt = toPage(e, d.rect);
    const p: Placement =
      d.mode === "move"
        ? { ...d.start, x: d.start.x + pt.x - d.startPt.x, y: d.start.y + pt.y - d.startPt.y }
        : d.mode === "resize"
          ? resizePlacement(d.start, d.handle!, { x: pt.x - d.grab.x, y: pt.y - d.grab.y })
          : rotatePlacement(d.start, pt, e.shiftKey ? 15 : undefined);
    d.edit.update(p);
  };

  const endDrag = (cancelled = false) => {
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    if (d?.mode === "reshape") {
      setPreview(null);
      if (!cancelled && d.points) session.setLinePoints(page.id, d.id, d.points);
      return;
    }
    if (d && (d.mode === "connect" || d.mode === "endpoint")) {
      const shown = preview;
      setPreview(null);
      if (cancelled || !shown) return;
      if (d.mode === "connect") {
        void session.createConnector(page.id, d.from, d.to, "elbow").then((id) => {
          setSelectedId(id);
          setTool("select");
        });
      } else if (d.polyline) {
        if (d.toPoint) session.moveLineEnd(page.id, d.id, d.end, d.toPoint);
      } else {
        session.reconnectEnd(page.id, d.id, d.end, d.to);
      }
      return;
    }
    if (d?.mode === "marquee") {
      // A click, or a box too small to be meant, clears the choice.
      const clicked = d.hit ? shapeById.get(d.hit) : undefined;
      setRegion((r) => {
        if (cancelled) return null;
        if (r && r.width * view.scale >= 8 && r.height * view.scale >= 8) return r;
        return clicked ? shapeBounds(clicked, 12) : null;
      });
      return;
    }
    if (d?.mode === "pan") {
      // A click (not a drag) on empty space lets go of the node whose failure is being examined.
      if (d.onEmpty && !d.moved && !cancelled && analysisOpen) setSource(null);
      const t = d.toggle;
      if (t && !d.moved && !cancelled) setOff((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
      return;
    }
    if (!d || d.mode === "none") return;
    if (d.edit) {
      if (cancelled) d.edit.cancel();
      else d.edit.commit(d.mode === "move" ? "Move" : d.mode === "resize" ? "Resize" : "Rotate");
    } else if (d.mode === "move" && d.drill && !cancelled) {
      setSelectedId(d.drill);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!canEdit || tool !== "select") return;
    // The press captured the pointer on the canvas, so the event's target is the canvas
    // itself, not the shape under the cursor: look the shape up by position instead.
    const hit = hitShapeId(document.elementFromPoint(e.clientX, e.clientY) ?? e.target);
    const chain = hit ? chainOf(hit) : [];
    if (chain.length === 0) return;
    setSelectedId(chain[0]);
    setEditingId(chain[0]);
  };

  // --- commands -----------------------------------------------------------------------------

  const undo = () => void session.undo();
  const redo = () => void session.redo();
  const del = () => {
    if (!selected) return;
    session.deleteShapes(page.id, [selected.id]);
    setSelectedId(null);
  };
  const setStyle = (patch: StylePatch, key: string) => {
    if (selected) session.setStyle(page.id, [selected.id], patch, key);
  };
  const setConnector = (patch: ConnectorPatch) => {
    if (selected) session.setConnectorStyle(page.id, selected.id, patch);
  };
  const save = async () => {
    setSaving(true);
    try {
      const name = await saveToDisk(session);
      if (name) setStatus({ ok: true, text: `Saved ${name}` });
    } catch (err) {
      setStatus({ ok: false, text: `Save failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      setSaving(false);
    }
  };
  const applyTidy = () => {
    if (tidyShown.length === 0) return;
    session.tidyLines(page.id, tidyShown.map((i) => ({ id: i.lineId, points: i.after })));
    setStatus({ ok: true, text: `Tidied ${tidyShown.length} ${tidyShown.length === 1 ? "line" : "lines"} (Undo brings them back)` });
    setTidy(null);
  };

  const changeMode = (m: Mode) => {
    if (m === mode) return;
    if (m === "viewer") {
      setTidy(null);
      drag.current = null;
      setPreview(null);
      setEditingId(null);
      setHoverId(null);
      if (tool !== "area") setTool("select");
    }
    onMode(m);
  };

  const exportRegion = async (bounds: Bounds, wanted: number) => {
    const svg = host.current?.querySelector("svg");
    const layers = [
      svg?.querySelector("g[data-page]"),
      // The analysis marks, when a result is on show, go into the picture too.
      svg?.querySelector('g[data-analysis="result"]'),
    ].filter((l): l is SVGGraphicsElement => !!l);
    if (layers.length === 0) return;
    setExporting(true);
    try {
      const { blob, width, height, scale } = await renderPng(layers, bounds, wanted);
      downloadBlob(blob, `${page.name.replace(/[^\w.-]+/g, "_") || "page"}.png`);
      setStatus({
        ok: true,
        text: `Exported ${width} × ${height} px PNG${scale < wanted ? ` (scaled down to ${scale.toFixed(2)}×: too large)` : ""}`,
      });
    } catch (err) {
      setStatus({ ok: false, text: `Export failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      setExporting(false);
    }
  };
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), status.ok ? 4000 : 10000);
    return () => clearTimeout(t);
  }, [status]);

  // --- keyboard -----------------------------------------------------------------------------

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (session.dirty && !saving) void save();
      return;
    }
    // Esc lets go of the node whose failure is being examined, even from the search box.
    if (e.key === "Escape" && analysisOpen && source && !editingId) {
      setSource(null);
      setSelectedId(null);
      setFocusLine(null);
      if (t && /^(INPUT|SELECT)$/.test(t.tagName)) t.blur();
      return;
    }
    if (typing || editingId) return;
    if (e.key === "Escape") {
      drag.current = null;
      setPreview(null);
      setRegion(null);
      setTidy(null);
      setTool("select");
      setSelectedId(null);
    } else if (!canEdit) {
      return; // the viewer has no shortcuts that change the diagram
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    } else if (selected && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      del();
    } else if (selected && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      const id = selected.id;
      void session.idle().then(() => {
        const cur = currentShape(id);
        if (cur) {
          session.setPlacement(page.id, id, { ...placementOf(cur), x: cur.x + dx, y: cur.y + dy }, "Nudge", `nudge:${id}`);
        }
      });
    }
  };
  useLayoutEffect(() => {
    keyHandler.current = onKey; // always the handler that closes over the latest state
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const resizable = !!selected && selected.type !== "group" && !isLineLike(selected);
  const rotatable = !!selected && !isLineLike(selected);

  return (
    <div className="viewer">
      <EditToolbar
        mode={mode}
        onMode={changeMode}
        tool={tool}
        onTool={(t) => {
          setTool(t);
          if (t !== "area") setRegion(null);
          if (t === "area") setTidy(null);
        }}
        tidying={!!tidy}
        onTidy={() => {
          setTidy((cur) => (cur ? null : { scope: selectedLine ? "selection" : "page" }));
          setTool("select");
          setRegion(null);
        }}
        canUndo={session.canUndo}
        canRedo={session.canRedo}
        hasSelection={!!selected}
        dirty={session.dirty}
        saving={saving}
        status={status}
        onUndo={undo}
        onRedo={redo}
        onDelete={del}
        onFront={() => selected && session.reorder(page.id, selected.id, "front")}
        onBack={() => selected && session.reorder(page.id, selected.id, "back")}
        onSave={() => void save()}
        onExportSelection={() => {
          if (!selected) return;
          setRegion(shapeBounds(selected, 12));
          setTool("area");
        }}
        analyzing={analysisOpen}
        onAnalyze={() => {
          setAnalysisOpen((v) => !v);
          setMonitorOpen(false);
        }}
        monitoring={monitorOpen}
        onMonitor={() => {
          setMonitorOpen((v) => !v);
          setAnalysisOpen(false);
          setSelectedId(null);
        }}
      />
      <div className="workarea">
      <div className="stage">
        {tool === "area" && (
          <ExportBar
            region={region}
            busy={exporting}
            onWholePage={() => setRegion(pageBounds(page))}
            onExport={(scale) => region && void exportRegion(region, scale)}
            onClose={() => {
              setRegion(null);
              setTool("select");
            }}
          />
        )}
        {tidy && canEdit && (
          <TidyBar
            changing={tidyShown.length}
            lines={tidyAll.length}
            crowdedBefore={routeStats(tidyAll.map((i) => i.before)).tight}
            crowdedAfter={routeStats(tidyAll.map((i) => i.after)).tight}
            scope={tidy.scope}
            canSelection={!!selectedLine}
            onScope={(scope) => setTidy({ scope })}
            onApply={applyTidy}
            onCancel={() => setTidy(null)}
          />
        )}
        {canEdit && selected && tool !== "area" && !tidy && (
          <div className="inspector-float">
            <Inspector key={selected.id} shape={selected} onStyle={setStyle} onConnector={setConnector} />
          </div>
        )}
      <div
        ref={host}
        className={`canvas${panning ? " panning" : ""}${tool !== "select" ? " creating" : ""}${canEdit ? " editable" : ""}${monitorOpen ? " monitoring" : ""}`}
        onPointerLeave={() => setHoverId(null)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endDrag()}
        onPointerCancel={() => endDrag(true)}
        onDoubleClick={onDoubleClick}
      >
        <svg width="100%" height="100%" role="img" aria-label={`Visio page ${page.name}`}>
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
            <rect
              className="page-sheet"
              width={page.width}
              height={page.height}
              fill="#fff"
              stroke="#c4c4c4"
              vectorEffect="non-scaling-stroke"
            />
            <DiagramRenderer page={page} />
            {selectedVerts && !editing && (
              <>
                <PathHighlight points={selectedVerts} />
                {!canEdit && <BendMarks points={selectedVerts} scale={view.scale} />}
                {canEdit && (
                  <EndpointHandles
                    begin={selectedVerts[0]}
                    end={selectedVerts[selectedVerts.length - 1]}
                    scale={view.scale}
                    hidden={preview?.dragging}
                  />
                )}
              </>
            )}
            {selected?.connector && !editing && (
              <>
                <PathHighlight points={lineVertices(selected) ?? []} />
                {canEdit && (
                <EndpointHandles
                  begin={selected.connector.begin.point}
                  end={selected.connector.end.point}
                  scale={view.scale}
                  hidden={preview?.dragging}
                />
                )}
              </>
            )}
            {(() => {
              const targetId = preview?.target?.shapeId ?? hoverId;
              const shape = targetId ? shapeById.get(targetId) : undefined;
              return canEdit && shape && !editing && tool !== "area" ? (
                <PortsOverlay shape={shape} scale={view.scale} active={preview?.target?.side} />
              ) : null;
            })()}
            {monitorView && <MonitorOverlay nodes={monitorView.nodes} flows={monitorView.flows} stopped={monitorView.stopped} scale={view.scale} />}
            {overlay && (
              <AnalysisOverlay
                page={page}
                nodes={overlay.nodes}
                lines={overlay.lines}
                focusLine={focusLineVertices}
                scale={view.scale}
              />
            )}
            {!overlay && focusLineVertices && (
              <AnalysisOverlay page={page} nodes={[]} lines={[]} focusLine={focusLineVertices} scale={view.scale} />
            )}
            {tidy && canEdit && <TidyOverlay items={tidyShown} />}
            {tool === "area" && region && <RegionOverlay region={region} page={pageBounds(page)} />}
            {canEdit && editVerts && !editing && !preview && <LineHandles points={editVerts} scale={view.scale} />}
            {preview && <RoutePreview points={preview.points} scale={view.scale} dot={!preview.reshape} />}
            {preview?.snap && (
              <SnapMarker
                point={preview.snap.point}
                kind={preview.snap.kind}
                scale={view.scale}
                outline={(() => {
                  const sh = shapeById.get(preview.snap.shapeId);
                  return sh ? frameCorners(sh) : undefined;
                })()}
              />
            )}
            {selected && !selected.connector && !selectedVerts && !editing && (
              <SelectionOverlay
                shape={selected}
                scale={view.scale}
                resizable={canEdit && resizable}
                rotatable={canEdit && rotatable}
              />
            )}
          </g>
        </svg>
        {editing && (
          <TextEditor
            key={editing.id}
            shape={editing}
            view={view}
            onCommit={(text) => {
              session.setText(page.id, editing.id, editing.text ?? "", text);
              setEditingId(null);
            }}
            onCancel={() => setEditingId(null)}
          />
        )}
      </div>
      </div>
      {monitorOpen && topology && sim && (
        <MonitorPanel
          topology={topology}
          sim={sim}
          off={off}
          onOff={setOff}
          onFocusNode={(id) => {
            const shape = shapeById.get(id);
            if (shape) focusOn(rectOf(shape));
          }}
          onClose={() => setMonitorOpen(false)}
        />
      )}
      {analysisOpen && topology && (
        <AnalysisPanel
          topology={topology}
          ha={ha!}
          onGroups={(changes) => session.setHaGroups(page.id, changes)}
          sources={sources}
          onSources={setSources}
          onFocusNode={(id) => {
            const shape = shapeById.get(id);
            if (shape) focusOn(rectOf(shape));
          }}
          focusLine={focusLine}
          onFocusLine={(id) => {
            setFocusLine(id);
            const v = id ? (shapeById.get(id) && lineVertices(shapeById.get(id)!)) : null;
            if (v) {
              const xs = v.map((p) => p.x);
              const ys = v.map((p) => p.y);
              focusOn({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
            }
          }}
          onConfirm={(lineId, links) => session.setLineLinks(page.id, lineId, links)}
          onClose={() => setAnalysisOpen(false)}
        />
      )}
      </div>
      <ViewerToolbar
        left={pageTabs}
        scale={view.scale}
        onZoomIn={() => zoomCentre(BUTTON_ZOOM)}
        onZoomOut={() => zoomCentre(1 / BUTTON_ZOOM)}
        onFit={fit}
        onReset={reset}
      />
    </div>
  );
}
