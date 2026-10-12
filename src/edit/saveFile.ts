import type { EditSession } from "./session";

const MIME = "application/vnd.ms-visio.drawing";

interface FilePickerWindow {
  showSaveFilePicker?: (opts: unknown) => Promise<{
    name: string;
    createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
  }>;
}

/**
 * Write the edited file to disk. Where the browser allows it (Chrome, Edge) the
 * user picks the destination and can overwrite the original; otherwise the file
 * is downloaded. Returns the file name, or null if the user cancelled.
 */
export async function saveToDisk(session: EditSession): Promise<string | null> {
  const bytes = await session.exportBytes();
  const blob = new Blob([bytes as BlobPart], { type: MIME });

  const picker = (window as FilePickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker.call(window, {
        suggestedName: session.fileName,
        types: [{ description: "Visio drawing", accept: { [MIME]: [".vsdx"] } }],
      });
      const out = await handle.createWritable();
      await out.write(blob);
      await out.close();
      session.markSaved();
      return handle.name;
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
      // Picker unavailable here (e.g. embedded frame): fall back to a download.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = session.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  session.markSaved();
  return session.fileName;
}
