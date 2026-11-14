import type * as A from '../ast';
import type { NetId } from '../design';
import type { DiagnosticCode, Span } from '../diagnostics';
import { type Consts, MAX_DEPTH, NotConstant, type Type, bitPos } from './consteval';
import * as cv from './cval';
import { MAX_WIDTH, MAX_WORD, type Netlist, type Word } from './netlist';
import type { FuncEntry, Scope, Var } from './scope';

/**
 * Expressions to hardware (IEEE 1364-2005 5.4 and 5.5).
 *
 * `lower(e, w, s, need)` is the value of `e` in a context `w` bits wide of signedness `s`, cut to its low `need`
 * bits. For the operators whose low bits depend only on the low bits of their operands (`+ - * & | ^ ~ <<`) the
 * circuit is built `need` bits wide, so `cnt + 1` assigned to 4 bits is a 4-bit adder. Operators that look at
 * high bits (`>> / % <` and friends) are built at the full context width. Anything built from constants alone is
 * evaluated by `Consts` instead, at any width.
 */

export interface ExprHost {
  nl: Netlist;
  consts: Consts;
  scope: Scope;
  fail(code: DiagnosticCode, message: string, span: Span): never;
  warn(code: DiagnosticCode, message: string, span: Span): void;
  /** The current value of a signal or variable, as procedural code sees it. */
  readVar(v: Var, span: Span): Word;
  readMemWord(v: Var, addr: Word, addrSigned: boolean, constAddr: boolean, span: Span): Word;
  callFunction(f: FuncEntry, e: A.CallExpr): Word;
  /** Marks a name as used, for the unused-signal lint. */
  mention(v: Var): void;
}

const CHAIN_OPS = new Set(['&', '|', '^', '~^', '^~', '+', '-', '*']);
const NEED_OK = new Set(['&', '|', '^', '~^', '^~', '+', '-', '*', '<<', '<<<', '**']);
const RELATIONAL = new Set(['<', '<=', '>', '>=', '==', '!=']);

export class Lowerer {
  private depth = 0;

  constructor(private readonly h: ExprHost) {}

  private get nl(): Netlist {
    return this.h.nl;
  }

  private deeper<T>(span: Span, f: () => T): T {
    if (this.depth >= MAX_DEPTH) this.h.fail('too-deep', `This expression is nested more than ${MAX_DEPTH} levels deep, which the compiler does not support. Split it into smaller parts.`, span);
    this.depth++;
    try {
      return f();
    } finally {
      this.depth--;
    }
  }

  private checkWidth(width: number, span: Span, what = 'This expression') {
    if (width > MAX_WORD) this.h.fail('width-limit', `${what} needs ${width} bits, but at most ${MAX_WORD} bits are supported in a comparison or condition (and ${MAX_WIDTH} in a signal).`, span);
  }

  private fullWidth32(width: number, span: Span, op: string) {
    if (width > MAX_WIDTH) this.h.fail('width-limit', `The '${op}' operator is supported up to ${MAX_WIDTH} bits, but this one works on ${width} bits.`, span);
  }

  typeOf(e: A.Expr): Type {
    return this.h.consts.typeOf(e, this.h.scope);
  }

  // ------------------------------------------------------------ entry points

  /** `e` standing alone: its own width and signedness. */
  lowerSelf(e: A.Expr): Word {
    const t = this.typeOf(e);
    return this.lower(e, t.w, t.s, t.w);
  }

  /** The value of `rhs` assigned to a target `width` bits wide. */
  assigned(rhs: A.Expr, width: number): Word {
    const t = this.typeOf(rhs);
    return this.lower(rhs, Math.max(t.w, width), t.s, width);
  }

  /** A condition as one bit: 1 when any bit of the self-determined expression is 1. */
  cond(e: A.Expr): NetId {
    const t = this.typeOf(e);
    this.checkWidth(t.w, e.span, 'This condition');
    const v = this.lower(e, t.w, t.s, t.w);
    return this.truth(v);
  }

  truth(v: Word): NetId {
    return v.w === 1 ? v.c[0]! : this.nl.wreduce('reduce_or', v);
  }

  /** Constant integer value of a word whose bits are all known, when it is one. */
  constInt(v: Word): bigint | undefined {
    const bits = this.nl.wconstBits(v);
    if (bits === undefined || /[xz]/.test(bits)) return undefined;
    return BigInt('0b' + bits);
  }

