import type * as A from '../ast';
import type { NetId } from '../design';
import type { DiagnosticCode, Span } from '../diagnostics';
import { MAX_DEPTH, caseMatches, isIgnorable, newStore, bitPos } from './consteval';
import * as cv from './cval';
import { lvalueName } from './lint';
import type { Lowerer } from './expr';
import type { Netlist, Word } from './netlist';
import { MAX_WIDTH } from './netlist';
import { type Entry, type FuncEntry, type Mem, Scope, type TaskEntry, type Var } from './scope';
import type { Consts } from './consteval';

/**
 * Procedural code by symbolic execution.
 *
 * A block runs once, at compile time, over symbolic values: every variable has the net (or constant) that holds
 * its value at the current point, and every `if` runs both sides and merges what they assigned with a mux. The
 * result for each variable is the next-state function (for a clocked block), a combinational function (for
 * `@*`), or a latch (when a path leaves it unassigned). Loops with constant bounds unroll; functions and tasks
 * are expanded in place.
 */

export const MAX_UNROLL = 4096;

export interface ProcHost {
  nl: Netlist;
  low: Lowerer;
  consts: Consts;
  scope: Scope;
  fail(code: DiagnosticCode, message: string, span: Span): never;
  warn(code: DiagnosticCode, message: string, span: Span): void;
  outs: ProcOut[];
  ifConditions: { net: NetId; span: Span }[];
  clockUses: { net: NetId; name: string; span: Span }[];
  mention(v: Var): void;
  lintTruncation(lhsWidth: number, rhs: A.Expr, span: Span, target: string): void;
  resolveVar(e: A.Ident | A.HierRef): Var;
}

/** What a block produces for one run of bits of one variable; the cells are built at the end of the module. */
export interface ProcOut {
  v: Var;
  lo: number;
  width: number;
  kind: 'dff' | 'adff' | 'latch' | 'wire';
  d: NetId;
  clk?: NetId;
  edge?: 'pos' | 'neg';
  arst?: NetId;
  arstLevel?: 0 | 1;
  arstValue?: string;
  en?: NetId;
  clocked: boolean;
  span: Span;
}

class St {
  constructor(
    readonly cur = new Map<Var, Word>(),
    readonly next = new Map<Var, Word>(),
    readonly def = new Map<Var, Word>(),
  ) {}
  clone(): St {
    return new St(new Map(this.cur), new Map(this.next), new Map(this.def));
  }
}

type Mode = 'clocked' | 'comb' | 'func';

interface Block {
  mode: Mode;
  st: St;
  path: NetId | undefined;
  touched: Map<Var, bigint>;
  notes: Map<Var, string>;
  netReads: Set<Var>;
  clk?: { net: NetId; edge: 'pos' | 'neg' };
  /** Blocking writes to memories so far: a later read in the same block sees them. */
  shadows: { mem: Mem; addr: NetId; data: NetId; en: NetId }[];
  span: Span;
  /** Statement nesting, for the too-deep limit. */
  depth: number;
}

const allOnes = (bits: string | undefined) => bits !== undefined && /^1+$/.test(bits);

export class Proc {
  private b: Block | undefined;
  private tfDepth = 0;
  private readonly warnedIgnored = new Set<string>();

  constructor(private readonly m: ProcHost) {}

  get active(): boolean {
    return this.b !== undefined;
  }

  private get nl(): Netlist {
    return this.m.nl;
  }

  private line(span: Span) {
    return span.line;
  }

  // ------------------------------------------------------------ variable access

  private baseWord(v: Var): Word {
    return v.isLocal ? this.nl.wconst('x'.repeat(v.width)) : this.nl.wordOf(v.net);
  }

  /** The value of `v` here: the last blocking assignment in this block, or what the signal holds before the block runs. */
  read(v: Var): Word {
    const b = this.b;
    if (b) {
      const c = b.st.cur.get(v);
      if (c) {
        const d = b.mode === 'comb' ? b.st.def.get(v) : undefined;
        if (!d || allOnes(this.nl.wconstBits(d))) return c;
        const q = this.baseWord(v);
        if (!v.isLocal) {
          v.netRead = true;
          b.netReads.add(v);
        }
        return this.nl.wbitwise('or', this.nl.wbitwise('and', c, d), this.nl.wbitwise('and', q, this.nl.wnot(d)));
      }
    }
    if (v.isLocal) return this.baseWord(v);
    v.netRead = true;
    b?.netReads.add(v);
    return this.nl.wordOf(v.net);
  }

  /** A memory word read in a block that has already written the memory with `=`: the block's own write wins. */
  shadowRead(mem: Mem, addr: NetId, data: Word): Word {
    const b = this.b;
    if (!b || b.shadows.length === 0) return data;
    const nl = this.nl;
    let out = data;
    for (const sh of b.shadows) {
      if (sh.mem !== mem) continue;
      const w = Math.max(nl.width(sh.addr), nl.width(addr));
      const same = nl.compare('eq', nl.zeroExtend(sh.addr, w), nl.zeroExtend(addr, w));
      out = nl.wmux(nl.bitwise('and', sh.en, same), out, nl.wordOf(sh.data));
    }
    return out;
  }

  // ------------------------------------------------------------ writing

  private zeros(w: number): Word {
    return this.nl.wconst('0'.repeat(w));
  }

  private splice(old: Word, lo: number, width: number, val: Word): Word {
    if (lo === 0 && width === old.w) return val;
    const parts: Word[] = [];
    if (lo + width < old.w) parts.push(this.nl.wslice(old, lo + width, old.w - lo - width));
    parts.push(val);
    if (lo > 0) parts.push(this.nl.wslice(old, 0, lo));
    return this.nl.wconcat(parts);
  }

