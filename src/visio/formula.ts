/**
 * Minimal evaluator for the Visio ShapeSheet formulas that matter for
 * inherited geometry: arithmetic over numbers, `Width` and `Height`.
 *
 * Anything else (cross-sheet references, functions we don't know...) makes
 * evaluation fail by returning `undefined`; callers then fall back to scaling
 * the master's cached value.
 */

export type FormulaScope = Record<string, number>;

type Token = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Token[] | undefined {
  const out: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z_0-9.]*)|([-+*/^(),]))/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) return /^\s*$/.test(src.slice(pos)) ? out : undefined;
    pos = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: parseFloat(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "id", v: m[2] });
    else out.push({ t: "op", v: m[3] });
  }
  return out;
}

class Parser {
  private i = 0;
  private toks: Token[];
  private scope: FormulaScope;

  constructor(toks: Token[], scope: FormulaScope) {
    this.toks = toks;
    this.scope = scope;
  }

  done(): boolean {
    return this.i >= this.toks.length;
  }

  private peekOp(v: string): boolean {
    const t = this.toks[this.i];
    return !!t && t.t === "op" && t.v === v;
  }

  expr(): number {
    let a = this.term();
    while (this.peekOp("+") || this.peekOp("-")) {
      const op = (this.toks[this.i++] as { v: string }).v;
      const b = this.term();
      a = op === "+" ? a + b : a - b;
    }
    return a;
  }

  private term(): number {
    let a = this.unary();
    while (this.peekOp("*") || this.peekOp("/")) {
      const op = (this.toks[this.i++] as { v: string }).v;
      const b = this.unary();
      a = op === "*" ? a * b : a / b;
    }
    return a;
  }

  private unary(): number {
    if (this.peekOp("-")) {
      this.i++;
      return -this.unary();
    }
    if (this.peekOp("+")) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  /** `a ^ b` (right-associative, binds tighter than * and /). */
  private power(): number {
    const base = this.atom();
    if (this.peekOp("^")) {
      this.i++;
      return Math.pow(base, this.unary());
    }
    return base;
  }

  private args(): number[] {
    const out: number[] = [];
    if (this.peekOp(")")) {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.expr());
      if (this.peekOp(",")) this.i++;
      else break;
    }
    if (!this.peekOp(")")) throw new Error("expected )");
    this.i++;
    return out;
  }

  private atom(): number {
    const t = this.toks[this.i++];
    if (!t) throw new Error("unexpected end");
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = this.expr();
      if (!this.peekOp(")")) throw new Error("expected )");
      this.i++;
      return v;
    }
    if (t.t === "id") {
      if (this.peekOp("(")) {
        this.i++;
        const a = this.args();
        switch (t.v.toUpperCase()) {
          case "GUARD":
          case "NO_FORMULA":
            if (a.length === 1) return a[0];
            break;
          case "MIN":
            if (a.length) return Math.min(...a);
            break;
          case "MAX":
            if (a.length) return Math.max(...a);
            break;
          case "ABS":
            if (a.length === 1) return Math.abs(a[0]);
            break;
          case "SQRT":
            if (a.length === 1) return Math.sqrt(a[0]);
            break;
          case "ATAN2":
            if (a.length === 2) return Math.atan2(a[0], a[1]);
            break;
          case "SIN":
            if (a.length === 1) return Math.sin(a[0]);
            break;
          case "COS":
            if (a.length === 1) return Math.cos(a[0]);
            break;
          case "ATAN":
            if (a.length === 1) return Math.atan(a[0]);
            break;
          case "PI":
            if (a.length === 0) return Math.PI;
            break;
        }
        throw new Error(`unsupported function ${t.v}`);
      }
      const key = Object.keys(this.scope).find((k) => k.toLowerCase() === t.v.toLowerCase());
      if (key !== undefined) return this.scope[key];
      throw new Error(`unknown reference ${t.v}`);
    }
    throw new Error("unexpected token");
  }
}

export function evalFormula(formula: string, scope: FormulaScope): number | undefined {
  const f = formula.trim().replace(/^=/, "");
  if (!f) return undefined;
  const toks = tokenize(f);
  if (!toks) return undefined;
  try {
    const p = new Parser(toks, scope);
    const v = p.expr();
    return p.done() && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
