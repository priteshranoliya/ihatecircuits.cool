import type { Stimulus, TraceRequest } from '@ihatecircuits/hdl/trace';
import { analyzeModule, type Infos } from './analysis';
import {
  CLOCK,
  RESET,
  TOP,
  exprRefs,
  walkStmts,
  type BinOp,
  type Expr,
  type Item,
  type LitBase,
  type Module,
  type Port,
  type Program,
  type Sig,
  type Stmt,
} from './ast';
import { createRng, type Rng } from './prng';

export * from './ast';

/**
 * Seeded generator for the M1 Verilog subset. Programs are built as a small AST (so the
 * shrinker can edit them) and rendered to text.
 *
 * Validity, loop freedom, single drivers and race freedom hold by construction:
 *  - a combinational item may only read signals defined before it (inputs, regs, earlier
 *    wires, earlier instance outputs), so the assign graph is a DAG;
 *  - every wire and output wire has exactly one assign or instance connection (except wires
 *    declared undriven on purpose), and every reg is assigned in exactly one always block;
 *  - clk is never read as data, only drives always blocks and the derived-clock gates;
 *  - every always block with a reset has a synchronous `if (rst)`, and the stimulus drives
 *    rst = 1 in cycle 0;
 *  - a derived clock is `clk & en` with `en` a top-level input. Its always blocks only
 *    write through nonblocking assignments, so the NBA region keeps them race free against the
 *    `clk` blocks. The stimulus holds `en` at 1 in cycle 0 so gated regs see the reset;
 *  - no `if` condition reads an x-capable signal (unreset reg, undriven wire, anything they
 *    flow into), see analysis.ts. Hardware has no x, so that difference is not a bug;
 *  - a block with no reset has no `if` at all: it runs on the first edge, when every reg is
 *    still x, so any condition there would read x.
 */

/** Each feature widens what the generator reaches. All but `clocks` and `undriven` are on by default. */
export interface Features {
  /** Some regs have no reset assignment and stay x until written. */
  unreset: boolean;
  /** Instance connections with a different width than the port, arithmetic inside a connection, a narrower output wire. */
  widthMismatch: boolean;
  /** `wire g = clk & en;` with `always @(posedge g)`. */
  clocks: boolean;
  /** Widths 17..32, and unsized literals of 33+ bits compared with `==`. */
  wide: boolean;
  /** Expression depth up to 12 and left-associative chains of up to 50 terms. */
  deep: boolean;
  /** Declared wires nothing drives, read by logic. */
  undriven: boolean;
  /** Some regs are declared with a constant power-on value: `reg [3:0] r = 4'd5;`, `output reg q = 1'b1`. */
  init: boolean;
}

export const DEFAULT_FEATURES: Features = { unreset: true, widthMismatch: true, clocks: false, wide: true, deep: true, undriven: false, init: true };

export const FEATURE_NAMES = Object.keys(DEFAULT_FEATURES) as Array<keyof Features>;

