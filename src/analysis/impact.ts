/**
 * "If this node goes down, what is affected?" - answered in two directions,
 * because an arrow A -> B means "A calls B":
 *
 *  - `dependents`: who depends on the node. Anything that can reach it by following
 *    arrows is hit when it goes down (a DB down hurts the apps that call it).
 *  - `unreachable`: what can no longer be reached once the node is gone. These are
 *    the nodes that were reachable from the entry points of the diagram (the
 *    nodes nothing points to) and no longer are (backends behind a failed balancer).
 *
 * A line without an arrow has no known direction, so it counts both ways, and the
 * results that rely on one are marked `uncertain`.
 */
import type { AnalysisNode } from "./nodes";
import type { Edge, Topology } from "./graph";

export interface ImpactItem {
  nodeId: string;
  /** Number of connections between the failed node and this one. */
  hops: number;
  /**
   * Nodes on the way, from the failed node (first) to this one (last). For a dependent the
   * arrows run the other way (it calls ... calls the failed node).
   */
  path: string[];
  /** The path uses a line with no arrow, so the direction is a guess. */
  uncertain: boolean;
}

/** Why a node is only degraded: it still works, but a stand-in was lost. */
export type DegradedReason =
  | { kind: "peer"; lost: string[]; left: number; size: number }
  | { kind: "caller"; lost: string; served: string[] };

export interface DegradedItem extends ImpactItem {
  reason: DegradedReason;
}

export interface Impact {
  /** The first failed node. */
  source: string;
  /** Every failed node (one, unless several are taken down together). */
  sources: string[];
  /**
   * Who stops working because of the node (reverse of the arrows), nearest first. With
   * high-availability groups, a caller that can still reach a stand-in is not here but in `degraded`.
   */
  dependents: ImpactItem[];
  /** Still working, but without a spare: the failed node's stand-ins, and callers that lost one of their servers. */
  degraded: DegradedItem[];
  /** What is cut off from every entry point. `undefined` when the diagram has no entry point. */
  unreachable?: ImpactItem[];
  /** Entry points used for `unreachable`. */
  roots: string[];
}

interface Arc {
  to: string;
  /** From a line with no arrow. */
  guessed: boolean;
}

/** Directed arcs: `forward` gives a -> b, `both` and `none` give both directions. */
function arcs(edges: Edge[]): Map<string, Arc[]> {
  const out = new Map<string, Arc[]>();
  const add = (from: string, to: string, guessed: boolean) => {
    const list = out.get(from) ?? [];
    if (!list.some((x) => x.to === to && x.guessed === guessed)) list.push({ to, guessed });
    out.set(from, list);
  };
  for (const e of edges) {
    add(e.a, e.b, e.kind === "none");
    if (e.kind !== "forward") add(e.b, e.a, e.kind === "none");
  }
  return out;
}

function reverse(g: Map<string, Arc[]>): Map<string, Arc[]> {
  const out = new Map<string, Arc[]>();
  for (const [from, list] of g) {
    for (const a of list) {
      const r = out.get(a.to) ?? [];
      r.push({ to: from, guessed: a.guessed });
      out.set(a.to, r);
    }
  }
  return out;
}

/** Breadth-first search; keeps the shortest path to every node it reaches. */
function bfs(g: Map<string, Arc[]>, start: string | string[], skip?: Set<string>) {
  const reached = new Map<string, ImpactItem>();
  const queue: string[] = [];
  for (const st of Array.isArray(start) ? start : [start]) {
    if (skip?.has(st)) continue;
    reached.set(st, { nodeId: st, hops: 0, path: [st], uncertain: false });
    queue.push(st);
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const here = reached.get(cur)!;
    for (const arc of g.get(cur) ?? []) {
      if (skip?.has(arc.to) || reached.has(arc.to)) continue;
      reached.set(arc.to, {
        nodeId: arc.to,
        hops: here.hops + 1,
        path: [...here.path, arc.to],
        uncertain: here.uncertain || arc.guessed,
      });
      queue.push(arc.to);
    }
  }
  return reached;
}

export interface ImpactOptions {
  /** Entry points for the "unreachable" side; by default the nodes nothing points to. */
  roots?: string[];
  /** Node id -> id of its high-availability group (see `readGroups`). */
  groups?: Map<string, string>;
}

/**
 * Dependents when nodes can stand in for one another. A caller stops working when, for
 * one of the groups it calls (a node outside any group is a group of one), every member it
 * is connected to is down; this repeats until nothing more falls. A caller that lost some
 * members but not all - and the failed node's surviving stand-ins - are degraded.
 */
