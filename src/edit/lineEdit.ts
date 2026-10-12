/**
 * Reshaping a line (pure; no XML): dragging a piece of it or one of its bends.
 *
 * - A **piece** between two bends of a square line slides across itself; the pieces on either
 *   side stretch. The pieces at the two ends stay (the ends have their own handles).
 * - A **bend** follows the pointer; the pieces it joins, when they were square, pull the
 *   bends at their other ends along so they stay square.
 * - Pulling the middle of a **straight** two-point line adds a bend there.
 */
import type { Point } from "../model/types";
import { simplify } from "./routing";

const EPS = 0.5;

/**
 * The points to work on: bends closer than 1.5 px to the previous one are one bend (files often
 * hold a doubled point), and points on a straight run are not bends.
 */
export function normalise(pts: Point[]): Point[] {
  const kept = pts.filter((p, i) => i === 0 || i === pts.length - 1 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) >= 1.5);
  // the end could now sit right next to the last kept bend: drop that bend instead of the end
  const n = kept.length;
  if (n > 2 && Math.hypot(kept[n - 1].x - kept[n - 2].x, kept[n - 1].y - kept[n - 2].y) < 1.5) kept.splice(n - 2, 1);
  return simplify(kept);
}
const same = (a: number, b: number) => Math.abs(a - b) < EPS;

export type PieceKind = "horizontal" | "vertical" | "slanted";

export function pieceKind(a: Point, b: Point): PieceKind {
  if (same(a.y, b.y) && !same(a.x, b.x)) return "horizontal";
  if (same(a.x, b.x) && !same(a.y, b.y)) return "vertical";
  return "slanted";
}

/** Which pieces can be dragged: those between two bends, and the one piece of a straight line. */
export function draggablePieces(pts: Point[]): { index: number; kind: PieceKind; mid: Point; split: boolean }[] {
  const n = pts.length;
  const out: { index: number; kind: PieceKind; mid: Point; split: boolean }[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const interior = i >= 1 && i + 1 <= n - 2;
    if (!interior && n !== 2) continue;
    const [a, b] = [pts[i], pts[i + 1]];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 6) continue; // too short to grab
    out.push({ index: i, kind: pieceKind(a, b), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, split: n === 2 });
  }
  return out;
}

/** Slide piece `i` (between bends i and i+1) by `d`; a square piece moves across itself only. */
export function movePiece(pts: Point[], i: number, d: Point): Point[] {
  const out = pts.map((p) => ({ ...p }));
  if (i < 1 || i + 1 > pts.length - 2) return out;
  const kind = pieceKind(pts[i], pts[i + 1]);
  const [dx, dy] = [kind === "horizontal" ? 0 : d.x, kind === "vertical" ? 0 : d.y];
  for (const j of [i, i + 1]) {
    out[j].x += dx;
    out[j].y += dy;
  }
  return simplify(out);
}

/** Add a bend at `at` in a straight two-point line. */
export function splitPiece(pts: Point[], at: Point): Point[] {
  return pts.length === 2 ? [pts[0], { ...at }, pts[1]] : pts;
}

/**
 * Move bend `i` to `to`. A neighbouring bend that is not an end of the line, joined to this
 * one by a square piece, moves along so that piece stays square.
 */
export function moveBend(pts: Point[], i: number, to: Point): Point[] {
  const out = pts.map((p) => ({ ...p }));
  const n = pts.length;
  if (i < 1 || i > n - 2) return out;
  for (const j of [i - 1, i + 1]) {
    if (j < 1 || j > n - 2) continue; // an end stays where it is
    const kind = pieceKind(pts[i], pts[j]);
    if (kind === "horizontal") out[j].y = to.y;
    else if (kind === "vertical") out[j].x = to.x;
  }
  out[i] = { ...to };
  return simplify(out);
}

/** Pull `v` onto the nearest of `candidates` within `tol`, or leave it. */
export function pullTo(v: number, candidates: number[], tol: number): number {
  let best = v;
  let bestD = tol;
  for (const c of candidates) {
    const d = Math.abs(c - v);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}