export function resolveFeatures(f?: Partial<Features>): Features {
  return { ...DEFAULT_FEATURES, ...Object.fromEntries(Object.entries(f ?? {}).filter(([, v]) => v !== undefined)) };
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/** The CLI spelling of a feature: `width-mismatch`. */
export const featureFlag = (name: keyof Features) => kebab(name);

/** `clocks,undriven,-deep,-width-mismatch`: a bare name turns a feature on, a leading `-` turns it off. */
export function parseFeatureList(text: string): Partial<Features> {
  const out: Partial<Features> = {};
  for (const raw of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const on = !raw.startsWith('-');
    const name = FEATURE_NAMES.find((n) => n === raw.replace(/^-/, '') || kebab(n) === raw.replace(/^-/, ''));
    if (!name) throw new Error(`unknown feature "${raw}", expected one of ${FEATURE_NAMES.map(kebab).join(', ')}`);
    out[name] = on;
  }
  return out;
}

export interface GenOptions {
  /** Scales module count, item counts and expression depth. 1..10, default 3. */
  size?: number;
  /** Stimulus length. Default 12 + 3 * size. */
  cycles?: number;
  features?: Partial<Features>;
}

export interface GeneratedCase {
  seed: number;
  size: number;
  features: Features;
  program: Program;
  source: string;
  top: string;
  clock: string;
  stimulus: Stimulus;
}

// ---------------------------------------------------------------- rendering

const sigRange = (s: Sig) => (s.ranged ? `[${s.width - 1}:0] ` : '');

function litText(width: number | null, base: LitBase, value: number, pad?: number): string {
  let digits = value.toString({ b: 2, d: 10, h: 16, o: 8 }[base]);
  if (pad !== undefined && base !== 'd') digits = digits.padStart(pad, '0');
  if (width === null) return base === 'd' ? digits : `'${base}${digits}`;
  return `${width}'${base}${base === 'b' ? digits.padStart(width, '0') : digits}`;
}

const PREC: Record<BinOp, number> = { '|': 2, '^': 3, '~^': 3, '&': 4, '==': 5, '!=': 5, '+': 6 };
const PREC_NOT = 7;
const PREC_ATOM = 8;

function exprPrec(e: Expr): number {
  switch (e.k) {
    case 'cond':
      return 1;
    case 'bin':
      return PREC[e.op];
    case 'not':
      return PREC_NOT;
    default:
      return PREC_ATOM;
  }
}

/**
 * Prints with the fewest parentheses Verilog precedence allows, plus any explicit `paren` nodes.
 * Binary operators are left associative. A unary operand must be a primary (`~~a` is not grammatical).
 */
export function renderExpr(e: Expr): string {
  const sub = (child: Expr, minPrec: number) => {
    const s = renderExpr(child);
    return exprPrec(child) < minPrec ? `(${s})` : s;
  };
  switch (e.k) {
    case 'ref':
      return e.name;
    case 'bit':
      return `${e.name}[${e.index}]`;
    case 'part':
      return `${e.name}[${e.hi}:${e.lo}]`;
    case 'lit':
      return litText(e.width, e.base, e.value, e.pad);
    case 'cat':
      return `{${e.parts.map((p) => renderExpr(p)).join(', ')}}`;
    case 'not':
      return `~${sub(e.e, PREC_ATOM)}`;
    case 'bin':
      return `${sub(e.l, PREC[e.op])} ${e.op} ${sub(e.r, PREC[e.op] + 1)}`;
    case 'cond':
      return `${sub(e.c, 2)} ? ${sub(e.t, 1)} : ${sub(e.f, 1)}`;
    case 'paren':
      return `(${renderExpr(e.e)})`;
  }
}

function renderStmts(stmts: Stmt[], ind: string, out: string[]): void {
  for (const s of stmts) {
    if (s.k === 'nb') {
      out.push(`${ind}${s.lhs} <= ${renderExpr(s.rhs)};`);
      continue;
    }
    out.push(`${ind}if (${renderExpr(s.cond)}) begin`);
    renderStmts(s.then, ind + '  ', out);
    let tail = s.else;
    while (tail && tail.length === 1 && tail[0]!.k === 'if') {
      const inner = tail[0] as Extract<Stmt, { k: 'if' }>;
      out.push(`${ind}end else if (${renderExpr(inner.cond)}) begin`);
      renderStmts(inner.then, ind + '  ', out);
      tail = inner.else;
    }
    if (tail) {
      out.push(`${ind}end else begin`);
      renderStmts(tail, ind + '  ', out);
    }
    out.push(`${ind}end`);
  }
}

export function renderModule(m: Module): string {
  const out: string[] = [`module ${m.name} (`];
  m.ports.forEach((p, i) => {
    const kw = p.dir === 'in' ? 'input' : p.reg ? 'output reg' : 'output';
    out.push(`  ${kw} ${sigRange(p.sig)}${p.sig.name}${p.init ? ` = ${renderExpr(p.init)}` : ''}${i < m.ports.length - 1 ? ',' : ''}`);
  });
  out.push(');');
  for (const it of m.items) {
    switch (it.k) {
      case 'decl':
        out.push(`  ${it.type} ${sigRange(it.sig)}${it.sig.name}${it.init ? ` = ${renderExpr(it.init)}` : ''};`);
        break;
      case 'assign':
        out.push(`  assign ${it.lhs} = ${renderExpr(it.rhs)};`);
        break;
      case 'gate':
        if (it.inline) out.push(`  wire ${it.name} = ${CLOCK} & ${it.en};`);
        else out.push(`  wire ${it.name};`, `  assign ${it.name} = ${CLOCK} & ${it.en};`);
        break;
      case 'inst':
        out.push(`  ${it.module} ${it.name} (${it.conns.map((c) => `.${c.port}(${c.expr ? renderExpr(c.expr) : ''})`).join(', ')});`);
        break;
      case 'always':
        out.push(`  always @(posedge ${it.clock}) begin`);
        if (it.reset) {
          out.push(`    if (${RESET}) begin`);
          renderStmts(it.resets, '      ', out);
          out.push('    end else begin');
          renderStmts(it.body, '      ', out);
          out.push('    end');
        } else {
          renderStmts(it.body, '    ', out);
        }
        out.push('  end');
        break;
    }
  }
  out.push('endmodule');
  return out.join('\n');
}

export function renderProgram(p: Program): string {
  return p.modules.map(renderModule).join('\n\n') + '\n';
}

export function requestOf(program: Program, stimulus: Stimulus): TraceRequest {
  return { source: renderProgram(program), top: TOP, clock: CLOCK, stimulus };
}

// ---------------------------------------------------------------- expressions

/** Per-feature chances. Each is the probability at the decision point, not overall coverage. */
const P = {
  unresetReg: 0.3,
  dirtyReg: 0.2,
  noResetBlock: 0.5,
  mismatchConn: 0.4,
  narrowOut: 0.35,
  wideWidth: 0.1,
  wideEq: 0.02,
  deepRoot: 0.12,
  chainRoot: 0.08,
  deepConn: 0.1,
  gatedReg: 0.4,
  gatedClk: 0.25,
  undrivenWire: 0.5,
  initReg: 0.35,
} as const;

const DEEP_MAX_DEPTH = 12;
const DEEP_BUDGET = 400;
const CHAIN_MIN = 20;
const CHAIN_MAX = 50;
const MAX_WIDTH = 32;
const WIDE_LIT_MAX_BITS = 48;

interface G {
  e: Expr;
  /** Self-determined width; an unsized literal counts as 32. */
  w: number;
}

interface Ctx {
  rng: Rng;
  avail: Sig[];
  f: Features;
  /** Nodes left before every remaining child becomes a leaf. */
  budget: number;
  /** Spine-shaped recursion: one child per node goes the full depth, the siblings stay shallow. */
  deep: boolean;
}

const BIN_OPS: BinOp[] = ['&', '|', '^', '~^', '+', '==', '!='];

function randWidth(rng: Rng, wide: boolean): number {
  const r = rng.next();
  if (r < 0.25) return 1;
  if (r < 0.75) return rng.int(2, 8);
  if (wide && r > 1 - P.wideWidth) return rng.int(17, MAX_WIDTH);
  return rng.int(9, 16);
}

function randValue(rng: Rng, width: number): number {
  const max = 2 ** width;
  const r = rng.next();
  return r < 0.15 ? 0 : r < 0.25 ? max - 1 : Math.floor(rng.next() * max);
}

function sizedLit(rng: Rng, width: number): G {
  return { e: { k: 'lit', width, base: rng.pick<LitBase>(['b', 'd', 'h', 'o', 'd', 'h']), value: randValue(rng, width) }, w: width };
}

function unsizedLit(rng: Rng): G {
  const value = rng.bool(0.7) ? rng.int(0, 255) : rng.int(0, 65535);
  return { e: { k: 'lit', width: null, base: rng.pick<LitBase>(['d', 'd', 'd', 'h', 'b', 'o']), value }, w: 32 };
}

function selectOf(c: Ctx, width: number | null): G | undefined {
  const pool = c.avail.filter((s) => s.ranged && (width === null || s.width >= width));
  if (pool.length === 0) return undefined;
  const s = c.rng.pick(pool);
  const w = width ?? c.rng.int(1, s.width);
  if (w === 1 && c.rng.bool(0.6)) return { e: { k: 'bit', name: s.name, index: c.rng.int(0, s.width - 1) }, w: 1 };
  const lo = c.rng.int(0, s.width - w);
  return { e: { k: 'part', name: s.name, hi: lo + w - 1, lo }, w };
}

function maybeParen(c: Ctx, g: G): G {
  return c.rng.bool(0.1) ? { e: { k: 'paren', e: g.e }, w: g.w } : g;
}

function binG(op: BinOp, l: G, r: G): G {
  return { e: { k: 'bin', op, l: l.e, r: r.e }, w: op === '==' || op === '!=' ? 1 : Math.max(l.w, r.w) };
}

/** Depths for `n` children of a node at `depth`. In deep mode one random child keeps going. */
function childDepths(c: Ctx, depth: number, n: number): number[] {
  const full = depth - 1;
  if (!c.deep) return Array.from({ length: n }, () => full);
  const spine = c.rng.int(0, n - 1);
  return Array.from({ length: n }, (_, i) => (i === spine ? full : Math.min(full, 2)));
}

function leafFree(c: Ctx, sizedOnly: boolean): G {
  const { rng } = c;
  const r = rng.next();
  if (r < 0.5) {
    const s = rng.pick(c.avail);
    return { e: { k: 'ref', name: s.name }, w: s.width };
  }
  if (r < 0.7) {
    const sel = selectOf(c, null);
    if (sel) return sel;
  }
  return !sizedOnly && rng.bool(0.35) ? unsizedLit(rng) : sizedLit(rng, randWidth(rng, c.f.wide));
}

/**
 * `x == 'h1_0000_0000`-style comparison: an unsized literal of 33..48 bits (by value, or by
 * zero padded digits with a small value, which widens the context so `~x` gains high ones)
 * against either an ordinary expression (never equal, but a truncating compiler would disagree) or a concatenation
 * wide enough to match, whose high part is a literal so equality happens when the low bits agree.
 */
function wideEq(c: Ctx, depth: number): G {
  const { rng } = c;
  const op = rng.pick<BinOp>(['==', '!=']);
  if (rng.bool(0.35)) {
    const base = rng.pick<LitBase>(['h', 'b', 'o']);
    const pad = base === 'h' ? rng.int(9, 12) : base === 'b' ? rng.int(33, WIDE_LIT_MAX_BITS) : rng.int(11, 16);
    const lit: G = { e: { k: 'lit', width: null, base, value: randValue(rng, rng.int(1, 32)), pad }, w: 32 };
    const other = genFree(c, Math.max(0, depth), false);
    return rng.bool(0.5) ? binG(op, lit, other) : binG(op, other, lit);
  }
  const total = rng.int(33, WIDE_LIT_MAX_BITS);
  const loW = rng.int(1, 8);
  const hiW = total - loW;
  const hi = Math.max(1, randValue(rng, hiW));
  const lo = randValue(rng, loW);
  const value = hi * 2 ** loW + lo;
  const lit: G = { e: { k: 'lit', width: null, base: rng.pick<LitBase>(['h', 'h', 'b', 'd', 'o']), value }, w: 32 };
  const other: G = rng.bool(0.5)
    ? genFree(c, Math.max(0, depth), false)
    : { e: { k: 'cat', parts: [{ k: 'lit', width: hiW, base: 'h', value: hi }, genExact(c, loW, 1).e] }, w: total };
  return rng.bool(0.5) ? binG(op, lit, other) : binG(op, other, lit);
}

/** `a + b + c + ...`: a long left-associative chain of one operator over leaves. */
function genChain(c: Ctx, sizedOnly: boolean): G {
  const { rng } = c;
  const op = rng.pick<BinOp>(['+', '+', '+', '^', '|', '&', '~^']);
  let acc = leafFree(c, sizedOnly);
  for (let i = rng.int(CHAIN_MIN, CHAIN_MAX) - 1; i > 0; i--) acc = binG(op, acc, leafFree(c, sizedOnly));
  return acc;
}

/** An expression of mixed widths, so context-determined extension and truncation get exercised. */
function genFree(c: Ctx, depth: number, sizedOnly: boolean): G {
  const { rng } = c;
  c.budget--;
  if (depth <= 0 || c.budget <= 0 || rng.bool(c.deep && depth > 2 ? 0.02 : 0.15)) return leafFree(c, sizedOnly);
  const r = rng.next();
  let g: G;
  if (r < 0.12) {
    const [d] = childDepths(c, depth, 1);
    const x = genFree(c, d!, sizedOnly);
    g = { e: { k: 'not', e: x.e }, w: x.w };
  } else if (r < 0.62) {
    const op = rng.pick(BIN_OPS);
    if (c.f.wide && (op === '==' || op === '!=') && !sizedOnly && rng.bool(P.wideEq)) return maybeParen(c, wideEq(c, depth - 1));
    const [dl, dr] = childDepths(c, depth, 2);
    g = binG(op, genFree(c, dl!, sizedOnly), genFree(c, dr!, sizedOnly));
  } else if (r < 0.8) {
    const [dc, dt, df] = childDepths(c, depth, 3);
    const cond = genFree(c, dc!, sizedOnly);
    const t = genFree(c, dt!, sizedOnly);
    const f = genFree(c, df!, sizedOnly);
    g = { e: { k: 'cond', c: cond.e, t: t.e, f: f.e }, w: Math.max(t.w, f.w) };
  } else {
    const parts: G[] = [];
    let total = 0;
    const n = rng.int(2, 3);
    const ds = childDepths(c, depth, n);
    for (let i = 0; i < n; i++) {
      const p = genFree(c, ds[i]!, true);
      if (total + p.w > MAX_WIDTH) break;
      parts.push(p);
      total += p.w;
    }
    if (parts.length === 0) parts.push(sizedLit(rng, randWidth(rng, c.f.wide)));
    g = { e: { k: 'cat', parts: parts.map((p) => p.e) }, w: parts.reduce((a, p) => a + p.w, 0) };
  }
  return maybeParen(c, g);
}

/** Entry for a data expression: usually shallow, sometimes deep or a long chain. */
function genRoot(c: Ctx, depth: number): G {
  if (c.f.deep) {
    const r = c.rng.next();
    if (r < P.chainRoot) return genChain(c, false);
    if (r < P.chainRoot + P.deepRoot) {
      const deepCtx: Ctx = { ...c, deep: true, budget: DEEP_BUDGET };
      return genFree(deepCtx, c.rng.int(6, DEEP_MAX_DEPTH), false);
    }
  }
  return genFree(c, depth, false);
}

/** An expression whose self-determined width is exactly `w` (for instance port connections). */
function genExact(c: Ctx, w: number, depth: number): G {
  const { rng } = c;
  c.budget--;
  const leaf = (): G => {
    const same = c.avail.filter((s) => s.width === w);
    const choices: Array<() => G | undefined> = [
      () => (same.length ? { e: { k: 'ref', name: rng.pick(same).name }, w } : undefined),
      () => selectOf(c, w),
      () => sizedLit(rng, w),
    ];
    for (const i of rng.shuffle([0, 1, 2, 2])) {
      const g = choices[i]!();
      if (g) return g;
    }
    return sizedLit(rng, w);
  };
  if (depth <= 0 || c.budget <= 0 || rng.bool(0.3)) return leaf();
  const r = rng.next();
  let g: G;
  if (r < 0.15) {
    g = { e: { k: 'not', e: genExact(c, w, depth - 1).e }, w };
  } else if (r < 0.5) {
    const op = rng.pick<BinOp>(['&', '|', '^', '~^', '+']);
    g = binG(op, genExact(c, w, depth - 1), genExact(c, w, depth - 1));
  } else if (r < 0.65) {
    const cond = genFree(c, depth - 1, false);
    g = { e: { k: 'cond', c: cond.e, t: genExact(c, w, depth - 1).e, f: genExact(c, w, depth - 1).e }, w };
  } else if (r < 0.8 && w >= 2) {
    const first = rng.int(1, w - 1);
    const parts = [genExact(c, first, depth - 1).e];
    if (w - first >= 2 && rng.bool(0.4)) {
      const second = rng.int(1, w - first - 1);
      parts.push(genExact(c, second, depth - 1).e, genExact(c, w - first - second, depth - 1).e);
    } else {
      parts.push(genExact(c, w - first, depth - 1).e);
    }
    g = { e: { k: 'cat', parts }, w };
  } else if (w === 1) {
    g = binG(rng.pick<BinOp>(['==', '!=']), genFree(c, depth - 1, false), genFree(c, depth - 1, false));
  } else {
    return leaf();
  }
  return maybeParen(c, g);
}

/**
 * The expression wired to an instance input of width `w`. With widthMismatch it is often not
 * `w` bits: wider (truncated), narrower (zero-extended), a sum of narrower operands into the
 * wider port, or anything at all.
 */
function genConn(c: Ctx, w: number, depth: number): Expr {
  const { rng } = c;
  const d = c.f.deep && rng.bool(P.deepConn) ? 6 : depth;
  if (!c.f.widthMismatch || !rng.bool(P.mismatchConn)) return genExact(c, w, d).e;
  const r = rng.next();
  if (r < 0.3 && w < MAX_WIDTH) return genExact(c, rng.int(w + 1, Math.min(MAX_WIDTH, w + 16)), d).e;
  if (r < 0.55 && w > 1) return genExact(c, rng.int(1, w - 1), d).e;
  if (r < 0.8 && w > 1) {
    const n = rng.int(1, w - 1);
    let acc = genExact(c, n, 1);
    for (let i = rng.int(1, 2); i > 0; i--) acc = binG('+', acc, genExact(c, n, 1));
    return acc.e;
  }
  return genFree(c, d, false).e;
}

// ---------------------------------------------------------------- modules

type RegKind = 'unreset' | 'dirty' | 'clean';

interface ModCtx {
  rng: Rng;
  f: Features;
  avail: Sig[];
  tainted: Set<string>;
  kind: Map<string, RegKind>;
  /** A data context; `clean` restricts it to signals no x-source reaches. */
  mk: (clean: boolean) => Ctx;
}

function genStmts(m: ModCtx, size: number, depth: number, group: Sig[]): Stmt[] {
  const { rng } = m;
  const stmts: Stmt[] = [];
  const left = [...group];
  const rhs = (reg: Sig) => genRoot(m.mk(m.kind.get(reg.name) === 'clean'), exprDepth(size)).e;
  for (let i = rng.int(1, 2 + (size >> 1)); i > 0; i--) {
    if (depth > 0 && (left.length === 0 || rng.bool(0.4))) {
      stmts.push({
        k: 'if',
        cond: genFree(m.mk(true), 1 + (size >> 2), false).e,
        then: genStmts(m, size, depth - 1, group),
        else: rng.bool(0.6) ? genStmts(m, size, depth - 1, group) : null,
      });
    } else if (left.length > 0) {
      const [reg] = left.splice(rng.int(0, left.length - 1), 1);
      stmts.push({ k: 'nb', lhs: reg!.name, rhs: rhs(reg!) });
    }
  }
  if (stmts.length > 0) return stmts;
  const reg = rng.pick(group);
  return [{ k: 'nb', lhs: reg.name, rhs: rhs(reg) }];
}

const exprDepth = (size: number) => Math.min(1 + Math.ceil(size / 2), 5);

/** A constant for a reg's power-on value: sized in any base, or an unsized decimal (which the declaration truncates or zero extends). */
function genInit(rng: Rng, width: number): Expr {
  if (rng.bool(0.2)) return { k: 'lit', width: null, base: 'd', value: rng.int(0, 40) };
  return { k: 'lit', width, base: rng.pick<LitBase>(['b', 'd', 'h']), value: randValue(rng, width) };
}

function genModule(rng: Rng, size: number, name: string, lower: Module[], used: Set<string>, isTop: boolean, f: Features, infos: Infos): Module {
  const mkSig = (n: string, width: number): Sig => ({ name: n, width, ranged: width > 1 || rng.bool(0.4) });
  const ports: Port[] = [
    { sig: { name: CLOCK, width: 1, ranged: false }, dir: 'in', reg: false },
    { sig: { name: RESET, width: 1, ranged: false }, dir: 'in', reg: false },
  ];
  for (let i = rng.int(1, 2 + (size >> 1)); i > 0; i--) ports.push({ sig: mkSig(`i${ports.length - 2}`, randWidth(rng, f.wide)), dir: 'in', reg: false });
  const gates: string[] = [];
  if (f.clocks && isTop) {
    for (let i = rng.int(1, 2); i > 0; i--) {
      ports.push({ sig: { name: `en${gates.length}`, width: 1, ranged: false }, dir: 'in', reg: false, enable: true });
      gates.push(`g${gates.length}`);
    }
  }
  const nIn = ports.length;
  for (let i = rng.int(1, 1 + (size >> 1)); i > 0; i--) {
    ports.push({ sig: mkSig(`o${ports.length - nIn}`, randWidth(rng, f.wide)), dir: 'out', reg: rng.bool(0.4) });
  }

  const items: Item[] = [];
  gates.forEach((g, i) => items.push({ k: 'gate', name: g, en: `en${i}`, inline: rng.bool() }));
  const avail: Sig[] = ports.filter((p) => p.dir === 'in' && p.sig.name !== CLOCK).map((p) => p.sig);
  const regs: Sig[] = ports.filter((p) => p.reg).map((p) => p.sig);
  for (let i = rng.int(0, size); i > 0; i--) {
    const sig = mkSig(`r${i}`, randWidth(rng, f.wide));
    regs.push(sig);
    items.push({ k: 'decl', type: 'reg', sig });
  }
  avail.push(...regs);
  if (f.init) {
    for (const r of regs) {
      if (!rng.bool(P.initReg)) continue;
      const init = genInit(rng, r.width);
      const port = ports.find((p) => p.reg && p.sig === r);
      if (port) port.init = init;
      else (items.find((it) => it.k === 'decl' && it.sig === r) as Extract<Item, { k: 'decl' }>).init = init;
    }
  }

  const tainted = new Set<string>();
  const kind = new Map<string, RegKind>();
  for (const r of regs) {
    const x = f.unreset ? rng.next() : 1;
    const k: RegKind = x < P.unresetReg ? 'unreset' : x < P.unresetReg + P.dirtyReg ? 'dirty' : 'clean';
    kind.set(r.name, k);
    if (k !== 'clean') tainted.add(r.name);
  }
  const mc: ModCtx = {
    rng,
    f,
    avail,
    tainted,
    kind,
    mk: (clean) => ({ rng, f, avail: clean ? avail.filter((s) => !tainted.has(s.name)) : avail, budget: Infinity, deep: false }),
  };
  const taintOf = (e: Expr) => [...exprRefs(e)].some((n) => tainted.has(n));
  const depth = exprDepth(size);

  type Slot = { k: 'out'; sig: Sig } | { k: 'wire' } | { k: 'inst' } | { k: 'undriven' };
  const slots: Slot[] = ports.filter((p) => p.dir === 'out' && !p.reg).map((p) => ({ k: 'out', sig: p.sig }));
  for (let i = rng.int(1, 1 + size); i > 0; i--) slots.push({ k: 'wire' });
  if (f.undriven) for (let i = rng.int(0, 2); i > 0; i--) if (rng.bool(P.undrivenWire)) slots.push({ k: 'undriven' });
  if (lower.length > 0) {
    const unused = lower.filter((m) => !used.has(m.name)).length;
    for (let i = Math.max(rng.int(0, 1 + (size >> 1)), isTop ? unused : 0); i > 0; i--) slots.push({ k: 'inst' });
  }

  let wires = 0;
  let insts = 0;
  for (const slot of rng.shuffle(slots)) {
    if (slot.k === 'out') {
      const rhs = genRoot(mc.mk(false), depth).e;
      items.push({ k: 'assign', lhs: slot.sig.name, rhs });
      if (taintOf(rhs)) tainted.add(slot.sig.name);
      avail.push(slot.sig);
    } else if (slot.k === 'wire') {
      const sig = mkSig(`w${wires++}`, randWidth(rng, f.wide));
      const rhs = genRoot(mc.mk(false), depth).e;
      items.push({ k: 'decl', type: 'wire', sig }, { k: 'assign', lhs: sig.name, rhs });
      if (taintOf(rhs)) tainted.add(sig.name);
      avail.push(sig);
    } else if (slot.k === 'undriven') {
      const sig = mkSig(`w${wires++}`, randWidth(rng, f.wide));
      items.push({ k: 'decl', type: 'wire', sig, undriven: true });
      tainted.add(sig.name);
      avail.push(sig);
    } else {
      const fresh = lower.filter((m) => !used.has(m.name));
      const sub = rng.pick(fresh.length > 0 ? fresh : lower);
      used.add(sub.name);
      const info = infos.get(sub.name)!;
      const conns: Array<{ port: string; expr: Expr | null }> = [];
      const outWires: Array<{ sig: Sig; port: string }> = [];
      const connTainted = new Map<string, boolean>();
      for (const p of sub.ports) {
        if (p.sig.name === CLOCK) conns.push({ port: p.sig.name, expr: { k: 'ref', name: gates.length > 0 && rng.bool(P.gatedClk) ? rng.pick(gates) : CLOCK } });
        else if (p.sig.name === RESET) conns.push({ port: p.sig.name, expr: { k: 'ref', name: RESET } });
        else if (p.dir === 'in') {
          const expr = genConn(mc.mk(info.ifIn.has(p.sig.name)), p.sig.width, Math.min(depth, 3));
          connTainted.set(p.sig.name, taintOf(expr));
          conns.push({ port: p.sig.name, expr });
        } else if (rng.bool(0.15)) conns.push({ port: p.sig.name, expr: null });
        else {
          const narrow = f.widthMismatch && p.sig.width >= 2 && rng.bool(P.narrowOut);
          const w = mkSig(`w${wires++}`, narrow ? rng.int(1, p.sig.width - 1) : p.sig.width);
          items.push({ k: 'decl', type: 'wire', sig: w });
          outWires.push({ sig: w, port: p.sig.name });
          conns.push({ port: p.sig.name, expr: { k: 'ref', name: w.name } });
        }
      }
      items.push({ k: 'inst', module: sub.name, name: `u${insts++}`, conns });
      for (const o of outWires) {
        if (info.xOut.has(o.port) || [...(info.dep.get(o.port) ?? [])].some((i) => connTainted.get(i))) tainted.add(o.sig.name);
        avail.push(o.sig);
      }
    }
  }

  if (regs.length > 0) {
    const domain = new Map<string, string>(regs.map((r) => [r.name, gates.length > 0 && rng.bool(P.gatedReg) ? rng.pick(gates) : CLOCK]));
    for (const clock of [CLOCK, ...gates]) {
      const inDomain = regs.filter((r) => domain.get(r.name) === clock);
      if (inDomain.length === 0) continue;
      const shuffled = rng.shuffle(inDomain);
      const groups: Sig[][] = Array.from({ length: rng.int(1, Math.min(shuffled.length, 3)) }, () => []);
      shuffled.forEach((r, i) => groups[i < groups.length ? i : rng.int(0, groups.length - 1)]!.push(r));
      for (const group of groups) {
        const allUnreset = group.every((r) => kind.get(r.name) === 'unreset');
        const reset = !(allUnreset && rng.bool(P.noResetBlock));
        const body = genStmts(mc, size, reset ? 2 : 0, group);
        const seen = new Set<string>();
        for (const s of walkStmts(body)) if (s.k === 'nb') seen.add(s.lhs);
        for (const r of group) {
          if (!seen.has(r.name)) body.push({ k: 'nb', lhs: r.name, rhs: genRoot(mc.mk(kind.get(r.name) === 'clean'), depth).e });
        }
        const resets: Stmt[] = reset
          ? group.filter((r) => kind.get(r.name) !== 'unreset').map((r) => ({ k: 'nb', lhs: r.name, rhs: sizedLit(rng, r.width).e }))
          : [];
        items.push({ k: 'always', clock, reset, resets, body });
      }
    }
  }
  return { name, ports, items };
}

function genStimulus(rng: Rng, inputs: Port[], cycles: number): Stimulus {
  const stim: Stimulus = [];
  for (let k = 0; k < cycles; k++) {
    const cycle: Record<string, string> = {};
    for (const { sig: s, enable } of inputs) {
      if (s.name === RESET) {
        cycle[s.name] = k === 0 || rng.bool(0.12) ? '1' : '0';
        continue;
      }
      const prev = stim[k - 1]?.[s.name];
      const r = rng.next();
      const max = 2 ** s.width;
      cycle[s.name] =
        enable && k === 0
          ? '1'
          : prev !== undefined && r < 0.2
            ? prev
            : r < 0.3
              ? '0'.repeat(s.width)
              : r < 0.4
                ? '1'.repeat(s.width)
                : Math.floor(rng.next() * max).toString(2).padStart(s.width, '0');
    }
    stim.push(cycle);
  }
  return stim;
}

export function generateCase(seed: number, opts: GenOptions = {}): GeneratedCase {
  const size = Math.max(1, Math.min(10, Math.floor(opts.size ?? 3)));
  const features = resolveFeatures(opts.features);
  const rng = createRng(seed);
  const subCount = size < 2 ? 0 : rng.int(0, Math.min(3, 1 + (size >> 1)));
  const modules: Module[] = [];
  const used = new Set<string>();
  const infos: Infos = new Map();
  for (let i = 0; i <= subCount; i++) {
    const isTop = i === subCount;
    const m = genModule(rng, size, isTop ? TOP : `m${i}`, [...modules], used, isTop, features, infos);
    infos.set(m.name, analyzeModule(m, infos).info);
    modules.push(m);
  }
  const program: Program = { modules };
  const top = modules[modules.length - 1]!;
  const inputs = top.ports.filter((p) => p.dir === 'in' && p.sig.name !== CLOCK);
  const stimulus = genStimulus(rng, inputs, opts.cycles ?? 12 + 3 * size);
  return { seed, size, features, program, source: renderProgram(program), top: TOP, clock: CLOCK, stimulus };
}