  private assignBits(v: Var, lo: number, width: number, val: Word, blocking: boolean) {
    const b = this.b!;
    if (blocking) v.blockingWrites++;
    else v.nonblockingWrites++;
    const effBlocking = blocking || b.mode !== 'clocked' || v.isLocal;
    const mask = ((1n << BigInt(width)) - 1n) << BigInt(lo);
    b.touched.set(v, (b.touched.get(v) ?? 0n) | mask);
    const v1 = val.w === width ? val : this.nl.wresize(val, width, false);
    if (effBlocking) {
      const old = b.st.cur.get(v) ?? this.baseWord(v);
      const nw = this.splice(old, lo, width, v1);
      b.st.cur.set(v, nw);
      b.st.next.set(v, nw);
      if (b.mode === 'comb') {
        const d = b.st.def.get(v) ?? this.zeros(v.width);
        b.st.def.set(v, this.splice(d, lo, width, this.nl.wconst('1'.repeat(width))));
      }
    } else {
      const old = b.st.next.get(v) ?? this.baseWord(v);
      b.st.next.set(v, this.splice(old, lo, width, v1));
    }
  }

  // ------------------------------------------------------------ targets

  private targetVar(e: A.Ident | A.HierRef): Var {
    return this.m.resolveVar(e);
  }

  private checkAssignable(v: Var, span: Span) {
    if (v.isLocal) return;
    if (v.port === 'input') this.m.fail('bad-assignment', `'${v.name}' is an input, so the module cannot drive it.`, span);
    if (!v.isVariable) this.m.fail('bad-assignment', `'${v.name}' is a wire, so an always block cannot assign it. Declare it as 'reg' or use 'assign'.`, span);
  }

  /** Assign `val` (exactly as wide as the target) to `lhs`. */
  private assignLvalue(lhs: A.Expr, val: Word, blocking: boolean, span: Span) {
    const consts = this.m.consts;
    const scope = this.m.scope;
    if (lhs.kind === 'concat') {
      let hi = val.w;
      for (const p of lhs.parts) {
        const w = consts.lvalueWidth(p, scope);
        hi -= w;
        this.assignLvalue(p, this.nl.wslice(val, hi, w), blocking, span);
      }
      return;
    }
    if (lhs.kind === 'ident' || lhs.kind === 'hier') {
      const v = this.targetVar(lhs);
      if (v.mem) this.m.fail('bad-assignment', `'${v.name}' is a memory, so assign one word of it, like ${v.name}[0] <= x.`, lhs.span);
      this.checkAssignable(v, lhs.span);
      this.assignBits(v, 0, v.width, val, blocking);
      return;
    }
    if (lhs.kind !== 'index') return this.m.fail('bad-assignment', 'This cannot be assigned to.', lhs.span);
    const v = this.targetVar(lhs.base);
    this.checkAssignable(v, lhs.base.span);
    const b = this.b!;
    if (v.mem) return this.assignMemory(v, lhs, val, blocking);
    if (v.scalar && !v.isLocal) this.m.fail('bad-select', `'${v.name}' is a scalar, declared without a range, so it has no bits to select. Declare it as '[0:0]' to select its bit.`, lhs.span);
    const asc = v.msb < v.lsb;
    const wsel = consts.selectWidth(lhs, scope);
    if (lhs.mode === 'range') {
      const hi = consts.evalInt(lhs.hi, scope, 'A part-select bound');
      const lo = consts.evalInt(lhs.lo!, scope, 'A part-select bound');
      if (asc ? hi > lo : hi < lo) this.m.fail('bad-select', `The part-select [${hi}:${lo}] of '${v.name}' must list the bits in the order the signal is declared, like [${asc ? lo : hi}:${asc ? hi : lo}].`, lhs.span);
      const pHi = bitPos(v, hi);
      const pLo = bitPos(v, lo);
      if (pHi === undefined || pLo === undefined) this.m.fail('bad-select', `Bit ${pHi === undefined ? hi : lo} is outside '${v.name}', which has bits ${v.msb} down to ${v.lsb}.`, lhs.span);
      this.assignBits(v, Math.min(pHi, pLo), wsel, val, blocking);
      return;
    }
    const idxExpr = lhs.hi;
    const idx = this.m.low.lowerSelf(idxExpr);
    const k = this.m.low.constInt(idx);
    if (k !== undefined) {
      const signed = this.m.consts.typeOf(idxExpr, scope).s;
      const kv = signed && this.nl.wconstBits(idx)![0] === '1' ? k - (1n << BigInt(idx.w)) : k;
      const ki = Number(kv);
      const low = lhs.mode === 'bit' ? ki : lhs.mode === 'plus' ? (asc ? ki + wsel - 1 : ki) : asc ? ki : ki - wsel + 1;
      const p = asc ? v.lsb - low : low - v.lsb;
      if (p < 0 || p + wsel > v.width) {
        if (consts.isConst(idxExpr, scope)) this.m.fail('bad-select', `${lhs.mode === 'bit' ? `Bit ${ki}` : `The part-select starting at ${ki}`} is outside '${v.name}', which has bits ${v.msb} down to ${v.lsb}.`, lhs.span);
        return;
      }
      this.assignBits(v, p, wsel, val, blocking);
      return;
    }
    if (idx.c.length > 1) this.m.fail('width-limit', 'A select index wider than 32 bits is not supported.', lhs.span);
    const nl = this.nl;
    const idxSigned = this.m.consts.typeOf(idxExpr, scope).s;
    const p0 = this.m.low.selectPosition(v, idx, idxSigned, wsel, lhs.mode);
    const old = b.st.cur.get(v) ?? this.baseWord(v);
    const bits: Word[] = [];
    for (let pos = v.width - 1; pos >= 0; pos--) {
      let bit = nl.wslice(old, pos, 1);
      for (let j = 0; j < wsel && j <= pos; j++) {
        const hit = nl.compare('eq', p0, nl.constant((BigInt(pos - j) & 0xffffffffn).toString(2).padStart(32, '0')));
        bit = nl.wmux(hit, bit, nl.wslice(val, j, 1));
      }
      bits.push(bit);
    }
    this.assignBits(v, 0, v.width, nl.wconcat(bits), blocking);
  }

