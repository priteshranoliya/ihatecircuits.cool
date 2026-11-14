export type BinOp = '&' | '|' | '^' | '~^' | '+' | '==' | '!=';
export type LitBase = 'b' | 'd' | 'h' | 'o';

export type Expr =
  | { k: 'ref'; name: string }
  | { k: 'bit'; name: string; index: number }
  | { k: 'part'; name: string; hi: number; lo: number }
  /** `width === null` is an unsized literal. */
  | { k: 'lit'; width: number | null; base: LitBase; value: number; /** Minimum digit count, zero padded. An unsized literal is as wide as its digits, so padding makes a small value 33+ bits wide. */ pad?: number }
  | { k: 'cat'; parts: Expr[] }
  | { k: 'not'; e: Expr }
  | { k: 'bin'; op: BinOp; l: Expr; r: Expr }
  | { k: 'cond'; c: Expr; t: Expr; f: Expr }
  | { k: 'paren'; e: Expr };

export type Stmt = { k: 'nb'; lhs: string; rhs: Expr } | { k: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] | null };

export interface Sig {
  name: string;
  width: number;
  /** Declared with `[N-1:0]`. A width-1 signal may be either; only ranged signals can be selected. */
  ranged: boolean;
}

export interface Port {
  sig: Sig;
  dir: 'in' | 'out';
  reg: boolean;
  /** `output reg [3:0] q = 4'd5`: a constant power-on value. */
  init?: Expr;
  /** A top-level input that gates a derived clock. The stimulus holds it at 1 in cycle 0 so gated regs are reset. */
  enable?: boolean;
}

export type Item =
  /** A wire with `undriven` set is intentionally never assigned. */
  | { k: 'decl'; type: 'wire' | 'reg'; sig: Sig; undriven?: boolean; /** `reg [3:0] r = 4'd5;`: a constant power-on value (a reg only). */ init?: Expr }
  | { k: 'assign'; lhs: string; rhs: Expr }
  /** `wire <name> = clk & <en>;` (or the declaration plus a separate assign), only ever in the top module. */
  | { k: 'gate'; name: string; en: string; inline: boolean }
  | { k: 'inst'; module: string; name: string; conns: Array<{ port: string; expr: Expr | null }> }
  /**
   * `always @(posedge clock)`. With `reset` set the body sits under `if (rst)`, and a reg missing
   * from `resets` is unreset. Without it the block has no reset at all.
   */
  | { k: 'always'; clock: string; reset: boolean; resets: Stmt[]; body: Stmt[] };

export interface Module {
  name: string;
  ports: Port[];
  items: Item[];
}

/** Modules in definition order; every module only instantiates earlier ones. The last is the top. */
export interface Program {
  modules: Module[];
}

export const TOP = 'top';
export const CLOCK = 'clk';
export const RESET = 'rst';

export function exprRefs(e: Expr, into: Set<string> = new Set()): Set<string> {
  switch (e.k) {
    case 'ref':
    case 'bit':
    case 'part':
      into.add(e.name);
      break;
    case 'cat':
      for (const p of e.parts) exprRefs(p, into);
      break;
    case 'not':
    case 'paren':
      exprRefs(e.e, into);
      break;
    case 'bin':
      exprRefs(e.l, into);
      exprRefs(e.r, into);
      break;
    case 'cond':
      exprRefs(e.c, into);
      exprRefs(e.t, into);
      exprRefs(e.f, into);
      break;
    case 'lit':
      break;
  }
  return into;
}

export function exprSize(e: Expr): number {
  switch (e.k) {
    case 'cat':
      return 1 + e.parts.reduce((n, p) => n + exprSize(p), 0);
    case 'not':
    case 'paren':
      return 1 + exprSize(e.e);
    case 'bin':
      return 1 + exprSize(e.l) + exprSize(e.r);
    case 'cond':
      return 1 + exprSize(e.c) + exprSize(e.t) + exprSize(e.f);
    default:
      return 1;
  }
}

export function exprDepthOf(e: Expr): number {
  switch (e.k) {
    case 'cat':
      return 1 + Math.max(0, ...e.parts.map(exprDepthOf));
    case 'not':
    case 'paren':
      return 1 + exprDepthOf(e.e);
    case 'bin':
      return 1 + Math.max(exprDepthOf(e.l), exprDepthOf(e.r));
    case 'cond':
      return 1 + Math.max(exprDepthOf(e.c), exprDepthOf(e.t), exprDepthOf(e.f));
    default:
      return 1;
  }
}

/** Every statement, depth first, with the nearest enclosing `if` conditions ignored. */
export function* walkStmts(stmts: Stmt[]): Generator<Stmt> {
  for (const s of stmts) {
    yield s;
    if (s.k === 'if') {
      yield* walkStmts(s.then);
      if (s.else) yield* walkStmts(s.else);
    }
  }
}
