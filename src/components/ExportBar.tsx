import { useState } from "react";
import type { Bounds } from "../render/bounds";
import { fitScale } from "../render/exportRegion";

const SCALES = [1, 2, 3, 4];

interface BarProps {
  region: Bounds | null;
  busy: boolean;
  onWholePage: () => void;
  onExport: (scale: number) => void;
  onClose: () => void;
}

/** Floats over the canvas while the export-area tool is active. */
export function ExportBar({ region, busy, onWholePage, onExport, onClose }: BarProps) {
  const [scale, setScale] = useState(2);
  const size = region && region.width > 0 && region.height > 0 ? region : null;
  const used = size ? fitScale(size, scale) : scale;
  return (
    <div className="export-float">
      <div className="export-bar" role="group" aria-label="Export PNG">
        {size ? (
          <span className="muted">
            {Math.round(size.width * used)} × {Math.round(size.height * used)} px
            {used < scale ? " (reduced: too large)" : ""}
          </span>
        ) : (
          <span className="muted">Drag a box over the part to export</span>
        )}
        <label>
          Scale{" "}
          <select value={scale} onChange={(e) => setScale(Number(e.target.value))} aria-label="Export scale">
            {SCALES.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <button onClick={onWholePage}>Whole page</button>
        <button className="primary" disabled={!size || busy} onClick={() => onExport(scale)}>
          {busy ? "Exporting…" : "Export PNG"}
        </button>
        <button onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </div>
    </div>
  );
}

/** The chosen area on the page: everything outside it is dimmed. */
export function RegionOverlay({ region, page }: { region: Bounds; page: Bounds }) {
  const pad = 4000;
  const { x, y, width, height } = region;
  return (
    <g pointerEvents="none">
      <path
        d={`M${page.x - pad} ${page.y - pad}H${page.x + page.width + pad}V${page.y + page.height + pad}H${page.x - pad}ZM${x} ${y}V${y + height}H${x + width}V${y}Z`}
        fillRule="evenodd"
        fill="#000"
        fillOpacity={0.25}
      />
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill="none"
        stroke="#0a64d8"
        strokeWidth={2}
        strokeDasharray="6 4"
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}
