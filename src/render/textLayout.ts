import type { TextRun } from "../model/types";

let ctx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (ctx === undefined) {
    try {
      ctx = document.createElement("canvas").getContext("2d");
    } catch {
      ctx = null;
    }
  }
  return ctx;
}

type Fonted = Pick<TextRun, "fontSize" | "fontFamily" | "bold" | "italic">;

export function fontShorthand(s: Fonted): string {
  return `${s.italic ? "italic " : ""}${s.bold ? "bold " : ""}${s.fontSize}px ${s.fontFamily}`;
}

function measure(text: string, run: Fonted): number {
  const c = context();
  if (!c) return text.length * run.fontSize * 0.55;
  c.font = fontShorthand(run);
  return c.measureText(text).width;
}

export interface LineSegment {
  text: string;
  run: TextRun;
}

export interface TextLine {
  segments: LineSegment[];
  /** Alignment of the line's paragraph (taken from its first run). */
  align: TextRun["align"];
  /** Tallest font on the line, px. */
  fontSize: number;
  width: number;
}

const LINE_HEIGHT = 1.2;
export const lineHeightOf = (l: TextLine) => l.fontSize * LINE_HEIGHT;

/**
 * Lay formatted runs out in a block `maxWidth` px wide. Explicit "\n" always
 * breaks; otherwise a line breaks at the last space that fits, measuring each
 * word with its own run's font. Words wider than the block overflow.
 */
export function layoutRuns(runs: TextRun[], maxWidth: number): TextLine[] {
  const lines: TextLine[] = [];
  let cur: TextLine | null = null;

  const start = (run: TextRun): TextLine => ({
    segments: [],
    align: run.align,
    fontSize: run.fontSize,
    width: 0,
  });
  const finish = () => {
    if (!cur) return;
    // Trailing spaces must not count towards alignment.
    const last = cur.segments[cur.segments.length - 1];
    if (last) {
      const trimmed = last.text.trimEnd();
      cur.width -= measure(last.text, last.run) - measure(trimmed, last.run);
      last.text = trimmed;
    }
    lines.push(cur);
    cur = null;
  };
  const add = (text: string, run: TextRun, w: number) => {
    if (!cur) cur = start(run);
    const last = cur.segments[cur.segments.length - 1];
    if (last && last.run === run) last.text += text;
    else cur.segments.push({ text, run });
    cur.width += w;
    cur.fontSize = Math.max(cur.fontSize, run.fontSize);
  };

  for (const run of runs) {
    // A tab is shown as a fixed gap; the model keeps the real "\t" so edits stay exact.
    const parts = run.text.replace(/\t/g, "\u00a0\u00a0\u00a0\u00a0").split("\n");
    parts.forEach((part, pi) => {
      if (pi > 0) {
        if (!cur) cur = start(run); // blank line keeps the run's height
        finish();
      }
      for (const word of part.match(/\S+\s*|\s+/g) ?? []) {
        const w = measure(word, run);
        const wTrim = measure(word.trimEnd(), run);
        if (cur && cur.segments.length && maxWidth > 0 && cur.width + wTrim > maxWidth) {
          finish();
        }
        add(word, run, w);
      }
    });
  }
  if (cur) finish();
  // Text ending in a line break ends in an empty line, which still takes up height.
  const final = runs[runs.length - 1];
  if (final?.text.endsWith("\n")) {
    lines.push({ segments: [], align: final.align, fontSize: final.fontSize, width: 0 });
  }
  return lines;
}