  private assignMemory(v: Var, lhs: A.IndexExpr, val: Word, blocking: boolean) {
    const b = this.b!;
    const mem = v.mem!;
    if (lhs.dims.length > 1) this.m.fail('not-supported', 'Arrays with more than one dimension are not supported yet.', lhs.span);
    if (lhs.dims.length === 1 && !(lhs.mode === 'bit' && false)) this.m.fail('not-supported', 'Assigning to part of a memory word is not supported yet. Assign the whole word.', lhs.span);
    if (b.mode !== 'clocked' || !b.clk) this.m.fail('not-supported', `Writing the memory '${v.name}' outside a clocked block is not supported yet: a memory word is written on a clock edge.`, lhs.span);
    v.nonblockingWrites++;
    const idxExpr = lhs.hi;
    const addr = this.m.low.lowerSelf(idxExpr);
    const signed = this.m.consts.typeOf(idxExpr, this.m.scope).s;
    const a = this.memAddress(v, addr, signed);
    const data = this.nl.wresize(val, mem.width, false);
    const en = b.path ?? this.nl.constant('1');
    mem.writePorts.push({ addr: a, data: data.c[0]!, en, clk: b.clk.net, edge: b.clk.edge });
    if (blocking) b.shadows.push({ mem, addr: a, data: data.c[0]!, en });
  }

  /** The address net of word `idx`: the index with the memory's lowest address taken off. */
  memAddress(v: Var, addr: Word, signed: boolean): NetId {
    const nl = this.nl;
    if (addr.c.length > 1) this.m.fail('width-limit', 'A memory index wider than 32 bits is not supported.', v.span);
    const a = addr.c[0]!;
    const base = v.mem!.base;
    if (base === 0) return signed ? nl.signExtend(a, Math.max(addr.w, 32)) : a;
    const a32 = signed ? nl.signExtend(a, 32) : nl.zeroExtend(a, 32);
    return nl.arith('sub', a32, nl.constant((BigInt(base) & 0xffffffffn).toString(2).padStart(32, '0')));
  }

  // ------------------------------------------------------------ always blocks

  private freshBlock(mode: Mode, clk: Block['clk'], span: Span): Block {
    return { mode, st: new St(), path: undefined, touched: new Map(), notes: new Map(), netReads: new Set(), clk, shadows: [], span, depth: 0 };
  }

  private within<T>(blk: Block, f: () => T): T {
    const saved = this.b;
    this.b = blk;
    try {
      return f();
    } finally {
      this.b = saved;
    }
  }

  always(a: A.AlwaysBlock) {
    if (a.events === undefined) this.testbench("An 'always' block without an event list such as @(posedge clk) or @*", a.span);
    if (a.events === 'star') return this.comb(a, undefined);
    const edges = a.events.filter((t) => t.edge !== 'level');
    if (edges.length > 0 && edges.length < a.events.length) {
      this.m.fail('bad-clock', "An always block cannot mix edge events (posedge/negedge) with plain signals in its event list. Use only edges for a register, or only levels (or @*) for combinational logic.", a.span);
    }
    if (edges.length === 0) return this.comb(a, a.events);
    if (edges.length === 1) return this.clocked(a, edges[0]!);
    return this.asyncReset(a, edges);
  }

  private clockOf(term: A.EventTerm): { net: NetId; edge: 'pos' | 'neg' } {
    const e = term.expr;
    if (e.kind !== 'ident' && e.kind !== 'hier' && e.kind !== 'index') this.m.fail('bad-clock', "The clock in '@(posedge ...)' must be a signal name or one bit of a signal.", e.span);
    const w = this.m.low.lowerSelf(e);
    const name = e.kind === 'ident' ? e.name : e.kind === 'hier' ? e.name : e.base.name;
    if (w.w !== 1) this.m.fail('bad-clock', `The clock '${name}' must be 1 bit wide, but it is ${w.w} bits.`, e.span);
    this.m.clockUses.push({ net: w.c[0]!, name, span: e.span });
    return { net: w.c[0]!, edge: term.edge === 'neg' ? 'neg' : 'pos' };
  }

  private clocked(a: A.AlwaysBlock, term: A.EventTerm) {
    const clk = this.clockOf(term);
    const blk = this.freshBlock('clocked', clk, a.span);
    this.within(blk, () => this.exec(a.body));
    this.finishClocked(blk, clk, a.span);
  }

  private comb(a: A.AlwaysBlock, terms: A.EventTerm[] | undefined) {
    const blk = this.freshBlock('comb', undefined, a.span);
    this.within(blk, () => this.exec(a.body));
    this.finishComb(blk, a.span);
    if (!terms) return;
    const listed = new Set<Var>();
    for (const t of terms) {
      const base = t.expr.kind === 'index' ? t.expr.base : t.expr;
      if (base.kind === 'ident' || base.kind === 'hier') {
        const x = this.m.consts.resolve(base, this.m.scope);
        if (x?.kind === 'var') listed.add(x);
      }
    }
    const missing = [...blk.netReads].filter((v) => !listed.has(v) && !blk.touched.has(v)).map((v) => `'${v.name}'`);
    if (missing.length > 0) {
      this.m.warn('incomplete-sensitivity', `This always block reads ${missing.join(', ')} but its sensitivity list does not include ${missing.length === 1 ? 'it' : 'them'}. A simulator only re-runs the block when a listed signal changes, while hardware (and this circuit) follows every input, so simulation and hardware will differ. Use @* to list every signal the block reads.`, a.span);
    }
  }

  // ------------------------------------------------------------ asynchronous reset or set

  private sameRef(a: A.Expr, b: A.Expr): boolean {
    if (a.kind === 'ident' && b.kind === 'ident') return a.name === b.name;
    if (a.kind === 'hier' && b.kind === 'hier') return a.name === b.name;
    if (a.kind === 'index' && b.kind === 'index') return this.sameRef(a.base, b.base) && a.mode === b.mode && this.sameNumber(a.hi, b.hi);
    return false;
  }

  private sameNumber(a: A.Expr, b: A.Expr): boolean {
    return a.kind === 'number' && b.kind === 'number' ? a.text === b.text : a.kind === 'ident' && b.kind === 'ident' && a.name === b.name;
  }

