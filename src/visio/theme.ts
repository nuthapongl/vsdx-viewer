/**
 * Visio themes. A themed shape stores "Themed" instead of a fill, and the real look comes from
 * the theme part: a colour (a variation colour picked by the shape's QuickStyle codes) and a
 * fill/line style that lightens or darkens it (often a top-to-bottom gradient).
 */

/** Factors applied to a colour's lightness and saturation (1 = unchanged). */
export interface ColorMods {
  lumMod: number;
  satMod: number;
}

export interface ThemeFill {
  /** One stop for a solid fill. */
  stops: { pos: number; mods: ColorMods }[];
  /** Degrees, clockwise from the x axis (90 = top to bottom). */
  angle: number;
}

/** A drop shadow, in px. */
export interface ThemeShadow {
  dx: number;
  dy: number;
  blur: number;
  opacity: number;
}

export interface ThemeInfo {
  /** Effect styles (1-based index in Visio): a shadow or none. */
  effects: (ThemeShadow | null)[];
  /** Colours of the first colour variation (varColor1...), as `#rrggbb`. */
  variationColors: string[];
  fills: ThemeFill[];
  lines: ColorMods[];
  /** Per QuickStyle matrix number: which fill/line style (1-based) the first variation uses. */
  styleIdx: number[];
}

const NONE: ColorMods = { lumMod: 1, satMod: 1 };

function modsOf(el: Element | null | undefined): ColorMods {
  const clr = el ? Array.from(el.getElementsByTagNameNS("*", "schemeClr"))[0] : undefined;
  if (!clr) return NONE;
  const get = (name: string) => {
    const m = Array.from(clr.children).find((c) => c.localName === name);
    const v = m ? parseFloat(m.getAttribute("val") ?? "") : NaN;
    return Number.isFinite(v) ? v / 100000 : 1;
  };
  return { lumMod: get("lumMod"), satMod: get("satMod") };
}

const kids = (el: Element | undefined, name?: string) =>
  el ? Array.from(el.children).filter((c) => !name || c.localName === name) : [];
const first = (root: Document, name: string) => Array.from(root.getElementsByTagNameNS("*", name))[0];

export function parseTheme(doc: Document): ThemeInfo | undefined {
  const fillLst = first(doc, "fillStyleLst");
  if (!fillLst) return undefined;
  const fills: ThemeFill[] = kids(fillLst).map((f) => {
    if (f.localName !== "gradFill") return { stops: [{ pos: 0, mods: modsOf(f) }], angle: 90 };
    const stops = kids(kids(f, "gsLst")[0], "gs").map((gs) => ({
      pos: (parseFloat(gs.getAttribute("pos") ?? "0") || 0) / 100000,
      mods: modsOf(gs),
    }));
    const ang = parseFloat(kids(f, "lin")[0]?.getAttribute("ang") ?? "5400000") / 60000;
    return { stops, angle: Number.isFinite(ang) ? ang : 90 };
  });
  const lines = kids(first(doc, "lnStyleLst")).map((ln) => modsOf(ln));
  const variation = first(doc, "variationClrScheme");
  const variationColors = kids(variation).map((c) => {
    const v = Array.from(c.getElementsByTagNameNS("*", "srgbClr"))[0]?.getAttribute("val");
    return v ? `#${v.toLowerCase()}` : "#000000";
  });
  const styleIdx = kids(first(doc, "variationStyleScheme"), "varStyle").map(
    (s) => parseInt(s.getAttribute("fillIdx") ?? "1", 10) || 1,
  );
  const effects = kids(first(doc, "effectStyleLst")).map((e): ThemeShadow | null => {
    const sh = Array.from(e.getElementsByTagNameNS("*", "outerShdw"))[0];
    if (!sh) return null;
    const emu = (n: string) => (parseFloat(sh.getAttribute(n) ?? "0") || 0) / 9525; // EMU -> px
    const dir = ((parseFloat(sh.getAttribute("dir") ?? "0") || 0) / 60000) * (Math.PI / 180);
    const alpha = Array.from(sh.getElementsByTagNameNS("*", "alpha"))[0]?.getAttribute("val");
    return {
      dx: emu("dist") * Math.cos(dir),
      dy: emu("dist") * Math.sin(dir),
      blur: emu("blurRad"),
      opacity: alpha ? parseFloat(alpha) / 100000 : 1,
    };
  });
  return { variationColors, fills, lines, styleIdx, effects };
}

// --- colour maths ---------------------------------------------------------------------------

function toHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const f = (p: number, q: number, t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const [r, g, b] = s === 0 ? [l, l, l] : [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
  return `#${[r, g, b].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function applyMods(hex: string, m: ColorMods): string {
  const [h, s, l] = toHsl(hex);
  return fromHsl(h, Math.min(1, s * m.satMod), Math.min(1, l * m.lumMod));
}

/** Relative brightness 0..1 of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
