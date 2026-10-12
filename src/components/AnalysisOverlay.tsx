import type { DiagramShape, Point } from "../model/types";
import { frameCorners } from "../edit/connectors";
import { ROLE_COLOUR, type Role } from "./analysisRoles";

const poly = (pts: Point[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join("") + "Z";
const open = (pts: Point[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join("");

/** An arrowhead on the last vertex, pointing along the last segment, a constant size on screen. */
export function Head({ vertices, colour, scale }: { vertices: Point[]; colour: string; scale: number }) {
  const end = vertices[vertices.length - 1];
  const prev = [...vertices].reverse().find((p) => Math.hypot(p.x - end.x, p.y - end.y) > 0.5);
  if (!end || !prev) return null;
  const angle = (Math.atan2(end.y - prev.y, end.x - prev.x) * 180) / Math.PI;
  const k = 1 / scale;
  return (
    <path
      d="M0 0L-11 -5.5L-11 5.5Z"
      fill={colour}
      transform={`translate(${end.x} ${end.y}) rotate(${angle}) scale(${k})`}
    />
  );
}

interface Props {
  page: { width: number; height: number };
  /** Frames of the nodes to mark, by role. */
  nodes: { shape: DiagramShape; role: Role }[];
  /** Lines to draw heavier (the connections that explain the result). */
  lines: { vertices: Point[]; colour: string }[];
  /** A line under review. */
  focusLine?: Point[];
  scale: number;
}

/**
 * Marks the result of an analysis on the diagram: everything else is washed out,
 * the failed node is red, what depends on it orange, what is cut off purple.
 */
export function AnalysisOverlay({ page, nodes, lines, focusLine, scale }: Props) {
  if (nodes.length === 0 && !focusLine) return null;
  const holes = nodes.map(({ shape }) => poly(frameCorners(shape))).join("");
  return (
    <g pointerEvents="none" data-analysis={nodes.length > 0 ? "result" : "focus"}>
      {nodes.length > 0 && (
        <path
          d={`M0 0H${page.width}V${page.height}H0Z${holes}`}
          fillRule="evenodd"
          fill="#fff"
          fillOpacity={0.72}
        />
      )}
      {lines.map((l, i) => (
        <g key={i}>
          <path
            d={open(l.vertices)}
            fill="none"
            stroke={l.colour}
            strokeWidth={3}
            strokeLinejoin="round"
            strokeOpacity={0.3}
            vectorEffect="non-scaling-stroke"
          />
          {/* Dashes march from the first vertex to the last: the way requests travel. */}
          <path
            className="flow"
            d={open(l.vertices)}
            fill="none"
            stroke={l.colour}
            strokeWidth={3}
            strokeLinejoin="round"
            strokeDasharray="9 9"
            vectorEffect="non-scaling-stroke"
          />
          <Head vertices={l.vertices} colour={l.colour} scale={scale} />
        </g>
      ))}
      {nodes.map(({ shape, role }) => (
        <path
          key={shape.id}
          d={poly(frameCorners(shape))}
          fill={ROLE_COLOUR[role]}
          fillOpacity={role === "possible" ? 0.08 : 0.14}
          stroke={ROLE_COLOUR[role]}
          strokeWidth={role === "source" ? 3.5 : 2.5}
          strokeDasharray={role === "possible" ? "6 4" : undefined}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {focusLine && (
        <>
          <path
            d={open(focusLine)}
            fill="none"
            stroke="#0a64d8"
            strokeWidth={6}
            strokeOpacity={0.35}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {[focusLine[0], focusLine[focusLine.length - 1]].map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={6 / scale} fill="#0a64d8" />
          ))}
        </>
      )}
    </g>
  );
}