  /** The level (0 or 1) at which `cond` is true for the signal `sig`, or undefined when `cond` is not a test of it. */
  private activeLevel(cond: A.Expr, sig: A.Expr): 0 | 1 | undefined {
    if (this.sameRef(cond, sig)) return 1;
    if (cond.kind === 'unary' && (cond.op === '!' || cond.op === '~')) {
      const r = this.activeLevel(cond.operand, sig);
      return r === undefined ? undefined : r === 1 ? 0 : 1;
    }
    if (cond.kind === 'binary' && (cond.op === '==' || cond.op === '!=')) {
      const [ref, k] = this.sameRef(cond.lhs, sig) ? [cond.lhs, cond.rhs] : this.sameRef(cond.rhs, sig) ? [cond.rhs, cond.lhs] : [undefined, undefined];
      if (!ref || !k || !this.m.consts.isConst(k, this.m.scope)) return undefined;
      const v = this.m.consts.evalSelf(k, this.m.scope);
      if (!cv.known(v)) return undefined;
      const n = cv.bigA(v) & 1n ? 1 : 0;
      return (cond.op === '==' ? n : 1 - n) as 0 | 1;
    }
    return undefined;
  }

  private asyncReset(a: A.AlwaysBlock, edges: A.EventTerm[]) {
    const nl = this.nl;
    if (edges.length > 2) this.m.fail('not-supported', 'More than one asynchronous reset or set on one register is not supported yet.', a.span);
    let body = a.body;
    while (body.kind === 'block' && body.decls.length === 0 && !body.parallel && body.stmts.filter((x) => x.kind !== 'empty').length === 1) body = body.stmts.find((x) => x.kind !== 'empty')!;
    const explain = "An always block with two edge events (an asynchronous reset or set) must be written as 'if (rst) <constants> else <logic>', where the 'if' tests one of the two signals so the compiler can tell which one is the reset.";
    if (body.kind !== 'if') this.m.fail('bad-async-reset', explain, a.span);
    let reset: A.EventTerm | undefined;
    let level: 0 | 1 | undefined;
    for (const t of edges) {
      const l = this.activeLevel(body.cond, t.expr);
      if (l !== undefined) {
        reset = t;
        level = l;
        break;
      }
    }
    if (!reset || level === undefined) this.m.fail('bad-async-reset', explain, body.cond.span);
    const want = reset.edge === 'pos' ? 1 : 0;
    if (level !== want) this.m.fail('bad-async-reset', `The reset is triggered by ${reset.edge === 'pos' ? 'posedge' : 'negedge'}, so the 'if' must test it at ${want === 1 ? 'high' : 'low'} level (${want === 1 ? 'if (rst)' : 'if (!rst_n)'}), but this condition is true at ${level === 1 ? 'high' : 'low'} level.`, body.cond.span);
    const clockTerm = edges.find((t) => t !== reset)!;
    const clk = this.clockOf(clockTerm);
    const rstW = this.m.low.lowerSelf(reset.expr);
    if (rstW.w !== 1) this.m.fail('bad-clock', `The reset must be 1 bit wide, but it is ${rstW.w} bits.`, reset.expr.span);
    const arst = rstW.c[0]!;
    this.m.clockUses.push({ net: arst, name: 'reset', span: reset.expr.span });
    this.m.clockUses.pop();

    const rblk = this.freshBlock('clocked', clk, a.span);
    this.within(rblk, () => this.exec(body.then));
    const resetVals = new Map<Var, { mask: bigint; bits: string }>();
    for (const [v, mask] of rblk.touched) {
      if (v.isLocal) continue;
      const next = rblk.st.next.get(v)!;
      const bits = nl.wconstBits(next);
      if (bits === undefined || /[xz]/.test(bits)) {
        this.m.fail('bad-async-reset', `The asynchronous reset branch must assign constants, but it assigns a value that depends on a signal to '${v.name}'. A register's reset value is fixed, so write a number or parameter here (put any logic in the 'else' branch).`, body.then.span);
      }
      resetVals.set(v, { mask, bits });
    }
    const eblk = this.freshBlock('clocked', clk, a.span);
    if (body.else) this.within(eblk, () => this.exec(body.else!));
    const vars = new Set<Var>([...resetVals.keys(), ...[...eblk.touched.keys()].filter((v) => !v.isLocal)]);
    for (const v of vars) {
      const rm = resetVals.get(v)?.mask ?? 0n;
      const em = eblk.touched.get(v) ?? 0n;
      const dWord = eblk.st.next.get(v) ?? this.baseWord(v);
      for (const [lo, width] of this.runs(rm | em)) {
        const full = ((1n << BigInt(width)) - 1n) << BigInt(lo);
        const inReset = (rm & full) === full;
        const partly = (rm & full) !== 0n && !inReset;
        if (partly) this.m.fail('bad-async-reset', `The reset branch assigns only some of the bits of '${v.name}' that the 'else' branch assigns. Reset all of them or none.`, body.then.span);
        const d = this.slice1(dWord, lo, width);
        if (inReset) {
          const bits = resetVals.get(v)!.bits;
          const arstValue = bits.slice(bits.length - lo - width, bits.length - lo);
          this.m.outs.push({ v, lo, width, kind: 'adff', d, clk: clk.net, edge: clk.edge, arst, arstLevel: level, arstValue, clocked: true, span: a.span });
        } else {
          const active = level === 1 ? arst : nl.not(arst);
          const held = this.slice1(this.baseWord(v), lo, width);
          this.m.outs.push({ v, lo, width, kind: 'dff', d: nl.mux(active, d, held), clk: clk.net, edge: clk.edge, clocked: true, span: a.span });
        }
      }
    }
  }

  // ------------------------------------------------------------ results

