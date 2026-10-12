import { evalFormula } from "./formula";
import { applyMods, luminance, type ThemeFill, type ThemeShadow } from "./theme";
import type { Cell, DocumentContext, Row, Section, ShapeData } from "./types";

export type StyleKind = "line" | "fill" | "text";

export interface StyleIds {
  line?: string;
  fill?: string;
  text?: string;
}

/** Visio's default 24-colour palette (colour indexes 0-23). */
const PALETTE = [
  "#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
  "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#C0C0C0", "#E6E6E6",
  "#CDCDCD", "#B3B3B3", "#9A9A9A", "#808080", "#666666", "#4D4D4D", "#333333", "#1A1A1A",
];

export function parseColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (/^\d+$/.test(s)) return PALETTE[parseInt(s, 10)];
  return undefined;
}

function styleKindOf(cellName: string): StyleKind {
  if (/^(Line|Rounding|BeginArrow|EndArrow)/.test(cellName)) return "line";
  if (/^(Fill|Shdw)/.test(cellName)) return "fill";
  return "text";
}

/** Values are stored in internal units (inches, radians) whatever the cell's U attribute says. */
function parseNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

export type Axis = "x" | "y" | "none";

/**
 * Read access to the effective cells of one shape: the shape's own cells,
 * then its master's, then the style-sheet chain.
 */
export class ShapeSheet {
  readonly data: ShapeData;
  /** Resolved size in inches. */
  readonly width: number;
  readonly height: number;
  private masterW: number;
  private masterH: number;
  private ctx: DocumentContext;
  private styleIds: StyleIds;

  constructor(
    ctx: DocumentContext,
    data: ShapeData,
    styleIds: StyleIds,
    masterData?: ShapeData,
  ) {
    this.ctx = ctx;
    this.styleIds = styleIds;
    this.data = data;
    this.width = this.resolveSize("Width", {});
    this.height = this.resolveSize("Height", {});
    this.masterW = parseNumber(masterData?.cells.get("Width")?.v) ?? this.width;
    this.masterH = parseNumber(masterData?.cells.get("Height")?.v) ?? this.height;
  }

  private resolveSize(name: string, scope: Record<string, number>): number {
    const c = this.data.cells.get(name);
    if (!c) return 0;
    if (c.inherited && c.f) {
      const v = evalFormula(c.f, scope);
      if (v !== undefined) return v;
    }
    return parseNumber(c.v) ?? 0;
  }

  /** Cell by name with inheritance. */
  cell(name: string): Cell | undefined {
    return this.data.cells.get(name) ?? this.styleCell(styleKindOf(name), name);
  }

  private styleCell(kind: StyleKind, name: string): Cell | undefined {
    let id = this.styleIds[kind];
    const seen = new Set<string>();
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const ss = this.ctx.styles.get(id);
      if (!ss) break;
      const c = ss.data.cells.get(name);
      if (c) return c;
      id = kind === "line" ? ss.lineStyle : kind === "fill" ? ss.fillStyle : ss.textStyle;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.data.cells.has(name);
  }

  /**
   * Numeric value of a cell in internal units (inches / radians).
   * Inherited formulas are re-evaluated against this shape's size.
   */
  num(name: string, fallback: number, axis: Axis = "none"): number {
    const c = this.cell(name);
    return c ? (this.value(c, axis) ?? fallback) : fallback;
  }

  /** Numeric value of any cell (including geometry-row cells). */
  value(c: Cell, axis: Axis): number | undefined {
    if (c.inherited && c.f) {
      const v = evalFormula(c.f, { Width: this.width, Height: this.height });
      if (v !== undefined) return v;
    }
    const v = parseNumber(c.v);
    if (v === undefined) return undefined;
    if (c.inherited && axis === "x" && this.masterW > 0) return (v * this.width) / this.masterW;
    if (c.inherited && axis === "y" && this.masterH > 0) return (v * this.height) / this.masterH;
    return v;
  }

  color(name: string): string | undefined {
    return parseColor(this.cell(name)?.v);
  }

  // --- themes ---------------------------------------------------------------------------

  private code(name: string): number | undefined {
    const v = parseNumber(this.cell(name)?.v);
    return v !== undefined && v >= 100 ? v : undefined;
  }

  /** The shape's fill is whatever the theme says ("Themed"), not a colour of its own. */
  get fillThemed(): boolean {
    return this.cell("FillForegnd")?.v === "Themed" || this.cell("FillPattern")?.v === "Themed";
  }

