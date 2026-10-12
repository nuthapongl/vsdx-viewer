import { describe, expect, it } from "vitest";
import { decodeBmp } from "./bmp";

/** Build a BMP in memory. `rows` are given top row first; pixels as [r,g,b,a]. */
function bmp32(rows: number[][][], opts: { topDown?: boolean } = {}): Uint8Array {
  const h = rows.length;
  const w = rows[0].length;
  const size = 54 + w * h * 4;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, size, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, opts.topDown ? -h : h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 32, true);
  const order = opts.topDown ? rows : [...rows].reverse();
  order.forEach((row, y) =>
    row.forEach(([r, g, b, a], x) => {
      const o = 54 + (y * w + x) * 4;
      out[o] = b;
      out[o + 1] = g;
      out[o + 2] = r;
      out[o + 3] = a;
    }),
  );
  return out;
}

function bmp8(palette: number[][], indexRows: number[][]): Uint8Array {
  const h = indexRows.length;
  const w = indexRows[0].length;
  const stride = Math.ceil(w / 4) * 4;
  const off = 54 + palette.length * 4;
  const out = new Uint8Array(off + stride * h);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(10, off, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 8, true);
  v.setUint32(46, palette.length, true);
  palette.forEach(([r, g, b], i) => out.set([b, g, r, 0], 54 + i * 4));
  [...indexRows].reverse().forEach((row, y) => out.set(row, off + y * stride));
  return out;
}

const px = (img: { width: number; rgba: Uint8ClampedArray }, x: number, y: number) =>
  [...img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe("decodeBmp", () => {
  it("reads 32-bit colour with an alpha channel (bottom-up and top-down)", () => {
    const rows = [
      [[255, 0, 0, 255], [0, 255, 0, 255]],
      [[0, 0, 255, 255], [0, 0, 0, 0]],
    ];
    for (const topDown of [false, true]) {
      const img = decodeBmp(bmp32(rows, { topDown }))!;
      expect([img.width, img.height]).toEqual([2, 2]);
      expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);
      expect(px(img, 1, 0)).toEqual([0, 255, 0, 255]);
      expect(px(img, 0, 1)).toEqual([0, 0, 255, 255]);
      expect(px(img, 1, 1)[3]).toBe(0); // transparent stays transparent
    }
  });

  it("un-premultiplies partly transparent pixels", () => {
    // 50% white stored premultiplied: colour 128 at alpha 128 -> straight 255
    const img = decodeBmp(bmp32([[[128, 128, 128, 128], [255, 255, 255, 255]]]))!;
    const [r, g, b, a] = px(img, 0, 0);
    expect(a).toBe(128);
    expect([r, g, b]).toEqual([255, 255, 255]);
    expect(px(img, 1, 0)).toEqual([255, 255, 255, 255]);
  });

  it("treats a 32-bit BMP whose alpha bytes are all zero as opaque", () => {
    const img = decodeBmp(bmp32([[[10, 20, 30, 0], [40, 50, 60, 0]]]))!;
    expect(px(img, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(px(img, 1, 0)).toEqual([40, 50, 60, 255]);
  });

  it("reads 8-bit palette images, including row padding", () => {
    const img = decodeBmp(
      bmp8(
        [[0, 0, 0], [255, 0, 0], [0, 0, 255]],
        [
          [1, 2, 1],
          [2, 1, 0],
        ],
      ),
    )!;
    expect(img.width).toBe(3);
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 1, 0)).toEqual([0, 0, 255, 255]);
    expect(px(img, 2, 1)).toEqual([0, 0, 0, 255]);
  });

  it("reads 16-bit (5-5-5) and 24-bit images", () => {
    const b16 = new Uint8Array(54 + 4);
    const v = new DataView(b16.buffer);
    b16.set([0x42, 0x4d]);
    v.setUint32(10, 54, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, 1, true);
    v.setInt32(22, 1, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, 16, true);
    v.setUint16(54, 0x7c00, true); // pure red in 5-5-5
    const img = decodeBmp(b16)!;
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);

    const b24 = new Uint8Array(54 + 4);
    const w = new DataView(b24.buffer);
    b24.set([0x42, 0x4d]);
    w.setUint32(10, 54, true);
    w.setUint32(14, 40, true);
    w.setInt32(18, 1, true);
    w.setInt32(22, 1, true);
    w.setUint16(26, 1, true);
    w.setUint16(28, 24, true);
    b24.set([30, 20, 10], 54); // B, G, R
    expect(px(decodeBmp(b24)!, 0, 0)).toEqual([10, 20, 30, 255]);
  });

  it("rejects what it can't decode instead of guessing", () => {
    expect(decodeBmp(new Uint8Array([1, 2, 3]))).toBeNull();
    const rle = bmp8([[0, 0, 0]], [[0]]);
    new DataView(rle.buffer).setUint32(30, 1, true); // BI_RLE8
    expect(decodeBmp(rle)).toBeNull();
    const truncated = bmp32([[[1, 2, 3, 255]]]).slice(0, 56);
    expect(decodeBmp(truncated)).toBeNull();
  });
});