function withGroups(
  nodes: Map<string, AnalysisNode>,
  forward: Map<string, Arc[]>,
  backward: Map<string, Arc[]>,
  sources: string[],
  groupOf: Map<string, string>,
) {
  const source = sources[0];
  const gid = (id: string) => groupOf.get(id) ?? `solo:${id}`;
  const calleeGroups = (n: string) => {
    const by = new Map<string, string[]>();
    for (const a of forward.get(n) ?? []) {
      if (a.to === n || !nodes.has(a.to)) continue;
      const list = by.get(gid(a.to)) ?? [];
      if (!list.includes(a.to)) list.push(a.to);
      by.set(gid(a.to), list);
    }
    return by;
  };

  const down = new Set(sources);
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of forward.keys()) {
      if (down.has(n) || !nodes.has(n)) continue;
      if ([...calleeGroups(n).values()].some((callees) => callees.every((c) => down.has(c)))) {
        down.add(n);
        changed = true;
      }
    }
  }

  // The way each fallen node leads to the failed one, through fallen nodes only.
  const reached = new Map<string, ImpactItem>(
    sources.map((x) => [x, { nodeId: x, hops: 0, path: [x], uncertain: false }]),
  );
  const queue = [...sources];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const here = reached.get(cur)!;
    for (const arc of backward.get(cur) ?? []) {
      if (!down.has(arc.to) || reached.has(arc.to)) continue;
      reached.set(arc.to, { nodeId: arc.to, hops: here.hops + 1, path: [...here.path, arc.to], uncertain: here.uncertain || arc.guessed });
      queue.push(arc.to);
    }
  }
  const byId = (a: ImpactItem, b: ImpactItem) => a.hops - b.hops || a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true });
  const dependents = [...reached.values()].filter((i) => !sources.includes(i.nodeId)).sort(byId);

  const degraded = new Map<string, DegradedItem>();
  const via = (dead: string) => reached.get(dead) ?? { nodeId: dead, hops: 1, path: [source, dead], uncertain: true };
  // The stand-ins of every fallen node that are still up.
  const members = new Map<string, string[]>();
  for (const [id, g] of groupOf) members.set(g, [...(members.get(g) ?? []), id]);
  for (const list of members.values()) {
    const lost = list.filter((m) => down.has(m));
    const left = list.filter((m) => !down.has(m));
    if (lost.length === 0) continue;
    for (const m of left) {
      const v = via(lost[0]);
      degraded.set(m, { nodeId: m, hops: v.hops + 1, path: [...v.path, m], uncertain: false, reason: { kind: "peer", lost, left: left.length, size: list.length } });
    }
  }
  // Callers that lost some, but not all, of the servers of a group they call.
  for (const n of forward.keys()) {
    if (down.has(n) || degraded.has(n) || !nodes.has(n)) continue;
    for (const callees of calleeGroups(n).values()) {
      const lost = callees.filter((c) => down.has(c));
      if (lost.length === 0 || lost.length === callees.length) continue;
      const v = via(lost[0]);
      degraded.set(n, {
        nodeId: n,
        hops: v.hops + 1,
        path: [...v.path, n],
        uncertain: v.uncertain,
        reason: { kind: "caller", lost: lost[0], served: callees.filter((c) => !down.has(c)) },
      });
      break;
    }
  }
  return { dependents, degraded: [...degraded.values()].sort(byId) };
}

export function analyzeImpact(
  nodes: Map<string, AnalysisNode>,
  edges: Edge[],
  failed: string | string[],
  options: ImpactOptions = {},
): Impact {
  const sources = Array.isArray(failed) ? failed : [failed];
  const source = sources[0];
  const failedSet = new Set(sources);
  const forward = arcs(edges);
  const backward = reverse(forward);

  // Who depends on it: follow the arrows backwards from the failed node (or, with
  // stand-ins, work out who really falls).
  let dependents: ImpactItem[];
  let degraded: DegradedItem[] = [];
  if (options.groups && options.groups.size > 0) {
    ({ dependents, degraded } = withGroups(nodes, forward, backward, sources, options.groups));
  } else {
    const upstream = bfs(backward, sources);
    dependents = [...upstream.values()]
      .filter((i) => !failedSet.has(i.nodeId) && nodes.has(i.nodeId))
      .sort((a, b) => a.hops - b.hops || a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true }));
  }

  // What is cut off: reachable from the entry points now, but not once the node is gone.
  const hasIncoming = new Set<string>();
  for (const list of forward.values()) for (const a of list) hasIncoming.add(a.to);
  const roots =
    options.roots ??
    [...nodes.keys()].filter((id) => !hasIncoming.has(id) && (forward.get(id)?.length ?? 0) > 0);

  let unreachable: ImpactItem[] | undefined;
  if (roots.length > 0) {
    const reachFrom = (skip?: Set<string>) => {
      const seen = new Set<string>();
      for (const r of roots) {
        if (skip?.has(r)) continue;
        for (const id of bfs(forward, r, skip).keys()) seen.add(id);
      }
      return seen;
    };
    const before = reachFrom();
    const after = reachFrom(failedSet);
    const down = bfs(forward, sources); // how the failed nodes lead to each cut-off node
    unreachable = [...before]
      .filter((id) => !failedSet.has(id) && !after.has(id) && nodes.has(id))
      .map((id) => down.get(id) ?? { nodeId: id, hops: 1, path: [source, id], uncertain: true })
      .sort((a, b) => a.hops - b.hops || a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true }));
  }
  return { source, sources, dependents, degraded, unreachable, roots };
}

