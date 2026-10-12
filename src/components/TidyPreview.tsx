import type { Point } from "../model/types";
import type { Tidied } from "../edit/tidy";

const path = (pts: Point[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join("");

/** The proposal drawn over the page: the old route dashed grey, the new one in green, with its arrow head. */
export function TidyOverlay({ items }: { items: Tidied[] }) {
  return (
    <g pointerEvents="none" data-tidy="preview">
      <defs>
        <marker id="tidy-arrow" viewBox="0 0 10 7.3" refX="10" refY="3.65" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="7.3" orient="auto-start-reverse">
          <path d="M0 0L10 3.65L0 7.3z" fill="context-stroke" />
        </marker>
      </defs>
      {items.map((i) => (
        <g key={i.lineId}>
          <path d={path(i.before)} fill="none" stroke="#667085" strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.9} vectorEffect="non-scaling-stroke" />
          <path d={path(i.after)} fill="none" stroke="#12b76a" strokeWidth={2.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </g>
      ))}
    </g>
  );
}

interface BarProps {
  /** Lines that would change in the chosen scope, and how many lines the page has. */
  changing: number;
  lines: number;
  /** Length (px) of lines running closer than a lane, before and after, over the whole page. */
  crowdedBefore: number;
  crowdedAfter: number;
  scope: "page" | "selection";
  canSelection: boolean;
  onScope: (s: "page" | "selection") => void;
  onApply: () => void;
  onCancel: () => void;
}

export function TidyBar(p: BarProps) {
  return (
    <div className="export-float">
      <div className="export-bar" role="group" aria-label="Tidy lines">
        <strong>Tidy lines</strong>
        <label>
          Scope{" "}
          <select value={p.scope} onChange={(e) => p.onScope(e.target.value as "page" | "selection")} aria-label="Tidy scope">
            <option value="page">Whole page</option>
            <option value="selection" disabled={!p.canSelection}>
              Selected line
            </option>
          </select>
        </label>
        <span className="muted">
          {p.changing === 0
            ? "Nothing to tidy"
            : `${p.changing} of ${p.lines} lines change${p.scope === "page" ? ` · crowded length ${p.crowdedBefore} → ${p.crowdedAfter} px` : ""}`}
        </span>
        <span className="muted legend">
          <i className="swatch old" /> now <i className="swatch new" /> after
        </span>
        <button className="primary" disabled={p.changing === 0} onClick={p.onApply}>
          Apply
        </button>
        <button onClick={p.onCancel} title="Cancel (Esc)">
          Cancel
        </button>
      </div>
    </div>
  );
}