  // ------------------------------------------------------------ lowering

  lower(e: A.Expr, w: number, s: boolean, need: number): Word {
    return this.deeper(e.span, () => this.lowerNode(e, w, s, need));
  }

  private ext(v: Word, need: number, s: boolean): Word {
    return this.nl.wresize(v, need, s);
  }

  private bit(n: NetId, need: number): Word {
    return this.ext({ w: 1, c: [n] }, need, false);
  }

  private lowerNode(e: A.Expr, w: number, s: boolean, need: number): Word {
    this.checkWidth(need, e.span);
    const consts = this.h.consts;
    const scope = this.h.scope;
    if (consts.isConst(e, scope)) {
      const v = consts.evalCtx(e, scope, w, s);
      return this.nl.wconst(cv.toBits(cv.slice(v, 0, need)));
    }
    switch (e.kind) {
      case 'number':
      case 'real':
      case 'string':
        return this.nl.wconst(cv.toBits(cv.slice(consts.evalCtx(e, scope, w, s), 0, need)));
      case 'ident':
      case 'hier': {
        const x = consts.resolve(e, scope);
        if (x?.kind === 'var') {
          if (x.mem) this.h.fail('bad-select', `'${x.name}' is a memory, so it needs an index, like ${x.name}[0].`, e.span);
          this.h.mention(x);
          return this.ext(this.h.readVar(x, e.span), need, s);
        }
        if (x?.kind === 'genvar') this.h.fail('not-constant', `The genvar '${e.name}' can only be used inside the generate loop that defines it.`, e.span);
        return this.h.consts.diag.undeclared(e.name, e.span);
      }
      case 'index':
        return this.ext(this.lowerIndex(e), need, false);
      case 'concat':
        return this.lowerConcat(e, need);
      case 'replicate': {
        const n = consts.evalInt(e.count, scope, 'A replication count');
        if (n < 0) this.h.fail('bad-width', 'A replication count cannot be negative.', e.count.span);
        const inner = this.lowerSelf(e.inner);
        const total = n * inner.w;
        this.checkWidth(Math.min(total, need + inner.w), e.span);
        const used = Math.min(n, Math.ceil(need / inner.w));
        const parts = Array.from({ length: used }, () => inner);
        return this.ext(this.nl.wconcat(parts), need, false);
      }
      case 'unary':
        return this.lowerUnary(e, w, s, need);
      case 'binary':
        return this.lowerBinary(e, w, s, need);
      case 'ternary': {
        const sel = this.cond(e.cond);
        const known = this.nl.constBits(sel);
        if (known === '1') return this.lower(e.then, w, s, need);
        if (known === '0') return this.lower(e.else, w, s, need);
        const t = this.lower(e.then, w, s, need);
        const f = this.lower(e.else, w, s, need);
        return this.nl.wmux(sel, f, t);
      }
      case 'mintypmax':
        return this.lower(e.typ, w, s, need);
      case 'call': {
        const f = consts.funcOf(e, scope);
        return this.ext(this.h.callFunction(f, e), need, s);
      }
      case 'syscall': {
        if (e.name === '$signed' || e.name === '$unsigned') {
          const arg = this.lowerSelf(e.args[0]!);
          return this.ext(arg, need, s);
        }
        return this.h.fail('not-supported', `The system function ${e.name} is not supported yet.`, e.span);
      }
    }
  }

  private lowerConcat(e: A.ConcatExpr, need: number): Word {
    const widths = e.parts.map((p) => this.typeOf(p).w);
    const total = widths.reduce((a, b) => a + b, 0);
    if (need >= total) {
      this.checkWidth(total, e.span);
      return this.ext(this.nl.wconcat(e.parts.map((p, i) => this.lower(p, widths[i]!, this.typeOf(p).s, widths[i]!))), need, false);
    }
    const kept: Word[] = [];
    let got = 0;
    for (let i = e.parts.length - 1; i >= 0 && got < need; i--) {
      const take = Math.min(widths[i]!, need - got);
      const p = e.parts[i]!;
      kept.unshift(this.lower(p, widths[i]!, this.typeOf(p).s, take));
      got += take;
    }
    return this.nl.wconcat(kept);
  }