  /** Runs of set bits in a mask, as [lo, width]. */
  private runs(mask: bigint): [number, number][] {
    const out: [number, number][] = [];
    let i = 0;
    while (mask >> BigInt(i) > 0n) {
      if ((mask >> BigInt(i)) & 1n) {
        let j = i;
        while ((mask >> BigInt(j)) & 1n) j++;
        out.push([i, j - i]);
        i = j;
      } else i++;
    }
    return out;
  }

  /** The combinational and latch results of a comb block, or the plain next-state values of a clocked one. */
  private collect(blk: Block): Map<Var, { runs: [number, number][]; next: Word; def?: Word }> {
    const out = new Map<Var, { runs: [number, number][]; next: Word; def?: Word }>();
    for (const [v, mask] of blk.touched) {
      if (v.isLocal) continue;
      const next = blk.st.next.get(v);
      if (!next) continue;
      out.set(v, { runs: this.runs(mask), next, def: blk.st.def.get(v) });
    }
    return out;
  }

  /** A clocked block's registers: one `dff` per run of bits assigned. */
  finishClocked(blk: Block, clk: { net: NetId; edge: 'pos' | 'neg' }, span: Span) {
    for (const [v, r] of this.collect(blk)) {
      for (const [lo, width] of r.runs) {
        this.m.outs.push({ v, lo, width, kind: 'dff', d: this.slice1(r.next, lo, width), clk: clk.net, edge: clk.edge, clocked: true, span });
      }
    }
  }

  private slice1(w: Word, lo: number, width: number): NetId {
    const s = this.nl.wslice(w, lo, width);
    return s.c[0]!;
  }

  /** A combinational block: plain wires where every path assigns, latches where one does not. */
  finishComb(blk: Block, span: Span) {
    const nl = this.nl;
    for (const [v, r] of this.collect(blk)) {
      for (const [lo, width] of r.runs) {
        const d = this.slice1(r.next, lo, width);
        const defBits = r.def ? nl.wslice(r.def, lo, width) : undefined;
        const bits = defBits ? nl.wconstBits(defBits) : undefined;
        if (!defBits || allOnes(bits)) {
          this.m.outs.push({ v, lo, width, kind: 'wire', d, clocked: false, span });
          continue;
        }
        const note = blk.notes.get(v);
        this.m.warn('latch-inferred', `A latch is inferred for '${v.name}' because it is not assigned ${note ?? 'on every path through the block'}. Give it a value on every path (for example a default at the top of the block) to get plain logic instead of a latch.`, span);
        const groups = new Map<NetId, number[]>();
        const dbits = defBits.c.length === 1 ? undefined : defBits;
        for (let k = 0; k < width; k++) {
          const en = (dbits ? undefined : nl.slice(defBits.c[0]!, k, 1)) ?? nl.slice(defBits.c[1]!, k - MAX_WIDTH, 1);
          const g = groups.get(en);
          if (g) g.push(k);
          else groups.set(en, [k]);
        }
        for (const [en, ks] of groups) {
          if (nl.constBits(en) === '0') continue;
          const sub = nl.wconcat([...ks].reverse().map((k) => nl.wslice(this.nl.wordOf(d), k, 1)));
          this.m.outs.push({ v, lo: lo + ks[0]!, width: ks.length, kind: 'latch', d: sub.c[0]!, en, clocked: false, span: span });
          if (ks.length !== ks[ks.length - 1]! - ks[0]! + 1) this.m.fail('not-supported', `A latch on non-adjacent bits of '${v.name}' is not supported yet.`, span);
        }
      }
    }
  }

  // ------------------------------------------------------------ statements

  exec(s: A.Stmt): void {
    const b = this.b!;
    if (b.depth >= MAX_DEPTH) this.m.fail('too-deep', `This block is nested more than ${MAX_DEPTH} levels deep, which the compiler does not support. Split it into smaller parts.`, s.span);
    b.depth++;
    try {
      this.execNode(s);
    } finally {
      b.depth--;
    }
  }

  private testbench(what: string, span: Span): never {
    return this.m.fail('not-synthesizable', `${what} is not synthesizable; a testbench feature (coming with the simulator).`, span);
  }

  private ignored(what: string, span: Span) {
    const key = `${span.start}:${what}`;
    if (this.warnedIgnored.has(key)) return;
    this.warnedIgnored.add(key);
    this.m.warn('ignored', `${what} has no effect in hardware, so it is ignored.`, span);
  }

