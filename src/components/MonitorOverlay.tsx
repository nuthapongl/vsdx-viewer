import type { DiagramShape, Point } from "../model/types";
import type { NodeState } from "../analysis/simulate";
import { frameCorners } from "../edit/connectors";
import { Head } from "./AnalysisOverlay";
import { STATE_COLOUR } from "./monitorStates";

const poly = (pts: Point[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join("") + "Z";
const open = (pts: Point[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join("");

interface Props {
  nodes: { shape: DiagramShape; state: NodeState }[];
  /** Lines carrying traffic, drawn from caller to callee. */
  flows: Point[][];
  /** Lines that carried traffic and carry none now. */
  stopped: Point[][];
  scale: number;
}

/**
 * The simulated network over the diagram: a status light on every node, green dashes running
 * along the lines that carry traffic, and the lines and nodes that went quiet greyed or red.
 */
export function MonitorOverlay({ nodes, flows, stopped, scale }: Props) {
  const r = 5 / scale;
  return (
    <g pointerEvents="none" data-analysis="result">
      {stopped.map((v, i) => (
        <path key={`s${i}`} d={open(v)} fill="none" stroke="#98a2b3" strokeWidth={3} strokeDasharray="2 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
      {flows.map((v, i) => (
        <g key={`f${i}`}>
          <path d={open(v)} fill="none" stroke="#12b76a" strokeWidth={3} strokeOpacity={0.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path className="flow" d={open(v)} fill="none" stroke="#12b76a" strokeWidth={3} strokeLinejoin="round" strokeDasharray="9 9" vectorEffect="non-scaling-stroke" />
          <Head vertices={v} colour="#12b76a" scale={scale} />
        </g>
      ))}
      {nodes.map(({ shape, state }) => {
        const c = frameCorners(shape);
        const xs = c.map((p) => p.x);
        const ys = c.map((p) => p.y);
        const corner = { x: Math.max(...xs), y: Math.min(...ys) };
        return (
          <g key={shape.id}>
            {state !== "up" && (
              <path
                d={poly(c)}
                fill={state === "cutoff" ? "#fff" : STATE_COLOUR[state]}
                fillOpacity={state === "cutoff" ? 0.65 : 0.12}
                stroke={STATE_COLOUR[state]}
                strokeWidth={state === "off" ? 3.5 : 2.5}
                strokeDasharray={state === "down" ? "7 4" : undefined}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {/* the status light */}
            <circle cx={corner.x} cy={corner.y} r={r} fill={STATE_COLOUR[state]} stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            {state === "off" && (
              <path
                d={`M${corner.x - r * 0.5} ${corner.y - r * 0.5}L${corner.x + r * 0.5} ${corner.y + r * 0.5}M${corner.x + r * 0.5} ${corner.y - r * 0.5}L${corner.x - r * 0.5} ${corner.y + r * 0.5}`}
                stroke="#fff"
                strokeWidth={1.6}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        );
      })}
    </g>
  );
}