/** Nodes matching a search: an IP, a host name or part of a title. Exact matches first. */
export function findNodes(topology: Pick<Topology, "nodes">, query: string): AnalysisNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { n: AnalysisNode; score: number }[] = [];
  for (const n of topology.nodes.values()) {
    let score = 0;
    if (n.ips.includes(q)) score = 100;
    else if (n.hostnames.some((h) => h === q)) score = 90;
    else if (n.ips.some((ip) => ip.startsWith(q))) score = 60;
    else if (n.hostnames.some((h) => h.includes(q))) score = 50;
    else if (n.title.toLowerCase().includes(q)) score = 40;
    if (score > 0) scored.push({ n, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.n.title.localeCompare(b.n.title)).map((x) => x.n);
}

/** The lines that carry a path of nodes (consecutive pairs), for highlighting why a node is affected. */
export function pathLines(edges: Edge[], path: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < path.length; i++) {
    const [p, q] = [path[i - 1], path[i]];
    const e = edges.find((x) => (x.a === p && x.b === q) || (x.a === q && x.b === p));
    if (e && !out.includes(e.lineId)) out.push(e.lineId);
  }
  return out;
}

export interface ImpactView {
  impact: Impact;
  /** What the lines still awaiting confirmation could add (an upper bound: every candidate taken as right). */
  extras?: { dependents: ImpactItem[]; unreachable: ImpactItem[] };
}

/** The result for one failed node, plus what unconfirmed lines might add. */
export function computeImpactView(topology: Topology, source: string | string[], groups?: Map<string, string>): ImpactView {
  const impact = analyzeImpact(topology.nodes, topology.edges, source, { groups });
  if (topology.possibleEdges.length === 0) return { impact };
  const widened = analyzeImpact(topology.nodes, [...topology.edges, ...topology.possibleEdges], source, { groups });
  const known = new Set([...impact.dependents, ...(impact.unreachable ?? [])].map((i) => i.nodeId));
  return {
    impact,
    extras: {
      dependents: widened.dependents.filter((i) => !known.has(i.nodeId)),
      unreachable: (widened.unreachable ?? []).filter((i) => !known.has(i.nodeId)),
    },
  };
}

export interface FailureRank {
  nodeId: string;
  /** Nodes that stop working when this one fails. */
  down: number;
  /** Nodes no entry point can reach any more. */
  cutOff: number;
  /** Nodes still working but without a spare. */
  degraded: number;
  /** An entry point of the diagram (nothing calls it). */
  entry: boolean;
}

/**
 * What each node's failure alone would do, worst first: the single points of failure. A node
 * is one when something else goes down or is cut off with it; stand-ins (groups) and second
 * routes make a node drop out of the list.
 */
export function rankFailures(topology: Topology, groups?: Map<string, string>): FailureRank[] {
  const out: FailureRank[] = [];
  for (const id of topology.nodes.keys()) {
    const r = analyzeImpact(topology.nodes, topology.edges, id, { groups });
    const down = r.dependents.length;
    const cutOff = r.unreachable?.length ?? 0;
    if (down + cutOff === 0) continue;
    out.push({ nodeId: id, down, cutOff, degraded: r.degraded.length, entry: r.roots.includes(id) });
  }
  const size = (r: FailureRank) => r.down + r.cutOff;
  return out.sort(
    (a, b) =>
      size(b) - size(a) ||
      b.degraded - a.degraded ||
      topology.nodes.get(a.nodeId)!.title.localeCompare(topology.nodes.get(b.nodeId)!.title),
  );
}