  private execNode(s: A.Stmt): void {
    const b = this.b!;
    switch (s.kind) {
      case 'empty':
        return;
      case 'block': {
        if (s.parallel) this.testbench("A 'fork' block", s.span);
        const saved = this.m.scope;
        if (s.decls.length > 0 || s.name) {
          const prefix = s.name ? `${saved.prefix}${s.name.name}.` : saved.prefix;
          const inner = new Scope('block', prefix, saved);
          if (s.name) {
            saved.children.set(s.name.name, inner);
            saved.syms.set(s.name.name, { kind: 'scope', scope: inner });
          }
          this.m.scope = inner;
          const store = newStore();
          this.m.consts.execBlockDecls(inner, s.decls, store);
          this.adoptLocals(store);
        }
        try {
          for (const st of s.stmts) this.exec(st);
        } finally {
          this.m.scope = saved;
        }
        return;
      }
      case 'assign': {
        if (s.control) {
          if (s.control.kind === 'delay') this.ignored('A delay in an assignment', s.control.span);
          else this.testbench('An event control in an assignment', s.control.span);
        }
        const lw = this.m.consts.lvalueWidth(s.lhs, this.m.scope);
        const val = this.m.low.assigned(s.rhs, lw);
        this.m.lintTruncation(lw, s.rhs, s.span, lvalueName(s.lhs));
        this.assignLvalue(s.lhs, val, s.blocking, s.span);
        return;
      }
      case 'if': {
        const sel = this.m.low.cond(s.cond);
        const known = this.nl.constBits(sel);
        if (known === '1') return this.exec(s.then);
        if (known === '0') return s.else ? this.exec(s.else) : undefined;
        this.m.ifConditions.push({ net: sel, span: s.cond.span });
        const entry = b.st;
        const path = b.path;
        const andPath = (n: NetId) => (path === undefined ? n : this.nl.bitwise('and', path, n));
        b.st = entry.clone();
        b.path = andPath(sel);
        this.exec(s.then);
        const t = b.st;
        b.st = entry.clone();
        b.path = andPath(this.nl.not(sel));
        if (s.else) this.exec(s.else);
        const f = b.st;
        b.path = path;
        const line = this.line(s.span);
        b.st = this.merge(sel, f, t, `the 'if' on line ${line} has no 'else' branch and its condition is false`, s.else ? `the 'if' branch on line ${line} does not assign it` : `the 'if' on line ${line} does not assign it`, s.else ? `the 'else' branch of the 'if' on line ${line} does not assign it` : `the 'if' on line ${line} has no 'else' branch, so it is not assigned when the condition is false`);
        return;
      }
      case 'case':
        return this.execCase(s);
      case 'for': {
        this.markLoopVar(s.init.lhs);
        this.markLoopVar(s.step.lhs);
        this.execLoopAssign(s.init, s.span);
        this.loop(s.span, () => this.constCond(s.cond, s.span), () => {
          this.exec(s.body);
          this.execLoopAssign(s.step, s.span);
        });
        return;
      }
      case 'while':
        return this.loop(s.span, () => this.constCond(s.cond, s.span), () => this.exec(s.body));
      case 'repeat': {
        const n = this.m.consts.isConst(s.count, this.m.scope)
          ? this.m.consts.evalInt(s.count, this.m.scope, 'A repeat count')
          : this.dynamicCount(s.count);
        if (n > MAX_UNROLL) this.m.fail('bad-loop', `This 'repeat' loop would unroll ${n} times, more than the limit of ${MAX_UNROLL}.`, s.span);
        for (let i = 0; i < n; i++) this.exec(s.body);
        return;
      }
      case 'forever':
        return this.testbench("A 'forever' loop", s.span);
      case 'wait':
        return this.testbench("A 'wait' statement", s.span);
      case 'disable':
        return this.testbench("A 'disable' statement", s.span);
      case 'trigger':
        return this.testbench('An event trigger', s.span);
      case 'procAssign':
        return this.testbench('A procedural assign, deassign, force or release', s.span);
      case 'timing': {
        if (s.control.kind === 'delay') {
          this.ignored('A delay', s.control.span);
          return this.exec(s.body);
        }
        return this.testbench('An event control inside a block', s.span);
      }
      case 'sysTask':
        if (isIgnorable(s.name)) return this.ignored(`The system task ${s.name}`, s.span);
        return this.testbench(`The system task ${s.name}`, s.span);
      case 'taskCall':
        return this.taskCall(s);
    }
  }

  private dynamicCount(e: A.Expr): number {
    const w = this.m.low.lowerSelf(e);
    const k = this.m.low.constInt(w);
    if (k === undefined) this.m.fail('bad-loop', "The count of this 'repeat' loop is not constant. Loops are unrolled, so the count must be known at compile time.", e.span);
    return Number(k);
  }

  private adoptLocals(store: ReturnType<typeof newStore>) {
    const b = this.b!;
    for (const [v, val] of store.vars) b.st.cur.set(v, this.nl.wconst(cv.toBits(val)));
  }

  private markLoopVar(lhs: A.Expr) {
    if (lhs.kind !== 'ident') return;
    const x = this.m.consts.resolve(lhs, this.m.scope);
    if (x?.kind === 'var') x.scratch = true;
  }

  private execLoopAssign(a: A.LoopAssign, span: Span) {
    const lw = this.m.consts.lvalueWidth(a.lhs, this.m.scope);
    const val = this.m.low.assigned(a.rhs, lw);
    this.assignLvalue(a.lhs, val, true, span);
  }

  private constCond(cond: A.Expr, span: Span): boolean {
    const n = this.m.low.cond(cond);
    const k = this.nl.constBits(n);
    if (k === '1') return true;
    if (k === '0') return false;
    return this.m.fail('bad-loop', 'The condition of this loop is not constant. Loops are unrolled when the design is built, so the bounds must be known at compile time (numbers, parameters, or loop variables).', span);
  }

  private loop(span: Span, cond: () => boolean, body: () => void) {
    let n = 0;
    while (cond()) {
      if (++n > MAX_UNROLL) this.m.fail('bad-loop', `This loop would unroll more than ${MAX_UNROLL} times, which is more than the compiler will build. Reduce the bounds, or use a generate loop.`, span);
      body();
    }
  }

  // ------------------------------------------------------------ branches

  /**
   * The state after `if (sel) t else f`. A variable one side leaves alone keeps what it had; in a combinational
   * block, a side that does not assign it leaves it undefined there, which the end of the block turns into a latch.
   */
  private merge(sel: NetId, f: St, t: St, explainBoth: string, explainThen: string, explainElse: string): St {
    const b = this.b!;
    const out = new St();
    const nl = this.nl;
    const comb = b.mode === 'comb';
    const vars = new Set<Var>([...t.cur.keys(), ...f.cur.keys(), ...t.next.keys(), ...f.next.keys(), ...t.def.keys(), ...f.def.keys()]);
    for (const v of vars) {
      const zero = this.zeros(v.width);
      const tdef = t.def.get(v);
      const fdef = f.def.get(v);
      const isZero = (d: Word | undefined) => d === undefined || /^0+$/.test(nl.wconstBits(d) ?? '');
      const merged = (a: Map<Var, Word>, c: Map<Var, Word>, base: Word, pickDef: boolean) => {
        const tv = a.get(v);
        const fv = c.get(v);
        if (!tv && !fv) return undefined;
        if (pickDef && comb) {
          if (tv && isZero(tdef)) return fv ?? base;
          if (fv && isZero(fdef)) return tv ?? base;
        }
        return nl.wmux(sel, fv ?? base, tv ?? base);
      };
      const base = this.baseWord(v);
      const cur = merged(t.cur, f.cur, base, true);
      if (cur) out.cur.set(v, cur);
      const next = merged(t.next, f.next, base, true);
      if (next) out.next.set(v, next);
      if (tdef || fdef) {
        out.def.set(v, nl.wmux(sel, fdef ?? zero, tdef ?? zero));
        const complete = (d: Word | undefined) => allOnes(nl.wconstBits(d ?? zero));
        if (comb && !b.notes.has(v) && (!complete(tdef) || !complete(fdef))) {
          const missing = !tdef || isZero(tdef) ? explainThen : !fdef || isZero(fdef) ? explainElse : explainBoth;
          b.notes.set(v, `when ${missing}`);
        }
      }
    }
    return out;
  }

