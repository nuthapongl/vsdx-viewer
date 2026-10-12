export type Mode = "viewer" | "editor";
export type Tool = "select" | "rectangle" | "ellipse" | "text" | "connector" | "area";

interface Props {
  mode: Mode;
  onMode: (m: Mode) => void;
  tool: Tool;
  onTool: (t: Tool) => void;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  dirty: boolean;
  saving: boolean;
  status: { ok: boolean; text: string } | null;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onFront: () => void;
  onBack: () => void;
  onSave: () => void;
  /** Export the selected shape as a PNG (opens the export bar around it). */
  onExportSelection: () => void;
  tidying: boolean;
  onTidy: () => void;
  analyzing: boolean;
  onAnalyze: () => void;
  monitoring: boolean;
  onMonitor: () => void;
}

const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: "select", label: "Select", title: "Select, move, resize, rotate" },
  { id: "rectangle", label: "▭", title: "Add a rectangle: click on the page" },
  { id: "ellipse", label: "◯", title: "Add an ellipse: click on the page" },
  { id: "text", label: "T", title: "Add a text box: click on the page" },
  { id: "connector", label: "⤳", title: "Connector: drag from a shape (or one of its dots) to another shape" },
  { id: "area", label: "⬚ Export area", title: "Drag a box over the part of the page to export as a PNG" },
];

export function EditToolbar(p: Props) {
  const editor = p.mode === "editor";
  return (
    <div className="edit-toolbar" role="toolbar" aria-label="Edit">
      <div className="group mode-switch" role="group" aria-label="Mode">
        <button
          className={!editor ? "active" : undefined}
          aria-pressed={!editor}
          onClick={() => p.onMode("viewer")}
          title="Viewer: look, pan, zoom, analyse and export - nothing can be changed by accident"
        >
          Viewer
        </button>
        <button
          className={editor ? "active editor" : undefined}
          aria-pressed={editor}
          onClick={() => p.onMode("editor")}
          title="Editor: move, resize, restyle, draw and delete shapes"
        >
          Editor
        </button>
      </div>
      {editor && (
        <>
          <div className="group">
            {TOOLS.filter((t) => t.id !== "area").map((t) => (
              <button
                key={t.id}
                className={p.tool === t.id ? "active" : undefined}
                aria-pressed={p.tool === t.id}
                title={t.title}
                onClick={() => p.onTool(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="group">
            <button onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl/Cmd+Z)">
              Undo
            </button>
            <button onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Shift+Ctrl/Cmd+Z)">
              Redo
            </button>
          </div>
          <div className="group">
            <button onClick={p.onFront} disabled={!p.hasSelection} title="Bring to front">
              Front
            </button>
            <button onClick={p.onBack} disabled={!p.hasSelection} title="Send to back">
              Back
            </button>
            <button onClick={p.onDelete} disabled={!p.hasSelection} title="Delete (Del)">
              Delete
            </button>
          </div>
          <div className="group">
            <button
              className={p.tidying ? "active" : undefined}
              aria-pressed={p.tidying}
              onClick={p.onTidy}
              title="Space parallel lines evenly and clean up their corners - with a preview before anything changes"
            >
              Tidy lines
            </button>
          </div>
        </>
      )}
      <div className="group">
        {TOOLS.filter((t) => t.id === "area").map((t) => (
          <button
            key={t.id}
            className={p.tool === t.id ? "active" : undefined}
            aria-pressed={p.tool === t.id}
            title={t.title}
            onClick={() => p.onTool(p.tool === t.id ? "select" : t.id)}
          >
            {t.label}
          </button>
        ))}
        <button onClick={p.onExportSelection} disabled={!p.hasSelection} title="Export the selected shape as a PNG">
          PNG
        </button>
        <button
          className={p.analyzing ? "active" : undefined}
          aria-pressed={p.analyzing}
          onClick={p.onAnalyze}
          title="Analyse how the nodes are connected and what an IP going down would affect"
        >
          Analyze
        </button>
        <button
          className={p.monitoring ? "active" : undefined}
          aria-pressed={p.monitoring}
          onClick={p.onMonitor}
          title="Simulated traffic over the diagram: switch nodes off and on to see where it still flows"
        >
          Monitor
        </button>
      </div>
      <div className="group right">
        {p.status && (
          <span className={p.status.ok ? "status ok" : "status error"} role="status">
            {p.status.text}
          </span>
        )}
        {p.dirty && <span className="unsaved">● Unsaved changes</span>}
        <button
          className="primary"
          onClick={p.onSave}
          disabled={p.saving || !p.dirty}
          title="Save as .vsdx (Ctrl/Cmd+S)"
        >
          {p.saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
