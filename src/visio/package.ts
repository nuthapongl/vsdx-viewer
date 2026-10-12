import JSZip from "jszip";
import { decodeBmp, toPngBlob } from "./bmp";
import { attr, children, parseXml } from "./xml";

export interface Relationship {
  id: string;
  type: string;
  /** Absolute part name inside the package (no leading slash). */
  target: string;
  external: boolean;
}

/** Resolve a relationship target against the part that owns the .rels file. */
export function resolvePartPath(ownerPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = ownerPath.split("/");
  parts.pop(); // file name
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

function relsPathFor(ownerPath: string): string {
  const i = ownerPath.lastIndexOf("/");
  const dir = i >= 0 ? ownerPath.slice(0, i + 1) : "";
  const file = i >= 0 ? ownerPath.slice(i + 1) : ownerPath;
  return `${dir}_rels/${file}.rels`;
}

/** Thin wrapper over the OPC (ZIP) container that a .vsdx file is. */
export class VsdxPackage {
  private zip: JSZip;
  private xmlCache = new Map<string, Document>();
  private mediaCache = new Map<string, Promise<string>>();
  private objectUrls: string[] = [];
  private dirtyXml = new Set<string>();

  private constructor(zip: JSZip) {
    this.zip = zip;
  }

  static async open(data: ArrayBuffer | Uint8Array | Blob): Promise<VsdxPackage> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(data);
    } catch {
      throw new Error("This file is not a valid ZIP package, so it can't be a .vsdx file.");
    }
    return new VsdxPackage(zip);
  }

  has(path: string): boolean {
    return this.zip.file(path) !== null;
  }

  list(): string[] {
    return Object.keys(this.zip.files).filter((n) => !this.zip.files[n].dir);
  }

  async readText(path: string): Promise<string> {
    const f = this.zip.file(path);
    if (!f) throw new Error(`Missing part in package: ${path}`);
    return f.async("string");
  }

  async readXml(path: string): Promise<Document> {
    const cached = this.xmlCache.get(path);
    if (cached) return cached;
    const doc = parseXml(await this.readText(path), path);
    this.xmlCache.set(path, doc);
    return doc;
  }

  /** Record that the cached DOM of `path` was modified and must be written on save. */
  markXmlDirty(path: string) {
    this.dirtyXml.add(path);
  }

  /**
   * The package as a .vsdx: modified XML parts are re-serialised from their
   * edited DOM, every other part is carried over untouched.
   */
  async toBytes(): Promise<Uint8Array> {
    for (const path of this.dirtyXml) {
      const doc = this.xmlCache.get(path);
      if (!doc) continue;
      const xml = new XMLSerializer().serializeToString(doc);
      // createFolders: false, or JSZip adds directory entries the original package doesn't have.
      this.zip.file(
        path,
        `<?xml version="1.0" encoding="utf-8"?>\n${xml.replace(/^<\?xml[^>]*\?>\s*/, "")}`,
        { createFolders: false },
      );
    }
    return this.zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }

  /**
   * URL for an embedded media part, created once per part however many shapes
   * use it. A Blob URL where available (a single 16 MB bitmap used by 40 shapes
   * must not become 40 data: URLs), otherwise a data: URL.
   */
  mediaUrl(path: string, mime: string): Promise<string> {
    let url = this.mediaCache.get(path);
    if (!url) {
      url = this.createMediaUrl(path, mime);
      this.mediaCache.set(path, url);
    }
    return url;
  }

  private async createMediaUrl(path: string, mime: string): Promise<string> {
    const f = this.zip.file(path);
    if (!f) throw new Error(`Missing part in package: ${path}`);
    const bytes = await f.async("uint8array");

    // Browsers ignore the alpha channel of BMPs: decode them and hand over a PNG instead.
    if (mime === "image/bmp") {
      const decoded = decodeBmp(bytes);
      const png = decoded ? await toPngBlob(decoded).catch(() => null) : null;
      if (png) return this.blobUrl(png);
    }
    if (typeof URL.createObjectURL === "function") {
      return this.blobUrl(new Blob([bytes as BlobPart], { type: mime }));
    }
    return `data:${mime};base64,${await f.async("base64")}`;
  }

  private blobUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.objectUrls.push(url);
    return url;
  }

  /** Release Blob URLs handed out by `mediaUrl`. */
  dispose() {
    for (const u of this.objectUrls) URL.revokeObjectURL(u);
    this.objectUrls = [];
    this.mediaCache.clear();
  }

  /** Relationships declared for a part (empty if it has none). */
  async relationships(ownerPath: string): Promise<Map<string, Relationship>> {
    const out = new Map<string, Relationship>();
    const relsPath = ownerPath === "" ? "_rels/.rels" : relsPathFor(ownerPath);
    if (!this.has(relsPath)) return out;
    const doc = await this.readXml(relsPath);
    for (const r of children(doc.documentElement, "Relationship")) {
      const id = r.getAttribute("Id");
      const target = r.getAttribute("Target");
      if (!id || !target) continue;
      const external = r.getAttribute("TargetMode") === "External";
      out.set(id, {
        id,
        type: r.getAttribute("Type") ?? "",
        target: external ? target : resolvePartPath(ownerPath || "x", target),
        external,
      });
    }
    return out;
  }
}

/** Value of `r:id` on an element. */
export function relId(el: Element): string | undefined {
  return attr(el, "id");
}

export function relTypeEndsWith(rel: Relationship, suffix: string): boolean {
  return rel.type.endsWith(suffix);
}