  private lowerUnary(e: A.UnaryExpr, w: number, s: boolean, need: number): Word {
    const nl = this.nl;
    switch (e.op) {
      case '+':
        return this.lower(e.operand, w, s, need);
      case '~':
        return nl.wnot(this.lower(e.operand, w, s, need));
      case '-': {
        const x = this.lower(e.operand, w, s, need);
        return nl.wsub(nl.wconst('0'.repeat(need)), x);
      }
      case '!':
        return this.bit(nl.not(this.cond(e.operand)), need);
      default: {
        const x = this.lowerSelf(e.operand);
        const kind = e.op === '&' || e.op === '~&' ? 'reduce_and' : e.op === '|' || e.op === '~|' ? 'reduce_or' : 'reduce_xor';
        if (!['&', '~&', '|', '~|', '^', '~^', '^~'].includes(e.op)) this.h.fail('not-supported', `The unary '${e.op}' operator is not supported yet.`, e.span);
        let r = nl.wreduce(kind, x);
        if (e.op === '~&' || e.op === '~|' || e.op === '~^' || e.op === '^~') r = nl.not(r);
        return this.bit(r, need);
      }
    }
  }

  // ------------------------------------------------------------ binary operators

  private lhsNeed(op: string, need: number, ctx: Type, lctx: Type): number {
    if (NEED_OK.has(op)) return need;
    if (op === '/' || op === '%' || op === '>>' || op === '>>>') return ctx.w;
    return lctx.w;
  }

  private lowerBinary(e: A.BinaryExpr, w: number, s: boolean, need: number): Word {
    const consts = this.h.consts;
    const scope = this.h.scope;
    const spine: A.BinaryExpr[] = [];
    let base: A.Expr = e;
    while (base.kind === 'binary') {
      spine.push(base);
      base = base.lhs;
    }
    // A chain of one word operator is walked in a loop and costs no depth; a chain of comparisons or shifts does, as it would by recursion.
    const deep = spine.filter((b) => !CHAIN_OPS.has(b.op)).length;
    if (deep > MAX_DEPTH) this.h.fail('too-deep', `This expression is nested more than ${MAX_DEPTH} levels deep, which the compiler does not support. Split it into smaller parts.`, e.span);
    const ctxs: Type[] = [{ w, s }];
    const needs: number[] = [need];
    for (let k = 0; k < spine.length; k++) {
      const b = spine[k]!;
      const lctx = consts.lhsCtx(b, ctxs[k]!, scope);
      ctxs.push(lctx);
      needs.push(this.lhsNeed(b.op, needs[k]!, ctxs[k]!, lctx));
    }
    const n = spine.length;
    let acc = this.lower(base, ctxs[n]!.w, ctxs[n]!.s, needs[n]!);
    for (let k = n - 1; k >= 0; k--) acc = this.applyBinary(spine[k]!, acc, ctxs[k]!, needs[k]!, ctxs[k + 1]!);
    return acc;
  }

  private applyBinary(b: A.BinaryExpr, acc: Word, ctx: Type, need: number, lctx: Type): Word {
    const nl = this.nl;
    const op = b.op;
    switch (op) {
      case '&':
      case '|':
      case '^':
      case '~^':
      case '^~': {
        const r = this.lower(b.rhs, ctx.w, ctx.s, need);
        return nl.wbitwise(op === '&' ? 'and' : op === '|' ? 'or' : op === '^' ? 'xor' : 'xnor', acc, r);
      }
      case '+':
        return nl.wadd(acc, this.lower(b.rhs, ctx.w, ctx.s, need));
      case '-':
        return nl.wsub(acc, this.lower(b.rhs, ctx.w, ctx.s, need));
      case '*': {
        this.fullWidth32(need, b.span, '*');
        const r = this.lower(b.rhs, ctx.w, ctx.s, need);
        return { w: need, c: [nl.arith('mul', acc.c[0]!, r.c[0]!)] };
      }
      case '/':
      case '%': {
        this.fullWidth32(ctx.w, b.span, op);
        const r = this.lower(b.rhs, ctx.w, ctx.s, ctx.w);
        const kind = op === '/' ? (ctx.s ? 'divs' : 'divu') : ctx.s ? 'rems' : 'remu';
        return this.ext({ w: ctx.w, c: [nl.arith(kind, acc.c[0]!, r.c[0]!)] }, need, false);
      }
      case '<<':
      case '<<<':
      case '>>':
      case '>>>':
        return this.shift(b, acc, ctx, need);
      case '**':
        return this.power(b, acc, need);
      case '===':
      case '!==':
        return this.h.fail('x-comparison', `'${op}' compares x and z bits, which hardware cannot see: a wire is only ever 0 or 1. Use '${op === '===' ? '==' : '!='}' instead, or remove the x/z comparison.`, b.span);
      case '&&':
      case '||': {
        const l = this.truth(acc);
        const r = this.cond(b.rhs);
        return this.bit(nl.bitwise(op === '&&' ? 'and' : 'or', l, r), need);
      }
      default: {
        if (!RELATIONAL.has(op)) this.h.fail('not-supported', `The '${op}' operator is not supported yet.`, b.span);
        this.checkWidth(lctx.w, b.span);
        const r = this.lower(b.rhs, lctx.w, lctx.s, lctx.w);
        let n: NetId;
        switch (op) {
          case '==':
            n = nl.wcompare('eq', acc, r);
            break;
          case '!=':
            n = nl.wcompare('ne', acc, r);
            break;
          case '<':
            n = nl.wless(acc, r, lctx.s);
            break;
          case '>':
            n = nl.wless(r, acc, lctx.s);
            break;
          case '<=':
            n = nl.not(nl.wless(r, acc, lctx.s));
            break;
          default:
            n = nl.not(nl.wless(acc, r, lctx.s));
        }
        return this.bit(n, need);
      }
    }
  }