  private execCase(s: A.CaseStmt) {
    const b = this.b!;
    const consts = this.m.consts;
    const scope = this.m.scope;
    const low = this.m.low;
    const attrs = new Set((s.attrs ?? []).map((a) => a.name.name));
    const full = attrs.has('full_case');
    const parallel = attrs.has('parallel_case');
    if (full || parallel) {
      this.m.warn('case-attribute', `${[full ? 'full_case' : '', parallel ? 'parallel_case' : ''].filter(Boolean).join(' and ')} on this case statement is honoured: ${full ? 'the last item is the hardware default, ' : ''}${parallel ? 'priority between items is dropped, ' : ''}but a simulator ignores the attribute, so simulation and hardware differ wherever the claim does not hold.`, s.span);
    }
    const ts = [s.expr, ...s.items.flatMap((i) => i.labels ?? [])].map((x) => consts.typeOf(x, scope));
    const w = Math.max(...ts.map((t) => t.w));
    const sg = ts.every((t) => t.s);
    if (w > 64) this.m.fail('width-limit', `This case statement compares ${w} bits, but at most 64 bits are supported.`, s.span);
    const sel = low.lower(s.expr, w, sg, w);
    const nl = this.nl;
    let dflt: A.CaseItem | undefined;
    const items: { item: A.CaseItem; cond: NetId }[] = [];
    for (const it of s.items) {
      if (!it.labels) {
        dflt = it;
        continue;
      }
      const matches = it.labels.map((l) => this.caseMatch(s.flavor, sel, l, w, sg));
      const cond = matches.reduce((a, c) => nl.bitwise('or', a, c));
      items.push({ item: it, cond });
    }
    let defaultItem = dflt;
    let chain = items;
    if (!defaultItem && full && items.length > 0) {
      defaultItem = items[items.length - 1]!.item;
      chain = items.slice(0, -1);
    }
    const entry = b.st;
    const path = b.path;
    const andPath = (n: NetId) => (path === undefined ? n : nl.bitwise('and', path, n));
    // The state in which a body ran, with its path made of its own condition and "no earlier item matched".
    const branches: { cond: NetId; st: St }[] = [];
    let earlier: NetId | undefined;
    for (const { item, cond } of chain) {
      const taken = earlier === undefined ? cond : nl.bitwise('and', nl.not(earlier), cond);
      b.st = entry.clone();
      b.path = andPath(parallel ? cond : taken);
      this.exec(item.body);
      branches.push({ cond, st: b.st });
      earlier = earlier === undefined ? cond : nl.bitwise('or', earlier, cond);
    }
    let acc: St;
    if (defaultItem) {
      b.st = entry.clone();
      b.path = andPath(earlier === undefined ? nl.constant('1') : nl.not(earlier));
      this.exec(defaultItem.body);
      acc = b.st;
    } else acc = entry.clone();
    b.path = path;
    const line = s.span.line;
    for (let i = branches.length - 1; i >= 0; i--) {
      const br = branches[i]!;
      const lineI = chain[i]!.item.span.line;
      acc = this.merge(br.cond, acc, br.st, `no item of the 'case' on line ${line} matches`, `the case item on line ${lineI} does not assign it`, defaultItem ? `the 'default' or a later item of the 'case' on line ${line} does not assign it` : `no item of the 'case' on line ${line} matches and it has no 'default'`);
    }
    b.st = acc;
  }

  /** One bit: does `sel` (at width `w`) match the label, as this kind of case compares. */
  private caseMatch(flavor: 'case' | 'casez' | 'casex', sel: Word, label: A.Expr, w: number, sg: boolean): NetId {
    const nl = this.nl;
    const consts = this.m.consts;
    const scope = this.m.scope;
    if (consts.isConst(label, scope)) {
      const lv = consts.evalCtx(label, scope, w, sg);
      const bits = cv.toBits(lv);
      const wild = (ch: string) => (flavor === 'casex' ? ch === 'x' || ch === 'z' : flavor === 'casez' ? ch === 'z' : false);
      if (flavor === 'case' || flavor === 'casez' || flavor === 'casex') {
        // A label bit that is x (or z in a plain case) can only equal an x that hardware never sees: it never matches.
        const dead = [...bits].some((ch) => (ch === 'x' && flavor !== 'casex') || (ch === 'z' && flavor === 'case'));
        if (dead) {
          this.m.warn('bad-literal' as DiagnosticCode, `This case label has x or z bits that the '${flavor}' statement does not treat as don't-care, so it can never match in hardware.`, label.span);
          return nl.constant('0');
        }
      }
      const care = [...bits].map((ch) => (wild(ch) ? '0' : '1')).join('');
      const keep = bits.split('').map((ch, i) => (care[i] === '1' ? ch : '0')).join('');
      if (/^1+$/.test(care)) return nl.wcompare('eq', sel, nl.wconst(bits));
      if (/^0+$/.test(care)) return nl.constant('1');
      const mask = nl.wconst(care);
      return nl.wcompare('eq', nl.wbitwise('and', sel, mask), nl.wconst(keep));
    }
    const lw = this.m.low.lower(label, w, sg, w);
    return nl.wcompare('eq', sel, lw);
  }

  // ------------------------------------------------------------ functions and tasks

  private tfFrame(decl: A.FunctionDecl | A.TaskDecl, scopeOf: Scope) {
    const fs = new Scope(decl.kind === 'function' ? 'func' : 'task', '', scopeOf);
    return fs;
  }

