/**
 * A simulated run of the network, for the monitor view: requests enter at the entry points
 * (nodes nothing calls) and travel along the arrows. Switching nodes off shows where the
 * traffic still flows, which nodes fall with them, which lose a stand-in and which can no
 * longer be reached. Lines still awaiting confirmation are not part of it.
 */
import type { Edge, Topology } from "./graph";
import { analyzeImpact } from "./impact";

export type NodeState = "up" | "off" | "down" | "cutoff" | "degraded";

export interface Flow {
  lineId: string;
  /** Caller and callee: traffic runs from `from` to `to`. */
  from: string;
  to: string;
}

export interface Simulation {
  state: Map<string, NodeState>;
  /** Lines that carry traffic now. */
  flows: Flow[];
  /** Lines that carried traffic with everything up and carry none now. */
  stopped: Flow[];
  /** Where the traffic comes from. */
  entries: string[];
}

/** Directed hops: a `forward` edge goes a -> b, an edge with arrows at both ends or none goes both ways. */
function hops(edges: Edge[]): Map<string, Flow[]> {
  const out = new Map<string, Flow[]>();
  const add = (f: Flow) => out.set(f.from, [...(out.get(f.from) ?? []), f]);
  for (const e of edges) {
    add({ lineId: e.lineId, from: e.a, to: e.b });
    if (e.kind !== "forward") add({ lineId: e.lineId, from: e.b, to: e.a });
  }
  return out;
}

/** The lines traffic passes along, from the entry points, through the nodes that work. */
function trafficFrom(entries: string[], out: Map<string, Flow[]>, works: (id: string) => boolean): Flow[] {
  const seen = new Set(entries.filter(works));
  const queue = [...seen];
  const flows = new Map<string, Flow>(); // one direction per line: the one the traffic reaches first
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const f of out.get(cur) ?? []) {
      if (!works(f.to)) continue;
      if (!flows.has(f.lineId)) flows.set(f.lineId, f);
      if (!seen.has(f.to)) {
        seen.add(f.to);
        queue.push(f.to);
      }
    }
  }
  return [...flows.values()];
}

export function simulate(topology: Pick<Topology, "nodes" | "edges">, off: string[], groups?: Map<string, string>): Simulation {
  const { nodes, edges } = topology;
  const state = new Map<string, NodeState>([...nodes.keys()].map((id) => [id, "up"]));
  const switchedOff = off.filter((id) => nodes.has(id));
  if (switchedOff.length > 0) {
    const impact = analyzeImpact(nodes, edges, switchedOff, { groups });
    for (const i of impact.dependents) state.set(i.nodeId, "down");
    for (const i of impact.unreachable ?? []) if (state.get(i.nodeId) === "up") state.set(i.nodeId, "cutoff");
    for (const i of impact.degraded) if (state.get(i.nodeId) === "up") state.set(i.nodeId, "degraded");
    for (const id of switchedOff) state.set(id, "off");
  }

  const out = hops(edges);
  const hasIncoming = new Set([...out.values()].flat().map((f) => f.to));
  const entries = [...nodes.keys()].filter((id) => !hasIncoming.has(id) && (out.get(id)?.length ?? 0) > 0);

  const works = (id: string) => {
    const s = state.get(id);
    return s === "up" || s === "degraded";
  };
  const all = trafficFrom(entries, out, (id) => nodes.has(id));
  const flows = trafficFrom(entries, out, works);
  const now = new Set(flows.map((f) => f.lineId));
  return { state, flows, stopped: all.filter((f) => !now.has(f.lineId)), entries };
}