  private shift(b: A.BinaryExpr, acc: Word, ctx: Type, need: number): Word {
    const nl = this.nl;
    const left = b.op === '<<' || b.op === '<<<';
    const arith = b.op === '>>>' && ctx.s;
    const amt = this.lowerSelf(b.rhs);
    const k = this.constInt(amt);
    if (k !== undefined) {
      if (left) return k >= BigInt(need) ? nl.wconst('0'.repeat(need)) : nl.wconcat([nl.wslice(acc, 0, need - Number(k)), nl.wconst('0'.repeat(Number(k)))]);
      const kk = k > BigInt(acc.w) ? acc.w : Number(k);
      const avail = Math.max(0, acc.w - kk);
      const take = Math.min(need, avail);
      const fillN = need - take;
      const fill = fillN === 0 ? [] : arith ? Array.from({ length: fillN }, () => nl.wslice(acc, acc.w - 1, 1)) : [nl.wconst('0'.repeat(fillN))];
      return nl.wconcat([...fill, ...(take > 0 ? [nl.wslice(acc, kk, take)] : [])]);
    }
    if (acc.c.length > 1 || amt.c.length > 1) this.h.fail('width-limit', `A shift by a signal is supported up to ${MAX_WIDTH} bits, but this one works on ${Math.max(acc.w, amt.w)} bits.`, b.span);
    const kind = left ? 'shl' : arith ? 'sshr' : 'shr';
    const out = nl.shift(kind, acc.c[0]!, amt.c[0]!);
    return this.ext({ w: acc.w, c: [out] }, need, false);
  }

  private power(b: A.BinaryExpr, acc: Word, need: number): Word {
    const nl = this.nl;
    const exp = this.lowerSelf(b.rhs);
    const k = this.constInt(exp);
    if (k === undefined) this.h.fail('not-supported', "The '**' operator with an exponent that is not constant is not supported yet. Write the exponent as a number or parameter.", b.span);
    const et = this.typeOf(b.rhs);
    const signedExp = et.s && exp.w > 0 && this.nl.wconstBits(exp)![0] === '1';
    if (signedExp) this.h.fail('not-supported', "The '**' operator with a negative exponent is not supported yet.", b.span);
    if (k > 64n) this.h.fail('not-supported', `The '**' operator with an exponent above 64 (here ${k}) is not supported yet.`, b.span);
    this.fullWidth32(need, b.span, '**');
    let result = nl.wconst('0'.repeat(need - 1) + '1');
    let sq = acc;
    let e = Number(k);
    while (e > 0) {
      if (e & 1) result = { w: need, c: [nl.arith('mul', result.c[0]!, sq.c[0]!)] };
      e >>= 1;
      if (e > 0) sq = { w: need, c: [nl.arith('mul', sq.c[0]!, sq.c[0]!)] };
    }
    return result;
  }

  // ------------------------------------------------------------ selects

