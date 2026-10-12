/**
 * BMP decoding with transparency.
 *
 * Visio embeds many pictures as 32-bit BMPs whose fourth byte is an alpha
 * channel (premultiplied). Browsers ignore that byte and paint transparent
 * pixels black, so BMPs are decoded here and handed to the browser as PNG.
 */

export interface DecodedImage {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA, top row first. */
  rgba: Uint8ClampedArray;
}

const BI_RGB = 0;
const BI_BITFIELDS = 3;

/** Scale a channel value through a mask to 0-255. */
function channel(value: number, mask: number): number {
  if (mask === 0) return 255;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  const max = mask >>> shift;
  return Math.round((((value & mask) >>> shift) * 255) / max);
}

/**
 * Decode an uncompressed BMP (1, 4, 8, 16, 24 or 32 bits per pixel).
 * Returns null for anything else (RLE, JPEG/PNG-in-BMP...), so the caller can
 * fall back to giving the bytes to the browser as they are.
 */
export function decodeBmp(bytes: Uint8Array): DecodedImage | null {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const dataOffset = v.getUint32(10, true);
  const headerSize = v.getUint32(14, true);
  if (headerSize < 40) return null; // OS/2 core header: not worth supporting
  const width = v.getInt32(18, true);
  const rawHeight = v.getInt32(22, true);
  const bpp = v.getUint16(28, true);
  const compression = v.getUint32(30, true);
  const colours = v.getUint32(46, true);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;

  if (width <= 0 || height === 0 || width * height > 64_000_000) return null;
  if (compression !== BI_RGB && compression !== BI_BITFIELDS) return null;
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) return null;

  const stride = Math.floor((width * bpp + 31) / 32) * 4;
  if (dataOffset + stride * height > bytes.length) return null;

  // Palette (indexed images).
  const palette: number[][] = [];
  if (bpp <= 8) {
    const count = colours || 1 << bpp;
    const at = 14 + headerSize;
    for (let i = 0; i < count && at + i * 4 + 3 < bytes.length; i++) {
      const o = at + i * 4;
      palette.push([bytes[o + 2], bytes[o + 1], bytes[o]]); // stored as B, G, R, unused
    }
  }

  // Channel masks (16/32-bit).
  let masks = bpp === 16 ? [0x7c00, 0x03e0, 0x001f, 0] : [0x00ff0000, 0x0000ff00, 0x000000ff, 0];
  if (compression === BI_BITFIELDS && (bpp === 16 || bpp === 32)) {
    const at = 14 + headerSize;
    // Masks follow a 40-byte header; later headers carry them inside the header.
    const base = headerSize === 40 ? at : 14 + 40;
    masks = [0, 1, 2, 3].map((i) => (base + i * 4 + 4 <= bytes.length && (i < 3 || headerSize >= 56) ? v.getUint32(base + i * 4, true) : 0));
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  let anyAlpha = false;

  for (let y = 0; y < height; y++) {
    const srcRow = dataOffset + (topDown ? y : height - 1 - y) * stride;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      switch (bpp) {
        case 1:
        case 4:
        case 8: {
          const bitsFromStart = x * bpp;
          const byte = bytes[srcRow + (bitsFromStart >> 3)];
          const shift = 8 - bpp - (bitsFromStart & 7);
          const idx = (byte >> shift) & ((1 << bpp) - 1);
          [r, g, b] = palette[idx] ?? [0, 0, 0];
          break;
        }
        case 16: {
          const px = v.getUint16(srcRow + x * 2, true);
          r = channel(px, masks[0]);
          g = channel(px, masks[1]);
          b = channel(px, masks[2]);
          break;
        }
        case 24: {
          const o = srcRow + x * 3;
          b = bytes[o];
          g = bytes[o + 1];
          r = bytes[o + 2];
          break;
        }
        case 32: {
          const px = v.getUint32(srcRow + x * 4, true);
          if (compression === BI_BITFIELDS) {
            r = channel(px, masks[0]);
            g = channel(px, masks[1]);
            b = channel(px, masks[2]);
            a = masks[3] ? channel(px, masks[3]) : 255;
          } else {
            b = px & 0xff;
            g = (px >>> 8) & 0xff;
            r = (px >>> 16) & 0xff;
            a = px >>> 24;
          }
          if (a !== 0) anyAlpha = true;
          break;
        }
      }
      rgba[dst++] = r;
      rgba[dst++] = g;
      rgba[dst++] = b;
      rgba[dst++] = a;
    }
  }

  if (bpp === 32) {
    if (!anyAlpha) {
      // A 32-bit BMP without a real alpha channel stores zeros there: it is opaque.
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    } else if (compression === BI_RGB) {
      // Visio stores premultiplied colour; canvas wants straight alpha.
      for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3];
        if (a > 0 && a < 255) {
          rgba[i] = Math.min(255, Math.round((rgba[i] * 255) / a));
          rgba[i + 1] = Math.min(255, Math.round((rgba[i + 1] * 255) / a));
          rgba[i + 2] = Math.min(255, Math.round((rgba[i + 2] * 255) / a));
        }
      }
    }
  }
  return { width, height, rgba };
}

const MAX_SIDE = 1024;

/**
 * Re-encode a decoded image as PNG (keeping transparency), shrinking very large
 * pictures: diagram icons are drawn at a few dozen pixels, and a 2000x2000 bitmap
 * would cost 16 MB of memory for no visible gain. Returns null where no canvas exists.
 */
export async function toPngBlob(img: DecodedImage): Promise<Blob | null> {
  const makeCanvas = (w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null => {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    if (typeof document !== "undefined") {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    }
    return null;
  };

  const full = makeCanvas(img.width, img.height);
  const fullCtx = full?.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
  if (!full || !fullCtx) return null;
  fullCtx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);

  let out = full;
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  if (scale < 1) {
    const small = makeCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
    const ctx = small?.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
    if (small && ctx) {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(full as CanvasImageSource, 0, 0, small.width, small.height);
      out = small;
    }
  }

  if ("convertToBlob" in out) return out.convertToBlob({ type: "image/png" });
  return new Promise((resolve) => (out as HTMLCanvasElement).toBlob((b) => resolve(b), "image/png"));
}
