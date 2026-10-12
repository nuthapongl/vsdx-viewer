import type { TextRun, TextStyle } from "../model/types";
import { PX_PER_INCH } from "./coordinateTransform";
import { parseColor, type ShapeSheet } from "./sheet";
import type { Cell } from "./types";

const DEFAULT_SIZE_IN = 0.1667; // 12 pt
const DEFAULT_FONT = "Calibri";

const num = (v: string): number | undefined => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Metric-compatible / commonly installed alternatives, tried after the font the file asks for. */
const ALIASES: Record<string, string[]> = {
  calibri: ["Carlito"],
  cambria: ["Caladea"],
  arial: ["Helvetica", "Liberation Sans"],
  "times new roman": ["Times", "Liberation Serif"],
  "courier new": ["Courier", "Liberation Mono"],
  "segoe ui": ["Helvetica Neue"],
  tahoma: ["DejaVu Sans"],
  verdana: ["DejaVu Sans"],
};

function genericFamily(name: string): string {
  const n = name.toLowerCase();
  if (/courier|consolas|monaco|mono|lucida console/.test(n)) return "monospace";
  if (/times|cambria|georgia|garamond|palatino|book antiqua|serif(?!.*sans)|minion/.test(n)) {
    return "serif";
  }
  return "sans-serif";
}

/** CSS `font-family` value for the font names found in a file (primary first). */
export function cssFontFamily(names: string[]): string {
  const list: string[] = [];
  for (const name of names) {
    list.push(name, ...(ALIASES[name.toLowerCase()] ?? []));
  }
  const unique = [...new Set(list)];
  const quoted = unique.map((n) => `"${n.replace(/"/g, "")}"`);
  return [...quoted, genericFamily(names[0] ?? DEFAULT_FONT)].join(", ");
}

/**
 * Font names for a Character row. `Font` is either a FaceName index, a literal
 * name, or "Themed"; the complex-script / Asian fonts (Thai, CJK...) follow so
 * the browser can pick them for those glyphs.
 */
function fontNames(sheet: ShapeSheet, ix: string): string[] {
  const resolve = (v: string): string | undefined => {
    const t = v.trim();
    if (!t || t === "Themed") return undefined;
    return /^\d+$/.test(t) ? sheet.fontName(t) : t;
  };
  const names = ["Font", "ComplexScriptFont", "AsianFont"]
    .map((cell) => sheet.sectionValue("Character", ix, cell, resolve))
    .filter((n): n is string => !!n);
  const unique = [...new Set(names)];
  return unique.length ? unique : [DEFAULT_FONT];
}

type RunStyle = Omit<TextRun, "text"> & { upper: boolean };

function runStyle(sheet: ShapeSheet, cp: string, pp: string): RunStyle {
  const ch = <T>(cell: string, parse: (v: string, c: Cell) => T | undefined) =>
    sheet.sectionValue("Character", cp, cell, parse);

  const sizeIn = ch("Size", num) ?? DEFAULT_SIZE_IN;
  const scale = ch("FontScale", num);
  const bits = ch("Style", num) ?? 0;
  const horz = sheet.sectionValue("Paragraph", pp, "HorzAlign", num) ?? 1;

  return {
    fontSize: sizeIn * (scale && scale > 0 ? scale : 1) * PX_PER_INCH,
    fontFamily: cssFontFamily(fontNames(sheet, cp)),
    // The style's colour is the theme's text colour; a themed shape gets white or black by its fill.
    color: ch("Color", (v, c) => (c.f && /THEMEVAL/.test(c.f) ? (sheet.autoTextColor() ?? parseColor(v)) : parseColor(v))) ?? "#000000",
    bold: (bits & 1) !== 0,
    italic: (bits & 2) !== 0,
    underline: (bits & 4) !== 0,
    align: horz === 2 ? "right" : horz === 1 ? "center" : "left",
    upper: ch("Case", num) === 1,
  };
}

/**
 * Normalise line endings. Visio writes a Shift+Enter line break as U+2028 (and a
 * paragraph break as U+2029); treat all of them like "\n".
 */
export const normalizeBreaks = (s: string) => s.replace(/\r\n?|[\u2028\u2029]/g, "\n");

/**
 * Split a `<Text>` element into formatting runs. `<cp IX>` switches the
 * Character row, `<pp IX>` the Paragraph row, `<fld>` contributes its cached value.
 */
export function parseTextRuns(textEl: Element, sheet: ShapeSheet): TextRun[] {
  let cp = "0";
  let pp = "0";
  const raw: { text: string; cp: string; pp: string }[] = [];
  const push = (text: string) => {
    if (!text) return;
    const last = raw[raw.length - 1];
    if (last && last.cp === cp && last.pp === pp) last.text += text;
    else raw.push({ text, cp, pp });
  };
  const walk = (node: Node) => {
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3 || n.nodeType === 4) {
        push(normalizeBreaks(n.nodeValue ?? ""));
      } else if (n.nodeType === 1) {
        const el = n as Element;
        switch (el.localName) {
          case "cp":
            cp = el.getAttribute("IX") ?? "0";
            break;
          case "pp":
            pp = el.getAttribute("IX") ?? "0";
            break;
          case "tp":
            break;
          case "fld":
            push(normalizeBreaks(el.textContent ?? ""));
            break;
          default:
            walk(el);
        }
      }
    });
  };
  walk(textEl);

  // The last "\n" only terminates the last paragraph. Any further ones are blank lines
  // that take up height (and so move the text when it is centred).
  const last = raw[raw.length - 1];
  if (last?.text.endsWith("\n")) {
    last.text = last.text.slice(0, -1);
    if (last.text === "") raw.pop();
  }

  const cache = new Map<string, RunStyle>();
  return raw.map((r) => {
    const key = `${r.cp}|${r.pp}`;
    let st = cache.get(key);
    if (!st) {
      st = runStyle(sheet, r.cp, r.pp);
      cache.set(key, st);
    }
    const { upper, ...style } = st;
    return { ...style, text: upper ? r.text.toUpperCase() : r.text };
  });
}

/** Block-level text settings, with the first run's character style as the default. */
export function buildTextStyle(sheet: ShapeSheet, first: TextRun): TextStyle {
  const vert = sheet.num("VerticalAlign", 1);
  const m = (n: string) => sheet.num(n, 0.0556) * PX_PER_INCH;
  // Colour index 0 is the default "no background", not black.
  const bkRaw = sheet.cell("TextBkgnd")?.v;
  const background = bkRaw && bkRaw !== "0" ? parseColor(bkRaw) : undefined;
  return {
    ...(background ? { background } : {}),
    fontSize: first.fontSize,
    fontFamily: first.fontFamily,
    color: first.color,
    bold: first.bold,
    italic: first.italic,
    underline: first.underline,
    align: first.align,
    verticalAlign: vert === 0 ? "top" : vert === 2 ? "bottom" : "middle",
    margins: {
      top: m("TopMargin"),
      right: m("RightMargin"),
      bottom: m("BottomMargin"),
      left: m("LeftMargin"),
    },
  };
}
