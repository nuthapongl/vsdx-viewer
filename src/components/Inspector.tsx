import { useState } from "react";
import type { DiagramShape } from "../model/types";
import type { StylePatch } from "../edit/xmlEdit";

export interface ConnectorPatch {
  style?: "straight" | "elbow";
  beginArrow?: boolean;
  endArrow?: boolean;
}

interface Props {
  shape: DiagramShape;
  onStyle: (patch: StylePatch, coalesceKey: string) => void;
  onConnector?: (patch: ConnectorPatch) => void;
}

function ColorField({
  label,
  value,
  fallback,
  onChange,
  onNone,
}: {
  label: string;
  value: string | undefined;
  fallback: string;
  onChange: (c: string) => void;
  onNone: () => void;
}) {
  // The picker fires continuously while it is dragged, but the shape only catches up
  // asynchronously. Show what the user picked at once; follow the shape when it changes
  // from elsewhere (undo/redo, another selection).
  const [shown, setShown] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setShown(value);
  }
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="color"
        value={shown ?? fallback}
        disabled={shown === undefined}
        onChange={(e) => {
          setShown(e.target.value);
          onChange(e.target.value);
        }}
        aria-label={`${label} colour`}
      />
      <input
        type="checkbox"
        checked={shown === undefined}
        onChange={(e) => {
          const none = e.target.checked;
          setShown(none ? undefined : fallback);
          if (none) onNone();
          else onChange(fallback);
        }}
        aria-label={`No ${label.toLowerCase()}`}
      />
      <span className="muted">none</span>
    </label>
  );
}

export function Inspector({ shape, onStyle, onConnector }: Props) {
  const isGroup = shape.type === "group";
  const isLine = shape.type === "line" || shape.type === "connector";
  const key = (f: string) => `${f}:${shape.id}`;
  return (
    <div className="inspector">
      <span className="what">
        <strong>{shape.name ?? `Shape ${shape.id}`}</strong>
        <span className="muted"> · {shape.type}</span>
        {isGroup && <span className="muted"> · style applies to everything inside</span>}
      </span>
      {!isLine && (
        <ColorField
          label="Fill"
          value={shape.style.fill}
          fallback="#ffffff"
          onChange={(c) => onStyle({ fill: c }, key("fill"))}
          onNone={() => onStyle({ fill: null }, key("fill"))}
        />
      )}
      <ColorField
        label="Line"
        value={shape.style.stroke}
        fallback="#000000"
        onChange={(c) => onStyle({ stroke: c }, key("stroke"))}
        onNone={() => onStyle({ stroke: null }, key("stroke"))}
      />
      <label className="field">
        <span>Weight</span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={Math.round(shape.style.strokeWidth * 100) / 100}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onStyle({ lineWidth: v }, key("weight"));
          }}
          aria-label="Line weight in px"
        />
        <span className="muted">px</span>
      </label>
      {shape.connector && onConnector && (
        <>
          <label className="field">
            <span>Path</span>
            <select
              value={shape.connector.route?.style ?? "straight"}
              onChange={(e) => onConnector({ style: e.target.value as "straight" | "elbow" })}
              aria-label="Connector path"
            >
              <option value="elbow">Elbow</option>
              <option value="straight">Straight</option>
            </select>
          </label>
          <label className="field">
            <input
              type="checkbox"
              checked={!!shape.style.beginArrow}
              onChange={(e) => onConnector({ beginArrow: e.target.checked })}
              aria-label="Arrow at the start"
            />
            <span>Start arrow</span>
          </label>
          <label className="field">
            <input
              type="checkbox"
              checked={!!shape.style.endArrow}
              onChange={(e) => onConnector({ endArrow: e.target.checked })}
              aria-label="Arrow at the end"
            />
            <span>End arrow</span>
          </label>
        </>
      )}
      {!isGroup && <span className="muted hint">Double-click to edit text</span>}
    </div>
  );
}
