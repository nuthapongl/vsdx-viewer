import type { DiagramDocument } from "../model/types";
import { VsdxPackage } from "./package";
import { parseDocument } from "./parseDocument";

/**
 * Entry point of the parser: .vsdx bytes in, internal diagram model out.
 * Everything happens in the browser; nothing is sent anywhere.
 *
 *   VSDX file -> ZIP reader (VsdxPackage) -> parser -> DiagramDocument
 */
export async function loadVsdx(
  input: File | Blob | ArrayBuffer | Uint8Array,
  name?: string,
): Promise<DiagramDocument> {
  const fileName = name ?? (input instanceof File ? input.name : "diagram.vsdx");
  const pkg = await VsdxPackage.open(input);
  try {
    const doc = await parseDocument(pkg, fileName.replace(/\.vsdx$/i, ""));
    doc.dispose = () => pkg.dispose();
    return doc;
  } catch (e) {
    pkg.dispose();
    throw e;
  }
}