  /** Expand a call of a user function and return its value (as wide as its declared result). */
  callFunction(f: FuncEntry, e: A.CallExpr): Word {
    const consts = this.m.consts;
    const d = f.decl;
    if (++this.tfDepth > 64) {
      this.tfDepth = 0;
      this.m.fail('too-deep', `The function '${d.name.name}' calls itself more than 64 levels deep. Recursion needs constant arguments so it can be expanded when the design is built.`, e.span);
    }
    const own = this.b === undefined;
    const caller = this.m.scope;
    const saved = this.b;
    if (own) this.b = { mode: 'func', st: new St(), path: undefined, touched: new Map(), notes: new Map(), netReads: new Set(), shadows: [], span: e.span, depth: 0 };
    try {
      const fs = this.tfFrame(d, f.scope);
      const store = newStore();
      const rt = consts.funcReturn(f);
      const ret = this.makeVar(d.name.name, rt.w, rt.s, d.name.span, d.type === 'integer' ? 'integer' : 'reg');
      fs.syms.set(d.name.name, ret);
      store.vars.set(ret, cv.allX(rt.w, rt.s));
      const inputs = consts.declareTfPorts(fs, d, store);
      if (e.args.length !== inputs.length) this.m.fail('bad-declaration', `The function '${d.name.name}' takes ${inputs.length} argument${inputs.length === 1 ? '' : 's'}, but this call gives ${e.args.length}.`, e.span);
      const words = e.args.map((a, i) => {
        const p = inputs[i]!;
        const t = consts.typeOf(a, caller);
        return this.m.low.lower(a, Math.max(t.w, p.width), t.s, p.width);
      });
      this.m.scope = fs;
      consts.execBlockDecls(fs, d.decls.filter((x) => x.kind !== 'portDecl'), store);
      this.adoptLocals(store);
      const b = this.b!;
      inputs.forEach((p, i) => b.st.cur.set(p, words[i]!));
      this.exec(d.body);
      return b.st.cur.get(ret) ?? this.nl.wconst('x'.repeat(rt.w));
    } finally {
      this.m.scope = caller;
      this.b = saved;
      this.tfDepth = Math.max(0, this.tfDepth - 1);
    }
  }

  private makeVar(name: string, w: number, s: boolean, span: Span, type: Var['type']): Var {
    return {
      kind: 'var', name, type, netKind: 'wire', width: w, signed: s, msb: w - 1, lsb: 0, scalar: false, net: -1, isLocal: true, isVariable: true, span,
      mentioned: false, netRead: false, blockingWrites: 0, nonblockingWrites: 0, declInit: false, scratch: false, pulls: [],
    };
  }

  private taskCall(s: A.TaskCallStmt) {
    const consts = this.m.consts;
    const x: Entry | undefined = consts.resolveTask(s.callee, this.m.scope);
    const name = s.callee.name;
    if (!x) this.m.fail('undeclared', `The task '${name}' is not declared.`, s.callee.span);
    if (x.kind !== 'task') this.m.fail('bad-declaration', `'${name}' is not a task.`, s.callee.span);
    const t: TaskEntry = x;
    const d = t.decl;
    if (++this.tfDepth > 64) {
      this.tfDepth = 0;
      this.m.fail('too-deep', `The task '${d.name.name}' calls itself more than 64 levels deep.`, s.span);
    }
    const caller = this.m.scope;
    try {
      const fs = this.tfFrame(d, t.scope);
      const store = newStore();
      const all: { v: Var; dir: string }[] = [];
      const add = (name: A.Ident, dir: string, range: A.RangeSpec | undefined, signed: boolean, type: string | undefined) => {
        all.push({ v: this.declareLocal(fs, name, range, signed, type), dir });
      };
      for (const p of d.ports) add(p.name, p.dir, p.range, p.signed, p.net);
      for (const decl of d.decls) if (decl.kind === 'portDecl') for (const n of decl.names) add(n.name, decl.dir, decl.range, decl.signed, decl.net);
      if (s.args.length !== all.length) this.m.fail('bad-declaration', `The task '${d.name.name}' takes ${all.length} argument${all.length === 1 ? '' : 's'}, but this call gives ${s.args.length}.`, s.span);
      const b = this.b!;
      const words = s.args.map((a, i) => {
        const p = all[i]!;
        if (p.dir === 'output') return undefined;
        const tt = consts.typeOf(a, caller);
        return this.m.low.lower(a, Math.max(tt.w, p.v.width), tt.s, p.v.width);
      });
      this.m.scope = fs;
      consts.execBlockDecls(fs, d.decls.filter((x) => x.kind !== 'portDecl'), store);
      this.adoptLocals(store);
      all.forEach((p, i) => b.st.cur.set(p.v, words[i] ?? this.nl.wconst('x'.repeat(p.v.width))));
      this.exec(d.body);
      const results = all.map((p) => b.st.cur.get(p.v) ?? this.nl.wconst('x'.repeat(p.v.width)));
      this.m.scope = caller;
      all.forEach((p, i) => {
        if (p.dir === 'input') return;
        const lhs = s.args[i]!;
        const lw = consts.lvalueWidth(lhs, caller);
        this.assignLvalue(lhs, this.nl.wresize(results[i]!, lw, false), true, s.span);
      });
    } finally {
      this.m.scope = caller;
      this.tfDepth = Math.max(0, this.tfDepth - 1);
    }
  }

  private declareLocal(fs: Scope, name: A.Ident, range: A.RangeSpec | undefined, signed: boolean, type: string | undefined): Var {
    const store = newStore();
    const dummy: A.TaskDecl = { kind: 'task', automatic: false, name, ports: [{ dir: 'input', net: type as A.NetKind | undefined, signed, range, name, span: name.span }], ansi: true, decls: [], body: { kind: 'empty', span: name.span }, span: name.span };
    const [v] = this.m.consts.declareTfPorts(fs, dummy, store);
    return v!;
  }
}

export type { Block, St };
export { caseMatches };
