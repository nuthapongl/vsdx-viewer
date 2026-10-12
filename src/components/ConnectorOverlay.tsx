import type { DiagramShape, Point, Side } from "../model/types";
import { draggablePieces } from "../edit/lineEdit";
import { portsOf } from "../edit/routing";

const ACCENT = "#0a64d8";
const GREEN = "#12a150";

/** Port markers on a shape: the places a connector can attach. Sizes stay constant on screen. */
export function PortsOverlay({
  shape,
  scale,
  active,
}: {
  shape: DiagramShape;
  scale: number;
  /** Side that the pointer would snap to. */
  active?: Side;
}) {
  return (
    <g>
      {portsOf(shape).map((p) => {
        const on = p.side === active;
        return (
          <g key={p.side} data-port={`${shape.id}:${p.side}`} style={{ cursor: "crosshair" }}>
            {/* a larger invisible target so ports are easy to hit */}
            <circle cx={p.point.x} cy={p.point.y} r={11 / scale} fill="transparent" />
            <circle
              cx={p.point.x}
              cy={p.point.y}
              r={(on ? 6 : 4.5) / scale}
              fill={on ? GREEN : "#fff"}
              stroke={on ? GREEN : ACCENT}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          </g>
        );
      })}
    </g>
  );
}

const toPath = (pts: Point[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join("");

/** The path a connector would take while one is being drawn or an end is being dragged. */
export function RoutePreview({ points, scale, dot = true }: { points: Point[]; scale: number; dot?: boolean }) {
  if (points.length < 2) return null;
  return (
    <g pointerEvents="none">
      <path
        d={toPath(points)}
        fill="none"
        stroke={ACCENT}
        strokeWidth={2}
        strokeDasharray="6 4"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {dot && <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={4 / scale} fill={ACCENT} />}
    </g>
  );
}

/** Handles for the two ends of the selected connector: drag one to attach it elsewhere. */
export function EndpointHandles({
  begin,
  end,
  scale,
  hidden,
}: {
  begin: Point;
  end: Point;
  scale: number;
  /** The end that is being dragged is drawn by the preview instead. */
  hidden?: "begin" | "end";
}) {
  const handle = (which: "begin" | "end", p: Point) =>
    hidden === which ? null : (
      <g key={which} data-endpoint={which} style={{ cursor: "grab" }}>
        <circle cx={p.x} cy={p.y} r={12 / scale} fill="transparent" />
        <circle
          cx={p.x}
          cy={p.y}
          r={5.5 / scale}
          fill="#fff"
          stroke={ACCENT}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      </g>
    );
  return (
    <g>
      {handle("begin", begin)}
      {handle("end", end)}
    </g>
  );
}

/** A highlight along the selected connector's own path. */
export function PathHighlight({ points }: { points: Point[] }) {
  if (points.length < 2) return null;
  return (
    <path
      d={toPath(points)}
      fill="none"
      stroke={ACCENT}
      strokeOpacity={0.35}
      strokeWidth={6}
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      pointerEvents="none"
    />
  );
}

/** Where the magnet would put the end being dragged: a ring on the spot, and the shape's outline lit. */
export function SnapMarker({ point, outline, kind, scale }: { point: Point; outline?: Point[]; kind: "port" | "edge"; scale: number }) {
  return (
    <g pointerEvents="none">
      {outline && outline.length > 2 && (
        <path
          d={toPath(outline) + "Z"}
          fill={GREEN}
          fillOpacity={0.08}
          stroke={GREEN}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      )}
      <circle cx={point.x} cy={point.y} r={(kind === "port" ? 8 : 6.5) / scale} fill="none" stroke={GREEN} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
      <circle cx={point.x} cy={point.y} r={2.5 / scale} fill={GREEN} />
    </g>
  );
}

/** The bends of a selected line, as small squares (not draggable). */
export function BendMarks({ points, scale }: { points: Point[]; scale: number }) {
  return (
    <g pointerEvents="none">
      {points.slice(1, -1).map((p, i) => (
        <rect key={i} x={p.x - 2.5 / scale} y={p.y - 2.5 / scale} width={5 / scale} height={5 / scale} fill="#fff" stroke={ACCENT} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
      ))}
    </g>
  );
}

/**
 * Handles on the body of a selected line: a square on each bend (drag to move it) and a bar in the
 * middle of each piece between bends (drag to slide it; on a straight line, to add a bend).
 */
export function LineHandles({ points, scale }: { points: Point[]; scale: number }) {
  const s = 8 / scale;
  return (
    <g>
      {draggablePieces(points).map((p) => {
        const long = 16 / scale;
        const short = 6 / scale;
        const [w, h] = p.kind === "horizontal" ? [long, short] : p.kind === "vertical" ? [short, long] : [short * 1.6, short * 1.6];
        const cursor = p.split ? "copy" : p.kind === "horizontal" ? "ns-resize" : p.kind === "vertical" ? "ew-resize" : "move";
        return (
          <g key={`p${p.index}`} data-piece={p.index} data-split={p.split ? "1" : undefined} style={{ cursor }}>
            <rect x={p.mid.x - 12 / scale} y={p.mid.y - 12 / scale} width={24 / scale} height={24 / scale} fill="transparent" />
            <rect
              x={p.mid.x - w / 2}
              y={p.mid.y - h / 2}
              width={w}
              height={h}
              rx={h / 2}
              fill={ACCENT}
              fillOpacity={0.85}
              stroke="#fff"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
              transform={p.kind === "slanted" ? `rotate(45 ${p.mid.x} ${p.mid.y})` : undefined}
            />
          </g>
        );
      })}
      {points.slice(1, -1).map((p, i) => (
        <g key={`b${i + 1}`} data-bend={i + 1} style={{ cursor: "move" }}>
          <circle cx={p.x} cy={p.y} r={10 / scale} fill="transparent" />
          <rect
            x={p.x - s / 2}
            y={p.y - s / 2}
            width={s}
            height={s}
            fill="#fff"
            stroke={ACCENT}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        </g>
      ))}
    </g>
  );
}
