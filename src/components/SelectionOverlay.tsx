import type { DiagramShape } from "../model/types";
import { CURSORS, HANDLES, handlePoint } from "../edit/interaction";
import { shapeTransform } from "../render/shapeTransform";

interface Props {
  shape: DiagramShape;
  scale: number;
  resizable: boolean;
  rotatable: boolean;
}

const ACCENT = "#0a64d8";
const ROTATE_OFFSET = 24; // screen px above the top edge

/** Selection box with resize handles and a rotation handle; handle size stays constant on screen. */
export function SelectionOverlay({ shape, scale, resizable, rotatable }: Props) {
  const { width: w, height: h } = shape;
  const hs = 8 / scale;
  const ry = -ROTATE_OFFSET / scale;
  return (
    <g transform={shapeTransform(shape)}>
      <rect
        width={w}
        height={h}
        fill="none"
        stroke={ACCENT}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      {rotatable && (
        <>
          <line
            x1={w / 2}
            y1={0}
            x2={w / 2}
            y2={ry}
            stroke={ACCENT}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          <circle
            data-handle="rot"
            cx={w / 2}
            cy={ry}
            r={5 / scale}
            fill="#fff"
            stroke={ACCENT}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: "grab" }}
          />
        </>
      )}
      {resizable &&
        HANDLES.map((handle) => {
          const [x, y] = handlePoint(handle, w, h);
          return (
            <rect
              key={handle}
              data-handle={handle}
              x={x - hs / 2}
              y={y - hs / 2}
              width={hs}
              height={hs}
              fill="#fff"
              stroke={ACCENT}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              style={{ cursor: CURSORS[handle] }}
            />
          );
        })}
    </g>
  );
}