  /** Position info of what is being selected from. */
  private baseOf(e: A.IndexExpr): { word: Word; info: { msb: number; lsb: number; width: number }; v?: Var } {
    const consts = this.h.consts;
    const scope = this.h.scope;
    const x = consts.resolve(e.base, scope);
    const name = e.base.name;
    if (!x) this.h.consts.diag.undeclared(name, e.base.span);
    if (x.kind === 'param') {
      const bits = cv.toBits(x.value);
      return { word: this.nl.wconst(bits), info: { msb: x.value.width - 1, lsb: 0, width: x.value.width } };
    }
    if (x.kind !== 'var') return this.h.fail('bad-select', `'${name}' cannot be indexed.`, e.base.span);
    this.h.mention(x);
    if (x.mem) {
      if (e.dims.length > 1) this.h.fail('not-supported', 'Arrays with more than one dimension are not supported yet.', e.span);
      const idxExpr = e.dims.length === 0 ? e.hi : e.dims[0]!;
      const addr = this.lowerSelf(idxExpr);
      const word = this.h.readMemWord(x, addr, this.typeOf(idxExpr).s, consts.isConst(idxExpr, scope), idxExpr.span);
      return { word, info: { msb: x.msb, lsb: x.lsb, width: x.mem.width }, v: x };
    }
    if (x.scalar && !x.isLocal) this.h.fail('bad-select', `'${x.name}' is a scalar, declared without a range, so it has no bits to select. Declare it as '[0:0]' to select its bit.`, e.span);
    return { word: this.h.readVar(x, e.base.span), info: x, v: x };
  }

  private lowerIndex(e: A.IndexExpr): Word {
    const consts = this.h.consts;
    const scope = this.h.scope;
    const b = this.baseOf(e);
    const x = consts.resolve(e.base, scope);
    const isMemWord = x?.kind === 'var' && x.mem !== undefined && e.dims.length === 0 && e.mode === 'bit';
    if (isMemWord) return b.word;
    const nm = e.base.name;
    const info = b.info;
    const asc = info.msb < info.lsb;
    const wsel = consts.selectWidth(e, scope);
    const nl = this.nl;
    const outOfRange = (what: string): never =>
      this.h.fail('bad-select', `${what} is outside '${nm}', which has bits ${info.msb} down to ${info.lsb}.`, e.span);
    if (e.mode === 'range') {
      const hi = consts.evalInt(e.hi, scope, 'A part-select bound');
      const lo = consts.evalInt(e.lo!, scope, 'A part-select bound');
      if (asc ? hi > lo : hi < lo) this.h.fail('bad-select', `The part-select [${hi}:${lo}] of '${nm}' must list the bits in the order the signal is declared, like [${asc ? lo : hi}:${asc ? hi : lo}].`, e.span);
      const pHi = bitPos(info, hi);
      const pLo = bitPos(info, lo);
      if (pHi === undefined || pLo === undefined) return outOfRange(`Bit ${pHi === undefined ? hi : lo}`);
      return nl.wslice(b.word, Math.min(pHi, pLo), wsel);
    }
    const idxExpr = e.hi;
    const idx = this.lowerSelf(idxExpr);
    const k = this.constInt(idx);
    const idxSigned = this.typeOf(idxExpr).s;
    if (k !== undefined) {
      const kv = idxSigned && idx.w <= 64 && this.nl.wconstBits(idx)![0] === '1' ? k - (1n << BigInt(idx.w)) : k;
      const ki = Number(kv);
      const low = e.mode === 'bit' ? ki : e.mode === 'plus' ? (asc ? ki + wsel - 1 : ki) : asc ? ki : ki - wsel + 1;
      const p = asc ? info.lsb - low : low - info.lsb;
      if (p < 0 || p + wsel > info.width) {
        if (consts.isConst(idxExpr, scope)) return outOfRange(e.mode === 'bit' ? `Bit ${ki}` : `The part-select starting at ${ki}`);
        return nl.wconst('x'.repeat(wsel));
      }
      return nl.wslice(b.word, p, wsel);
    }
    return { w: wsel, c: [this.dynamicSelect(b.word, info, idx, idxSigned, wsel, e.mode, e.span)] };
  }

