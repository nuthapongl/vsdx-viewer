import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EditSession } from "./edit/session";
import { FileDropzone } from "./components/FileDropzone";
import { PageSelector } from "./components/PageSelector";
import { VisioViewer } from "./components/VisioViewer";
import type { Mode } from "./components/EditToolbar";

const noSubscribe = () => () => undefined;
const zero = () => 0;

export default function App() {
  const [session, setSession] = useState<EditSession | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  /** Every file opens in viewer mode; editing is something you switch on. */
  const [mode, setMode] = useState<Mode>("viewer");
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  // Re-render on every edit; the document itself lives in the session.
  useSyncExternalStore(session ? session.subscribe : noSubscribe, session ? session.getVersion : zero);
  const doc = session?.document ?? null;

  // Release the previous file's image URLs when it is replaced or the app unmounts.
  useEffect(() => () => session?.dispose(), [session]);

  // Closing the tab with unsaved edits would lose them.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (session?.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [session]);

  // Everything stays in the browser: the file is read with the File API and never uploaded.
  const open = async (source: () => Promise<File | Blob>, name: string) => {
    if (session?.dirty && !window.confirm("This file has unsaved changes. Open another file and discard them?")) {
      return;
    }
    const mine = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const s = await EditSession.open(await source(), name);
      if (mine !== request.current) {
        s.dispose(); // a newer file was chosen meanwhile
        return;
      }
      setSession(s);
      setOpenCount((n) => n + 1);
      setPageIndex(0);
      setMode("viewer");
    } catch (e) {
      if (mine !== request.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === request.current) setBusy(false);
    }
  };

  const loadSample = () =>
    open(async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}sample.vsdx`);
      if (!res.ok) throw new Error("Sample file not found (run `npm run sample`).");
      return res.blob();
    }, "sample.vsdx");

  const page = doc?.pages[pageIndex];
  const shapeCount = page?.shapes.length ?? 0;

  const onWindowDrop = (e: React.DragEvent) => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    void open(async () => file, file.name);
  };

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onWindowDrop}>
      <header>
        <h1>VSDX Editor</h1>
        <FileDropzone onFile={(f) => open(async () => f, f.name)} busy={busy} />
        {doc && session && (
          <div className="info">
            <strong title={session.fileName}>{session.fileName}</strong>
            {page && (
              <span className="muted">
                {shapeCount} {shapeCount === 1 ? "shape" : "shapes"}
              </span>
            )}
            {doc.warnings && doc.warnings.length > 0 && (
              <details className="warnings">
                <summary>{doc.warnings.length} warning(s)</summary>
                <ul>
                  {doc.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        <button className="link" onClick={loadSample} disabled={busy}>
          Load sample
        </button>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {page && session && doc ? (
        <VisioViewer
          key={`${openCount}:${page.id}`}
          session={session}
          page={page}
          mode={mode}
          onMode={setMode}
          pageTabs={<PageSelector pages={doc.pages} index={pageIndex} onSelect={setPageIndex} />}
        />
      ) : (
        <div className="viewer empty">
          {doc ? "This file has no pages." : "Drop a .vsdx file anywhere, or use Open"}
        </div>
      )}
    </div>
  );
}
