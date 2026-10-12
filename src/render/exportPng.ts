import carlito400 from "@fontsource/carlito/files/carlito-latin-400-normal.woff2?url";
import carlito400i from "@fontsource/carlito/files/carlito-latin-400-italic.woff2?url";
import carlito700 from "@fontsource/carlito/files/carlito-latin-700-normal.woff2?url";
import carlito700i from "@fontsource/carlito/files/carlito-latin-700-italic.woff2?url";
import type { Bounds } from "./bounds";
import { fitScale } from "./exportRegion";

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const toDataUrl = async (url: string) => readAsDataUrl(await (await fetch(url)).blob());

let fontCss: Promise<string> | undefined;
/**
 * A picture made from an SVG can't use the page's web fonts, so Carlito (the stand-in for
 * Calibri) is embedded in it. Other fonts come from the machine, as they do on screen.
 */
function embeddedFonts(): Promise<string> {
  fontCss ??= Promise.all(
    [
      [carlito400, "normal", 400],
      [carlito400i, "italic", 400],
      [carlito700, "normal", 700],
      [carlito700i, "italic", 700],
    ].map(async ([url, style, weight]) => {
      const data = await toDataUrl(url as string);
      return `@font-face{font-family:Carlito;font-style:${style};font-weight:${weight};src:url(${data}) format("woff2");}`;
    }),
  )
    .then((rules) => rules.join(""))
    .catch(() => ""); // text still renders, in a fallback font
  return fontCss;
}

export interface PngResult {
  blob: Blob;
  width: number;
  height: number;
  /** The scale used, which is lower than asked when the image would have been too large. */
  scale: number;
}

/**
 * Draws part of the page as a PNG. `layers` are the rendered SVG groups (the diagram, and
 * optionally the analysis marks) in page px; they are copied, so the screen is not touched.
 */
export async function renderPng(layers: SVGGraphicsElement[], region: Bounds, wantedScale: number): Promise<PngResult> {
  const scale = fitScale(region, wantedScale);
  const width = Math.max(1, Math.round(region.width * scale));
  const height = Math.max(1, Math.round(region.height * scale));

  const copies = layers.map((l) => l.cloneNode(true) as SVGGraphicsElement);
  // Pictures are blob: URLs that only this page can read: put their bytes into the file.
  await Promise.all(
    copies.flatMap((c) =>
      [...c.querySelectorAll("image")].map(async (img) => {
        const href = img.getAttribute("href");
        if (href && !href.startsWith("data:")) img.setAttribute("href", await toDataUrl(href));
      }),
    ),
  );
  const serializer = new XMLSerializer();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${region.x} ${region.y} ${region.width} ${region.height}">` +
    `<defs><style>${await embeddedFonts()}</style></defs>` +
    `<rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="#fff"/>` +
    copies.map((c) => serializer.serializeToString(c)).join("") +
    `</svg>`;

  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("The picture could not be drawn"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas available");
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The picture is too large to export");
    return { blob, width, height, scale };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