  /** Position of the lowest selected bit as a 32-bit two's complement net (negative or past the end means out of range). */
  selectPosition(info: { msb: number; lsb: number; width: number }, idx: Word, idxSigned: boolean, wsel: number, mode: 'bit' | 'plus' | 'minus' | 'range'): NetId {
    const nl = this.nl;
    const asc = info.msb < info.lsb;
    const c32 = (n: number) => nl.constant((BigInt(n) & 0xffffffffn).toString(2).padStart(32, '0'));
    const i32 = idxSigned ? nl.signExtend(idx.c[0]!, 32) : nl.zeroExtend(idx.c[0]!, 32);
    const low = mode === 'bit' ? i32 : mode === 'plus' ? (asc ? nl.arith('add', i32, c32(wsel - 1)) : i32) : asc ? i32 : nl.arith('sub', i32, c32(wsel - 1));
    return asc ? nl.arith('sub', c32(info.lsb), low) : info.lsb === 0 ? low : nl.arith('sub', low, c32(info.lsb));
  }

  /** A select whose index is a signal: shift the wanted bits to the bottom; a bit of the window outside the vector reads x. */
  private dynamicSelect(word: Word, info: { msb: number; lsb: number; width: number }, idx: Word, idxSigned: boolean, wsel: number, mode: 'bit' | 'plus' | 'minus' | 'range', span: Span): NetId {
    const nl = this.nl;
    if (word.c.length > 1 || idx.c.length > 1) this.h.fail('width-limit', `A select by a signal is supported up to ${MAX_WIDTH} bits, but this one works on ${Math.max(word.w, idx.w)} bits.`, span);
    const asc = info.msb < info.lsb;
    const base = word.c[0]!;
    const W = info.width;
    const iw = idx.w;
    const c32 = (n: number) => nl.constant((BigInt(n) & 0xffffffffn).toString(2).padStart(32, '0'));
    if (wsel === 1) {
      const simple = !asc && info.lsb === 0 && !idxSigned;
      if (simple) {
        const p = idx.c[0]!;
        const picked = nl.slice(nl.shift('shr', base, p), 0, 1);
        if (2 ** iw <= W) return picked;
        return nl.mux(nl.less('ltu', p, nl.constant(W.toString(2).padStart(iw, '0'))), nl.constant('x'), picked);
      }
      const p = this.selectPosition(info, idx, idxSigned, 1, mode);
      const picked = nl.slice(nl.shift('shr', base, p), 0, 1);
      return nl.mux(nl.less('ltu', p, c32(W)), nl.constant('x'), picked);
    }
    const p = this.selectPosition(info, idx, idxSigned, wsel, mode);
    const b32 = nl.zeroExtend(base, 32);
    const neg = nl.less('lts', p, c32(0));
    const sh = nl.mux(neg, nl.shift('shr', b32, p), nl.shift('shl', b32, nl.arith('sub', c32(0), p)));
    const bits: NetId[] = [];
    for (let k = wsel - 1; k >= 0; k--) {
      const valid = nl.less('ltu', nl.arith('add', p, c32(k)), c32(W));
      bits.push(nl.mux(valid, nl.constant('x'), nl.slice(sh, k, 1)));
    }
    return nl.concat(bits);
  }

  // ------------------------------------------------------------ tri-state

  /**
   * `en ? a : 'bz` and its nested forms: the enable and value of every arm that is not all z. Returns undefined
   * when no arm is z, so the expression is an ordinary multiplexer.
   */
  triArms(e: A.Expr): { en: NetId | undefined; value: A.Expr }[] | undefined {
    const arms: { en: NetId | undefined; value: A.Expr }[] = [];
    let sawZ = false;
    const walk = (x: A.Expr, en: NetId | undefined) => {
      if (x.kind === 'ternary') {
        const c = this.cond(x.cond);
        const nl = this.nl;
        walk(x.then, en === undefined ? c : nl.bitwise('and', en, c));
        const nc = nl.not(c);
        walk(x.else, en === undefined ? nc : nl.bitwise('and', en, nc));
        return;
      }
      if (this.isAllZ(x)) {
        sawZ = true;
        return;
      }
      arms.push({ en, value: x });
    };
    if (e.kind !== 'ternary') return undefined;
    walk(e, undefined);
    return sawZ ? arms : undefined;
  }

  private isAllZ(e: A.Expr): boolean {
    const consts = this.h.consts;
    if (!consts.isConst(e, this.h.scope)) return false;
    try {
      const v = consts.evalSelf(e, this.h.scope);
      return cv.toBits(v).split('').every((c) => c === 'z');
    } catch (err) {
      if (err instanceof NotConstant) return false;
      throw err;
    }
  }

}
