import type { Topology } from "../analysis/graph";
import type { NodeState, Simulation } from "../analysis/simulate";
import type { AnalysisNode } from "../analysis/nodes";
import { STATE_COLOUR, STATE_LABEL } from "./monitorStates";

interface Props {
  topology: Topology;
  sim: Simulation;
  off: string[];
  onOff: (ids: string[]) => void;
  onFocusNode: (id: string) => void;
  onClose: () => void;
}

const name = (n: AnalysisNode | undefined, id: string) => {
  const title = n ? n.title || n.hostnames[0] || `#${id}` : `#${id}`;
  const ip = n?.ips[0];
  return ip && !title.includes(ip) ? `${title} (${ip})` : title;
};

const ORDER: NodeState[] = ["off", "down", "cutoff", "degraded"];

/** The side panel of the monitor: what is running, what was switched off, what it caused. */
export function MonitorPanel({ topology, sim, off, onOff, onFocusNode, onClose }: Props) {
  const count = (s: NodeState) => [...sim.state.values()].filter((x) => x === s).length;
  const pending = topology.lines.filter((l) => !l.resolved).length;
  const byState = (s: NodeState) =>
    [...sim.state.entries()].filter(([, x]) => x === s).map(([id]) => id).sort((a, b) => name(topology.nodes.get(a), a).localeCompare(name(topology.nodes.get(b), b)));
  return (
    <aside className="analysis monitor" aria-label="Network monitor">
      <header>
        <strong>Network monitor</strong>
        <button onClick={onClose} aria-label="Close monitor">×</button>
      </header>
      <section>
        <p className="muted">
          Simulated traffic enters at {sim.entries.map((id) => name(topology.nodes.get(id), id)).join(", ") || "no entry point"} and follows the arrows.
          <strong> Click a node</strong> to switch it off or back on.
        </p>
        <ul className="status-counts">
          {(["up", "degraded", "off", "down", "cutoff"] as NodeState[]).map((s) => (
            <li key={s}>
              <i className="led" style={{ background: STATE_COLOUR[s] }} />
              {STATE_LABEL[s]} <strong>{count(s)}</strong>
            </li>
          ))}
        </ul>
        <p className="muted">
          {sim.flows.length} {sim.flows.length === 1 ? "line carries" : "lines carry"} traffic
          {sim.stopped.length > 0 && <>, {sim.stopped.length} stopped</>}.
        </p>
        {off.length > 0 && (
          <button onClick={() => onOff([])} title="Switch every node back on">
            Switch all back on
          </button>
        )}
      </section>
      {ORDER.map((s) => {
        const ids = byState(s);
        if (ids.length === 0) return null;
        return (
          <section key={s}>
            <h3 style={{ color: STATE_COLOUR[s] }}>
              {STATE_LABEL[s]} ({ids.length})
            </h3>
            <ul className="monitor-list">
              {ids.map((id) => (
                <li key={id}>
                  <button className="link" onClick={() => onFocusNode(id)}>
                    {name(topology.nodes.get(id), id)}
                  </button>
                  {s === "off" && (
                    <button onClick={() => onOff(off.filter((x) => x !== id))} title="Switch back on">
                      Turn on
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {pending > 0 && (
        <section>
          <p className="muted">
            {pending} {pending === 1 ? "line is" : "lines are"} still to be confirmed in Analyze and {pending === 1 ? "is" : "are"} not
            simulated. High-availability groups made in Analyze are used: a node with a stand-in still up is only degraded.
          </p>
        </section>
      )}
    </aside>
  );
}
