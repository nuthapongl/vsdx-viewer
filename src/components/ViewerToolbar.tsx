import type { ReactNode } from "react";

interface Props {
  /** Page tabs, shown at the left of the bar. */
  left?: ReactNode;
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onReset: () => void;
}

export function ViewerToolbar({ left, scale, onZoomIn, onZoomOut, onFit, onReset }: Props) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">{left}</div>
      <div className="toolbar-zoom">
      <button onClick={onZoomOut} aria-label="Zoom out" title="Zoom out">
        −
      </button>
      <span className="zoom" aria-live="polite">
        {Math.round(scale * 100)}%
      </span>
      <button onClick={onZoomIn} aria-label="Zoom in" title="Zoom in">
        +
      </button>
      <button onClick={onFit} title="Fit the whole page in the view">
        Fit
      </button>
      <button onClick={onReset} title="100%, centred">
        Reset
      </button>
      </div>
      <div className="toolbar-right" />
    </div>
  );
}
