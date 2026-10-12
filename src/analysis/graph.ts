/**
 * The topology of a page: which nodes are connected, in which direction.
 *
 * Lines in many diagrams are plain polylines with no glue, so what a line
 * connects is worked out from where its ends are. Where that is clear (an end
 * on one node's border, or glued to it) the connection is `certain`. An end on
 * the border of a zone frame, or on nothing, is not clear: the line is left for
 * the user to settle, and what they choose is kept in `DiagramShape.links`.
 */
import {
  ATTACH_TOLERANCE,
  borderDistance,
  insideFrame,
  lineVertices,
  subtreeIds,
} from "../edit/connectors";
import type { DiagramShape, Point } from "../model/types";
import { extractCandidates, type AnalysisNode } from "./nodes";

/** What one end of a line is attached to. */
export interface LineEnd {
  /** `node`: resolved; `zone`: touches a zone frame; `none`: touches nothing. */
  kind: "node" | "zone" | "none";
  /** The nodes it connects to when resolved. */
  nodeIds: string[];
  /** How we know: from the file's glue, the user's confirmation, or the geometry. */
  source: "glue" | "confirmed" | "geometry" | "junction" | "none";
  /** Nodes the user could pick for an unresolved end (the zone's members, nearest first). */
  candidates: string[];
  zoneId?: string;
  point: Point;
}

export interface LineInfo {
  lineId: string;
  begin: LineEnd;
  end: LineEnd;
  /** Where the arrow heads are. */
  arrows: "end" | "begin" | "both" | "none";
  colour?: string;
  /** Both ends resolved: the line contributes edges. */
  resolved: boolean;
}

/**
 * A connection between two nodes. `forward`: `a` calls `b` (the arrow points at b);
 * `both`: arrows at both ends; `none`: no arrow, so no known direction.
 */
export interface Edge {
  lineId: string;
  a: string;
  b: string;
  kind: "forward" | "both" | "none";
  /** Contributed by an unresolved line, guessed from its zone's members. */
  pending?: boolean;
  colour?: string;
}

export interface Topology {
  nodes: Map<string, AnalysisNode>;
  zones: DiagramShape[];
  /** Zone id -> its name ("LOS DC1"), where the diagram gives one. */
  zoneNames: Map<string, string>;
  lines: LineInfo[];
  /** Edges from resolved lines. */
  edges: Edge[];
  /** Edges that unresolved lines would add if every candidate were right (an upper bound). */
  possibleEdges: Edge[];
}

function arrowsOf(line: DiagramShape): LineInfo["arrows"] {
  const b = !!line.style.beginArrow;
  const e = !!line.style.endArrow;
  return b && e ? "both" : e ? "end" : b ? "begin" : "none";
}

/** Walk up to the top-level shape that is a node, if the shape is part of one. */
function nodeOf(shapes: Map<string, DiagramShape>, nodes: Map<string, AnalysisNode>, id: string): string | undefined {
  let cur = shapes.get(id);
  while (cur) {
    if (nodes.has(cur.id)) return cur.id;
    cur = cur.parentId ? shapes.get(cur.parentId) : undefined;
  }
  return undefined;
}