  /**
   * The colour a themed shape is built on. Visio writes it into FillBkgnd of the shape itself;
   * when that is only the style's default, the QuickStyle code picks a variation colour.
   */
  fillBase(): string | undefined {
    const bk = this.cell("FillBkgnd");
    const own = bk && !(bk.f && /THEMEVAL/.test(bk.f)) ? parseColor(bk.v) : undefined;
    if (own) return own;
    const code = this.code("QuickStyleFillColor");
    return code === undefined ? undefined : this.ctx.theme?.variationColors[code - 100];
  }

  private themeStyle(matrix: string): number {
    const code = this.code(matrix);
    return (code === undefined ? undefined : this.ctx.theme?.styleIdx[code - 100]) ?? 1;
  }

  /** A themed fill: a solid colour or a gradient, from the theme's fill style. */
  themedFill(): { solid?: string; gradient?: { angle: number; stops: { offset: number; color: string }[] } } | undefined {
    const base = this.fillBase();
    const f: ThemeFill | undefined = this.ctx.theme?.fills[this.themeStyle("QuickStyleFillMatrix") - 1];
    if (!base || !f) return undefined;
    const stops = f.stops.map((st) => ({ offset: st.pos, color: applyMods(base, st.mods) }));
    return stops.length > 1 ? { gradient: { angle: f.angle, stops } } : { solid: stops[0]?.color };
  }

  /** The outline colour of a themed shape: its base colour, darkened by the theme's line style. */
  themedLine(): string | undefined {
    const c = this.cell("LineColor");
    if (c && parseColor(c.v)) return undefined;
    const base = this.fillBase();
    const mods = this.ctx.theme?.lines[this.themeStyle("QuickStyleLineMatrix") - 1];
    return base && mods ? applyMods(base, mods) : undefined;
  }

  /** The drop shadow of a themed shape, if the theme's effect style has one and the shape shows it. */
  themedShadow(): ThemeShadow | undefined {
    const raw = this.cell("ShdwPattern")?.v;
    const on = raw === "Themed" || (parseNumber(raw) ?? 0) > 0;
    if (!on || (raw !== "Themed" && this.code("QuickStyleEffectsMatrix") === undefined)) return undefined;
    return this.ctx.theme?.effects[this.themeStyle("QuickStyleEffectsMatrix") - 1] ?? undefined;
  }

  /** Text colour a themed shape gets automatically: white on dark fills, black on light ones. */
  autoTextColor(): string | undefined {
    if (this.code("QuickStyleFontColor") === undefined) return undefined;
    // A connector's label takes its line's colour.
    if (this.has("BeginX") && this.has("EndX")) return this.color("LineColor") ?? this.themedLine();
    const fill = this.color("FillForegnd") ?? this.fillBase();
    return fill ? (luminance(fill) < 0.55 ? "#ffffff" : "#000000") : undefined;
  }

  /** Section from the shape (merged with master), without style fallback. */
  section(name: string): Section | undefined {
    return this.data.sections.get(name);
  }

  /**
   * First usable value of a cell in a row of a text-formatting section
   * (Character, Paragraph): the shape's own row, then the text style chain.
   * `parse` returns undefined for values it can't resolve (e.g. "Themed"), in
   * which case the next level is tried.
   */
  sectionValue<T>(
    section: string,
    rowIx: string,
    cellName: string,
    parse: (v: string, cell: Cell) => T | undefined,
  ): T | undefined {
    const tryCell = (sec: Section | undefined): T | undefined => {
      const c = sec ? (sec.rows.get(rowIx) ?? firstRow(sec))?.cells.get(cellName) : undefined;
      return c ? parse(c.v, c) : undefined;
    };
    const own = tryCell(this.section(section));
    if (own !== undefined) return own;
    let id = this.styleIds.text;
    const seen = new Set<string>();
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const ss = this.ctx.styles.get(id);
      if (!ss) break;
      const v = tryCell(ss.data.sections.get(section));
      if (v !== undefined) return v;
      id = ss.textStyle;
    }
    return undefined;
  }

  fontName(id: string | undefined): string | undefined {
    return id === undefined ? undefined : this.ctx.fonts.get(id);
  }
}

function firstRow(s: Section): Row | undefined {
  return s.rows.values().next().value;
}