export function buildTopology(shapes: DiagramShape[]): Topology {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const { nodes: candidates, zones, zoneNames, labels } = extractCandidates(shapes);
  const frames = new Map(candidates.map((n) => [n.id, byId.get(n.id)!]));
  /** Every frame a line end can land on, and the node it stands for (labels stand for their tile). */
  const targets = [
    ...candidates.map((n) => ({ nodeId: n.id, s: byId.get(n.id)! })),
    ...[...labels].map(([labelId, hostId]) => ({ nodeId: hostId, s: byId.get(labelId)! })),
  ];

  // Everything drawn inside a node (its icon, its caption, decorative lines) is part of it.
  const insideNode = new Set<string>();
  for (const n of candidates) for (const id of subtreeIds(shapes, n.id)) insideNode.add(id);
  for (const labelId of labels.keys()) for (const id of subtreeIds(shapes, labelId)) insideNode.add(id);

  const nodeMap = new Map(candidates.map((n) => [n.id, n]));
  const resolveEnd = (
    line: DiagramShape,
    which: "begin" | "end",
    point: Point,
  ): LineEnd => {
    const empty = (kind: LineEnd["kind"], extra: Partial<LineEnd> = {}): LineEnd => ({
      kind,
      nodeIds: [],
      source: "none",
      candidates: [],
      point,
      ...extra,
    });

    // 1. what the user confirmed
    const confirmed = line.links?.[which];
    if (confirmed && confirmed.length > 0) {
      const ids = confirmed.map((id) => nodeOf(byId, nodeMap, id)).filter((x): x is string => !!x);
      if (ids.length > 0) return { ...empty("node"), nodeIds: [...new Set(ids)], source: "confirmed" };
    }
    // 2. the file's own glue
    const glued = line.connector?.[which].shapeId;
    const gluedNode = glued !== undefined ? nodeOf(byId, nodeMap, glued) : undefined;
    if (gluedNode) return { ...empty("node"), nodeIds: [gluedNode], source: "glue" };

    // 3. geometry: the node whose border the end touches (the closest, then the smallest)
    const touching = targets
      .map(({ nodeId, s }) => ({ nodeId, s, d: insideFrame(s, point, ATTACH_TOLERANCE) ? borderDistance(s, point) : Infinity }))
      .filter((x) => x.d <= ATTACH_TOLERANCE)
      .sort((a, b) => a.d - b.d || a.s.width * a.s.height - b.s.width * b.s.height);
    if (touching.length > 0) return { ...empty("node"), nodeIds: [touching[0].nodeId], source: "geometry" };

    // 4. an end that lies on a zone frame: it could be any node inside
    const zone = zones
      .filter((z) => insideFrame(z, point, ATTACH_TOLERANCE) && borderDistance(z, point) <= ATTACH_TOLERANCE)
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    if (zone) {
      const members = candidates
        .filter((n) => n.zones.includes(zone.id))
        .map((n) => ({ id: n.id, d: borderDistance(frames.get(n.id)!, point) }))
        .sort((a, b) => a.d - b.d)
        .map((x) => x.id);
      return empty("zone", { zoneId: zone.id, candidates: members });
    }
    // 5. the end sits inside a node's frame (a line drawn over a tile)
    const over = targets.find(({ s }) => insideFrame(s, point));
    if (over) return { ...empty("node"), nodeIds: [over.nodeId], source: "geometry" };
    return empty("none");
  };

  const lines: LineInfo[] = [];
  for (const s of shapes) {
    if (insideNode.has(s.id) || s.id.startsWith("bg")) continue;
    const pts = lineVertices(s) ?? (s.connector ? [s.connector.begin.point, s.connector.end.point] : null);
    if (!pts) continue;
    const begin = resolveEnd(s, "begin", pts[0]);
    const end = resolveEnd(s, "end", pts[pts.length - 1]);
    lines.push({
      lineId: s.id,
      begin,
      end,
      arrows: arrowsOf(s),
      colour: s.style.stroke,
      resolved: begin.kind === "node" && end.kind === "node",
    });
  }

  // A line that starts on another line (a branch off a shared trunk) calls what that trunk's
  // sending end is attached to. Only when the trunk has a single arrow, so its direction is known.
  const polyline = new Map<string, Point[]>();
  for (const s of shapes) {
    const pts = lineVertices(s);
    if (pts) polyline.set(s.id, pts);
  }
  const onLine = (p: Point, pts: Point[]) =>
    pts.slice(1).some((b, i) => {
      const a = pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= ATTACH_TOLERANCE;
    });
  for (const l of lines) {
    for (const which of ["begin", "end"] as const) {
      const e = l[which];
      if (e.kind !== "none") continue;
      const trunk = lines.find(
        (o) =>
          o !== l &&
          (o.arrows === "end" || o.arrows === "begin") &&
          polyline.has(o.lineId) &&
          onLine(e.point, polyline.get(o.lineId)!),
      );
      if (!trunk) continue;
      const sender = trunk.arrows === "end" ? trunk.begin : trunk.end;
      if (sender.kind === "node") {
        l[which] = { ...e, kind: "node", nodeIds: sender.nodeIds, source: "junction" };
      }
    }
    l.resolved = l.begin.kind === "node" && l.end.kind === "node";
  }

  const edgesOf = (l: LineInfo, aIds: string[], bIds: string[], pending: boolean): Edge[] => {
    const out: Edge[] = [];
    for (const a of aIds) {
      for (const b of bIds) {
        if (a === b) continue;
        const kind: Edge["kind"] = l.arrows === "both" ? "both" : l.arrows === "none" ? "none" : "forward";
        // an arrow at the begin end means the end node is the caller
        out.push(l.arrows === "begin" ? { lineId: l.lineId, a: b, b: a, kind, pending, colour: l.colour } : { lineId: l.lineId, a, b, kind, pending, colour: l.colour });
      }
    }
    return out;
  };

  const edges: Edge[] = [];
  const possibleEdges: Edge[] = [];
  for (const l of lines) {
    if (l.resolved) {
      edges.push(...edgesOf(l, l.begin.nodeIds, l.end.nodeIds, false));
      continue;
    }
    const side = (e: LineEnd) => (e.kind === "node" ? e.nodeIds : e.kind === "zone" ? e.candidates : []);
    possibleEdges.push(...edgesOf(l, side(l.begin), side(l.end), true));
  }

  // A node is kept if its label names a machine, or if something is connected to it.
  const connected = new Set<string>();
  for (const l of lines) {
    for (const e of [l.begin, l.end]) for (const id of e.nodeIds) connected.add(id);
  }
  const kept = candidates.filter((n) => n.ips.length > 0 || n.hostnames.length > 0 || connected.has(n.id));
  const keptIds = new Set(kept.map((n) => n.id));
  // Labels such as a zone's title are not machines: they must not be offered as a choice.
  for (const l of lines) {
    l.begin.candidates = l.begin.candidates.filter((id) => keptIds.has(id));
    l.end.candidates = l.end.candidates.filter((id) => keptIds.has(id));
  }

  return {
    nodes: new Map(kept.map((n) => [n.id, n])),
    zones,
    zoneNames,
    lines,
    edges,
    possibleEdges: possibleEdges.filter((e) => keptIds.has(e.a) && keptIds.has(e.b)),
  };
}
