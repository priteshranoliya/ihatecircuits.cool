import type * as A from '../ast';
import { type DiagnosticCode, type Span, abbreviate } from '../diagnostics';
import { parseNumber } from '../number';
import * as cv from './cval';
import type { CVal } from './cval';
import { type Entry, type FuncEntry, type Genvar, type Param, Scope, type Var } from './scope';

/**
 * Types and constant values of expressions (IEEE 1364-2005 5.4 and 5.5).
 *
 * `typeOf` gives the width and signedness an expression has on its own. `evalCtx` evaluates a constant
 * expression inside a context of a given width and signedness, which is how every context-determined operand is
 * sized: extended to the context width, by sign when the whole expression is signed and by zero otherwise.
 * The same file runs constant functions and `initial` blocks over concrete values, so a parameter can be built
 * from a function call.
 */

export interface Diag {
  fail(code: DiagnosticCode, message: string, span: Span): never;
  warn(code: DiagnosticCode, message: string, span: Span): void;
  /** A name that resolves to nothing: an error, with a hint when it is declared further down. */
  undeclared(name: string, span: Span): never;
}

export class NotConstant extends Error {
  constructor(
    readonly span: Span,
    readonly name: string,
  ) {
    super(`${name} is not constant`);
  }
}

export interface Type {
  w: number;
  s: boolean;
}

export interface Lit {
  value: CVal;
  /** Written with a size (`8'd5`); plain and `'d5` numbers are not. */
  sized: boolean;
}

/** The memory words and variables of a running interpretation. */
export interface Store {
  vars: Map<Var, CVal>;
  mems: Map<Var, CVal[]>;
  /** Running an `initial` block, where a print is not something hardware can do. */
  initial?: boolean;
}

export const newStore = (initial = false): Store => ({ vars: new Map(), mems: new Map(), initial });

export const MAX_DEPTH = 500;
const MAX_LOOP = 100000;
const MAX_CONST_WIDTH = 65536;

const ARITH = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '~^', '^~']);
const SHIFT = new Set(['<<', '>>', '<<<', '>>>']);

export function localVar(name: string, width: number, signed: boolean, span: Span, type: Var['type'] = 'reg', msb = width - 1, lsb = 0, scalar = false): Var {
  return {
    kind: 'var', name, type, netKind: 'wire', width, signed, msb, lsb, scalar, net: -1, isLocal: true, isVariable: true, span,
    mentioned: false, netRead: false, blockingWrites: 0, nonblockingWrites: 0, declInit: false, scratch: false, pulls: [],
  };
}

/** Bit position (0 = least significant) of declared index `i` of a vector with bounds [msb:lsb], or undefined when outside. */
export function bitPos(v: { msb: number; lsb: number; width: number }, i: number): number | undefined {
  const p = v.msb >= v.lsb ? i - v.lsb : v.lsb - i;
  return p >= 0 && p < v.width ? p : undefined;
}

export class Consts {
  private readonly lits = new Map<A.NumberExpr, Lit>();
  private depth = 0;
  readonly constMemo = new WeakMap<Scope, Map<A.Expr, boolean>>();

  constructor(
    readonly diag: Diag,
    readonly files: Record<string, string> = {},
  ) {}

  // ------------------------------------------------------------ literals and names

  lit(e: A.NumberExpr | A.RealExpr | A.StringExpr): Lit {
    if (e.kind === 'real') this.diag.fail('not-supported', 'Real numbers are not supported yet.', e.span);
    if (e.kind === 'string') {
      const body = decodeString(e.text);
      const bits = [...body].map((c) => c.charCodeAt(0).toString(2).padStart(8, '0')).join('') || '00000000';
      return { value: cv.fromBits(bits, false), sized: true };
    }
    const hit = this.lits.get(e);
    if (hit) return hit;
    const r = parseNumber(e.text);
    if (!r.ok) this.diag.fail(r.kind === 'too-large' ? 'literal-too-large' : 'bad-literal', r.message, e.span);
    if (r.truncated) this.diag.warn('literal-truncated', `${abbreviate(e.text)} does not fit in ${r.literal.size} bits; its upper bits are dropped.`, e.span);
    const plainDecimal = /^[0-9_\s]+$/.test(e.text);
    const lit: Lit = { value: cv.fromBits(r.literal.bits, r.literal.signed || plainDecimal), sized: r.literal.size !== undefined };
    this.lits.set(e, lit);
    return lit;
  }

  resolve(ref: A.Ref, scope: Scope): Entry | undefined {
    if (ref.kind === 'ident') return scope.lookup(ref.name);
    let cur: Scope | undefined;
    for (let i = 0; i < ref.segments.length; i++) {
      const seg = ref.segments[i]!;
      const key = seg.index ? `${seg.name.name}[${this.evalInt(seg.index, scope, 'A generate index')}]` : seg.name.name;
      const last = i === ref.segments.length - 1;
      if (cur === undefined) {
        if (!last) {
          for (let s: Scope | undefined = scope; s && !cur; s = s.parent) cur = s.children.get(key);
          if (!cur) {
            const first = scope.lookup(seg.name.name);
            if (first?.kind === 'inst') this.diag.fail('not-supported', `Reading a signal inside the instance '${seg.name.name}' by its hierarchical name (${ref.name}) is not supported yet.`, ref.span);
            if (first?.kind === 'scope') cur = first.scope;
          }
          if (!cur) return undefined;
        } else return scope.lookup(seg.name.name);
      } else if (last) return cur.lookupLocal(seg.name.name);
      else {
        cur = cur.children.get(key);
        if (!cur) return undefined;
      }
    }
    return undefined;
  }

  private deeper<T>(span: Span, f: () => T): T {
    if (this.depth >= MAX_DEPTH) this.diag.fail('too-deep', `This expression is nested more than ${MAX_DEPTH} levels deep, which the compiler does not support. Split it into smaller parts.`, span);
    this.depth++;
    try {
      return f();
    } finally {
      this.depth--;
    }
  }

  private entryOf(e: A.Ident | A.HierRef, scope: Scope): Entry {
    const entry = this.resolve(e, scope);
    if (!entry) this.diag.undeclared(e.name, e.span);
    return entry;
  }

  // ------------------------------------------------------------ types

  typeOf(e: A.Expr, scope: Scope): Type {
    const hit = scope.types.get(e);
    if (hit) return hit;
    const t = this.deeper(e.span, () => this.typeOfNode(e, scope));
    scope.types.set(e, t);
    return t;
  }

  private typeOfNode(e: A.Expr, scope: Scope): Type {
    switch (e.kind) {
      case 'number':
      case 'real':
      case 'string': {
        const l = this.lit(e);
        return { w: l.value.width, s: l.value.signed };
      }
      case 'ident':
      case 'hier': {
        const x = this.entryOf(e, scope);
        switch (x.kind) {
          case 'param':
            return { w: x.value.width, s: x.value.signed };
          case 'genvar':
            return { w: 32, s: true };
          case 'var':
            if (x.mem) this.diag.fail('bad-select', `'${x.name}' is a memory, so it needs an index, like ${x.name}[0].`, e.span);
            return { w: x.width, s: x.signed };
          default:
            this.diag.fail('bad-declaration', `'${e.name}' is not a signal or a parameter, so it cannot be used as a value.`, e.span);
        }
        break;
      }
      case 'index':
        return this.typeOfIndex(e, scope);
      case 'concat': {
        let w = 0;
        for (const p of e.parts) {
          if ((p.kind === 'number') && !this.lit(p).sized) {
            this.diag.fail('bad-width', `The unsized number ${abbreviate(p.text)} has no defined width inside a concatenation. Give it a size, like 4'd${abbreviate(p.text, 20)}.`, p.span);
          }
          w += this.typeOf(p, scope).w;
        }
        return { w, s: false };
      }
      case 'replicate': {
        const n = this.evalInt(e.count, scope, 'A replication count');
        return { w: n * this.typeOf(e.inner, scope).w, s: false };
      }
      case 'unary':
        return e.op === '+' || e.op === '-' || e.op === '~' ? this.typeOf(e.operand, scope) : { w: 1, s: false };
      case 'binary': {
        const spine: A.BinaryExpr[] = [];
        let cur: A.Expr = e;
        while (cur.kind === 'binary') {
          spine.push(cur);
          cur = cur.lhs;
        }
        let t = this.typeOf(cur, scope);
        for (let i = spine.length - 1; i >= 0; i--) {
          const b = spine[i]!;
          const r = this.typeOf(b.rhs, scope);
          if (ARITH.has(b.op)) t = { w: Math.max(t.w, r.w), s: t.s && r.s };
          else if (SHIFT.has(b.op) || b.op === '**') t = { w: t.w, s: t.s };
          else t = { w: 1, s: false };
          if (i > 0) scope.types.set(b, t);
        }
        return t;
      }
      case 'ternary': {
        this.typeOf(e.cond, scope);
        const t = this.typeOf(e.then, scope);
        const f = this.typeOf(e.else, scope);
        return { w: Math.max(t.w, f.w), s: t.s && f.s };
      }
      case 'mintypmax':
        return this.typeOf(e.typ, scope);
      case 'call': {
        const f = this.funcOf(e, scope);
        return this.funcReturn(f);
      }
      case 'syscall':
        return this.typeOfSys(e, scope);
    }
  }

  private typeOfSys(e: A.SysCallExpr, scope: Scope): Type {
    switch (e.name) {
      case '$signed':
      case '$unsigned': {
        if (e.args.length !== 1) this.diag.fail('bad-declaration', `${e.name} takes one argument.`, e.span);
        return { w: this.typeOf(e.args[0]!, scope).w, s: e.name === '$signed' };
      }
      case '$clog2':
        if (e.args.length !== 1) this.diag.fail('bad-declaration', '$clog2 takes one argument.', e.span);
        return { w: 32, s: true };
      case '$bits':
        return { w: 32, s: false };
      default:
        return this.diag.fail('not-supported', `The system function ${e.name} is not supported yet.`, e.span);
    }
  }

  private typeOfIndex(e: A.IndexExpr, scope: Scope): Type {
    const x = this.entryOf(e.base, scope);
    if (x.kind === 'var' && x.mem) {
      if (e.dims.length === 0 && e.mode === 'bit') return { w: x.mem.width, s: x.signed };
      if (e.dims.length > 1) this.diag.fail('not-supported', 'Arrays with more than one dimension are not supported yet.', e.span);
      return { w: this.selectWidth(e, scope), s: false };
    }
    if (e.dims.length > 0) this.diag.fail('bad-select', `'${e.base.name}' is not a memory, so it cannot take two indexes.`, e.span);
    if (x.kind === 'var' && x.scalar && !x.isLocal) this.diag.fail('bad-select', `'${x.name}' is a scalar, declared without a range, so it has no bits to select. Declare it as '[0:0]' to select its bit.`, e.span);
    return { w: this.selectWidth(e, scope), s: false };
  }

  selectWidth(e: A.IndexExpr, scope: Scope): number {
    if (e.mode === 'bit') return 1;
    if (e.mode === 'range') {
      const hi = this.evalInt(e.hi, scope, 'A part-select bound');
      const lo = this.evalInt(e.lo!, scope, 'A part-select bound');
      return Math.abs(hi - lo) + 1;
    }
    const w = this.evalInt(e.lo!, scope, 'The width of an indexed part-select');
    if (w < 1) this.diag.fail('bad-select', 'The width of an indexed part-select must be at least 1.', e.lo!.span);
    return w;
  }

  /** Resolve a call target: a variable of the same name (a function's own result) does not hide the function. */
  private resolveCallable(ref: A.Ref, scope: Scope): Entry | undefined {
    if (ref.kind === 'ident') {
      for (let sc: Scope | undefined = scope; sc; sc = sc.parent) {
        const x = sc.syms.get(ref.name);
        if (x && (x.kind === 'func' || x.kind === 'task')) return x;
      }
    }
    return this.resolve(ref, scope);
  }

  resolveTask(ref: A.Ref, scope: Scope): Entry | undefined {
    return this.resolveCallable(ref, scope);
  }

  funcOf(e: A.CallExpr, scope: Scope): FuncEntry {
    const x = this.resolveCallable(e.callee, scope);
    if (!x) this.diag.fail('undeclared', `The function '${e.callee.name}' is not declared.`, e.callee.span);
    if (x.kind !== 'func') this.diag.fail('bad-declaration', `'${e.callee.name}' is not a function.`, e.callee.span);
    return x;
  }

  funcReturn(f: FuncEntry): Type {
    const d = f.decl;
    if (d.type === 'integer') return { w: 32, s: true };
    if (d.type === 'time') return { w: 64, s: false };
    if (d.type === 'real' || d.type === 'realtime') this.diag.fail('not-supported', 'Real-valued functions are not supported yet.', d.span);
    if (d.range) {
      const hi = this.evalInt(d.range.msb, f.scope, 'A range bound');
      const lo = this.evalInt(d.range.lsb, f.scope, 'A range bound');
      return { w: Math.abs(hi - lo) + 1, s: d.signed };
    }
    return { w: 1, s: d.signed };
  }

  // ------------------------------------------------------------ whether an expression is a constant

  isConst(e: A.Expr, scope: Scope): boolean {
    let memo = this.constMemo.get(scope);
    if (!memo) this.constMemo.set(scope, (memo = new Map()));
    const hit = memo.get(e);
    if (hit !== undefined) return hit;
    const r = this.isConstNode(e, scope);
    memo.set(e, r);
    return r;
  }

  private isConstNode(e: A.Expr, scope: Scope): boolean {
    switch (e.kind) {
      case 'number':
      case 'real':
      case 'string':
        return true;
      case 'ident':
      case 'hier': {
        const x = this.resolve(e, scope);
        return x?.kind === 'param' || (x?.kind === 'genvar' && x.value !== undefined);
      }
      case 'index': {
        const x = this.resolve(e.base, scope);
        if (x?.kind !== 'param') return false;
        return [...e.dims, e.hi, ...(e.lo ? [e.lo] : [])].every((s) => this.isConst(s, scope));
      }
      case 'concat':
        return e.parts.every((p) => this.isConst(p, scope));
      case 'replicate':
        return this.isConst(e.count, scope) && this.isConst(e.inner, scope);
      case 'unary':
        return this.isConst(e.operand, scope);
      case 'binary': {
        let cur: A.Expr = e;
        while (cur.kind === 'binary') {
          if (!this.isConst(cur.rhs, scope)) return false;
          cur = cur.lhs;
        }
        return this.isConst(cur, scope);
      }
      case 'ternary':
        return this.isConst(e.cond, scope) && this.isConst(e.then, scope) && this.isConst(e.else, scope);
      case 'mintypmax':
        return this.isConst(e.typ, scope);
      case 'call':
        return e.args.every((a) => this.isConst(a, scope)) && this.resolveCallable(e.callee, scope)?.kind === 'func';
      case 'syscall':
        return e.args.every((a) => this.isConst(a, scope)) && ['$signed', '$unsigned', '$clog2', '$bits'].includes(e.name);
    }
  }

  // ------------------------------------------------------------ evaluation

  /** A constant integer (a range bound, a count, a generate condition); `what` names it in the error. */
  evalInt(e: A.Expr, scope: Scope, what: string, store?: Store): number {
    const v = this.evalConstOrFail(e, scope, what, store);
    if (!cv.known(v)) this.diag.fail('bad-literal', `${what} cannot contain x or z.`, e.span);
    const n = cv.toBigInt(v);
    if (n > 1_000_000_000n || n < -1_000_000_000n) this.diag.fail('bad-literal', `${what} is too large (${abbreviate(n.toString())}).`, e.span);
    return Number(n);
  }

  evalConstOrFail(e: A.Expr, scope: Scope, what: string, store?: Store): CVal {
    try {
      return this.evalSelf(e, scope, store);
    } catch (err) {
      if (err instanceof NotConstant) {
        this.diag.fail('not-constant', `${what} must be a constant expression, but '${err.name}' is not a constant. Build it from numbers, parameters and genvars.`, err.span);
      }
      throw err;
    }
  }

  evalSelf(e: A.Expr, scope: Scope, store?: Store): CVal {
    const t = this.typeOf(e, scope);
    return this.evalCtx(e, scope, t.w, t.s, store);
  }

  /** `e` evaluated in a context `w` bits wide whose signedness is `s`: the result is exactly `w` bits. */
  evalCtx(e: A.Expr, scope: Scope, w: number, s: boolean, store?: Store): CVal {
    return this.deeper(e.span, () => this.evalNode(e, scope, w, s, store));
  }

  private ext(v: CVal, w: number, s: boolean): CVal {
    if (w > MAX_CONST_WIDTH) this.diag.fail('width-limit', `A constant of ${w} bits is wider than the ${MAX_CONST_WIDTH} bits the compiler will build.`, { start: 0, end: 0, line: 1, col: 1 });
    return cv.resize(cv.withSign(v, s), w, s);
  }

  private evalNode(e: A.Expr, scope: Scope, w: number, s: boolean, store?: Store): CVal {
    switch (e.kind) {
      case 'number':
      case 'real':
      case 'string':
        return this.ext(this.lit(e).value, w, s);
      case 'ident':
      case 'hier': {
        const x = this.entryOf(e, scope);
        if (x.kind === 'param') return this.ext(x.value, w, s);
        if (x.kind === 'genvar') {
          if (!x.value) throw new NotConstant(e.span, e.name);
          return this.ext(x.value, w, s);
        }
        if (x.kind === 'var') {
          const v = store?.vars.get(x);
          if (v) return this.ext(v, w, s);
          if (store && x.isLocal) return this.ext(cv.allX(x.width, x.signed), w, s);
          throw new NotConstant(e.span, x.name);
        }
        return this.diag.fail('bad-declaration', `'${e.name}' is not a signal or a parameter, so it cannot be used as a value.`, e.span);
      }
      case 'index':
        return this.ext(this.evalIndex(e, scope, store), w, s);
      case 'concat':
        return this.ext(cv.concat(e.parts.map((p) => this.evalSelf(p, scope, store))), w, s);
      case 'replicate': {
        const n = this.evalInt(e.count, scope, 'A replication count');
        if (n < 0) this.diag.fail('bad-width', 'A replication count cannot be negative.', e.count.span);
        const inner = this.evalSelf(e.inner, scope, store);
        return this.ext(n === 0 ? cv.make(0, false, 0n, 0n) : cv.replicate(inner, n), w, s);
      }
      case 'unary': {
        switch (e.op) {
          case '+':
            return this.evalCtx(e.operand, scope, w, s, store);
          case '-':
            return cv.neg(this.evalCtx(e.operand, scope, w, s, store));
          case '~':
            return cv.not(this.evalCtx(e.operand, scope, w, s, store));
          default: {
            const x = this.evalSelf(e.operand, scope, store);
            let r: CVal;
            switch (e.op) {
              case '!':
                r = cv.logicalNot(x);
                break;
              case '&':
                r = cv.reduceAnd(x);
                break;
              case '~&':
                r = cv.logicalNot(cv.reduceAnd(x));
                break;
              case '|':
                r = cv.reduceOr(x);
                break;
              case '~|':
                r = cv.logicalNot(cv.reduceOr(x));
                break;
              case '^':
                r = cv.reduceXor(x);
                break;
              case '~^':
              case '^~':
                r = cv.logicalNot(cv.reduceXor(x));
                break;
              default:
                return this.diag.fail('not-supported', `The unary '${e.op}' operator is not supported yet.`, e.span);
            }
            return this.ext(r, w, false);
          }
        }
      }
      case 'binary':
        return this.evalBinary(e, scope, w, s, store);
      case 'ternary': {
        const c = this.evalSelf(e.cond, scope, store);
        const t = cv.truth(c);
        if (cv.known(t)) return this.evalCtx(cv.bigA(t) === 1n ? e.then : e.else, scope, w, s, store);
        return cv.select(c, this.evalCtx(e.then, scope, w, s, store), this.evalCtx(e.else, scope, w, s, store));
      }
      case 'mintypmax':
        return this.evalCtx(e.typ, scope, w, s, store);
      case 'call': {
        const f = this.funcOf(e, scope);
        const t = this.funcReturn(f);
        return this.ext(this.callFunction(f, e.args, scope, store, e), w, s && t.s);
      }
      case 'syscall':
        return this.ext(this.evalSys(e, scope, store), w, s && this.typeOfSys(e, scope).s);
    }
  }

  private evalSys(e: A.SysCallExpr, scope: Scope, store?: Store): CVal {
    switch (e.name) {
      case '$signed':
        return cv.withSign(this.evalSelf(e.args[0]!, scope, store), true);
      case '$unsigned':
        return cv.withSign(this.evalSelf(e.args[0]!, scope, store), false);
      case '$clog2': {
        const v = this.evalSelf(e.args[0]!, scope, store);
        if (!cv.known(v)) return cv.allX(32, true);
        const n = cv.toBigIntAs(v, false);
        let r = 0;
        while ((1n << BigInt(r)) < n) r++;
        return cv.fromInt(r);
      }
      case '$bits':
        return cv.fromInt(this.typeOfBits(e.args[0]!, scope), 32, false);
      default:
        return this.diag.fail('not-supported', `The system function ${e.name} is not supported yet.`, e.span);
    }
  }

  private typeOfBits(arg: A.Expr, scope: Scope): number {
    return this.typeOf(arg, scope).w;
  }

  private evalBinary(e: A.BinaryExpr, scope: Scope, w: number, s: boolean, store?: Store): CVal {
    const spine: A.BinaryExpr[] = [];
    let base: A.Expr = e;
    while (base.kind === 'binary') {
      spine.push(base);
      base = base.lhs;
    }
    const ctxs: Type[] = [{ w, s }];
    for (const b of spine) ctxs.push(this.lhsCtx(b, ctxs[ctxs.length - 1]!, scope));
    const last = ctxs[ctxs.length - 1]!;
    let acc = this.evalCtx(base, scope, last.w, last.s, store);
    for (let k = spine.length - 1; k >= 0; k--) acc = this.applyBinary(spine[k]!, acc, scope, ctxs[k]!.w, ctxs[k]!.s, store);
    return acc;
  }

  /** The context in which the left operand of `b` is sized, given the context `b` itself is in. */
  lhsCtx(b: A.BinaryExpr, ctx: Type, scope: Scope): Type {
    if (ARITH.has(b.op) || SHIFT.has(b.op) || b.op === '**') return ctx;
    if (b.op === '&&' || b.op === '||') return this.typeOf(b.lhs, scope);
    const lt = this.typeOf(b.lhs, scope);
    const rt = this.typeOf(b.rhs, scope);
    return { w: Math.max(lt.w, rt.w), s: lt.s && rt.s };
  }

  private applyBinary(b: A.BinaryExpr, lhs: CVal, scope: Scope, w: number, s: boolean, store?: Store): CVal {
    const op = b.op;
    if (ARITH.has(op)) {
      const r = this.evalCtx(b.rhs, scope, w, s, store);
      switch (op) {
        case '+':
          return cv.add(lhs, r);
        case '-':
          return cv.sub(lhs, r);
        case '*':
          return cv.mul(lhs, r);
        case '/':
          return cv.divide(lhs, r, false);
        case '%':
          return cv.divide(lhs, r, true);
        case '&':
          return cv.and(lhs, r);
        case '|':
          return cv.or(lhs, r);
        case '^':
          return cv.xor(lhs, r);
        default:
          return cv.xnor(lhs, r);
      }
    }
    if (SHIFT.has(op)) {
      const n = cv.withSign(this.evalSelf(b.rhs, scope, store), false);
      if (op === '<<' || op === '<<<') return cv.shiftLeft(lhs, n);
      return cv.shiftRight(lhs, n, op === '>>>' && s);
    }
    if (op === '**') {
      const r = this.evalSelf(b.rhs, scope, store);
      return cv.power(lhs, r);
    }
    if (op === '&&' || op === '||') {
      const l = cv.truth(lhs);
      const r = cv.truth(this.evalSelf(b.rhs, scope, store));
      return this.ext(op === '&&' ? cv.and(l, r) : cv.or(l, r), w, false);
    }
    // Relational and equality operators size both operands to the wider one, and compare as signed when both are.
    const lt = this.typeOf(b.lhs, scope);
    const rt = this.typeOf(b.rhs, scope);
    const cw = Math.max(lt.w, rt.w);
    const cs = lt.s && rt.s;
    const a = this.evalCtx(b.lhs, scope, cw, cs, store);
    const c = this.evalCtx(b.rhs, scope, cw, cs, store);
    let r: CVal;
    switch (op) {
      case '==':
        r = cv.eq(a, c);
        break;
      case '!=':
        r = cv.ne(a, c);
        break;
      case '===':
        r = cv.bit(a.a === c.a && cv.bigB(a) === cv.bigB(c) ? 1 : 0);
        break;
      case '!==':
        r = cv.bit(a.a === c.a && cv.bigB(a) === cv.bigB(c) ? 0 : 1);
        break;
      case '<':
        r = cv.lessThan(a, c, cs);
        break;
      case '>':
        r = cv.lessThan(c, a, cs);
        break;
      case '<=':
        r = cv.logicalNot(cv.lessThan(c, a, cs));
        break;
      default:
        r = cv.logicalNot(cv.lessThan(a, c, cs));
    }
    return this.ext(r, w, false);
  }

  private evalIndex(e: A.IndexExpr, scope: Scope, store?: Store): CVal {
    const x = this.entryOf(e.base, scope);
    let base: CVal;
    let info: { msb: number; lsb: number; width: number };
    if (x.kind === 'param') {
      base = x.value;
      info = { msb: x.value.width - 1, lsb: 0, width: x.value.width };
    } else if (x.kind === 'var') {
      if (x.mem) {
        const words = store?.mems.get(x);
        if (!store || !x.isLocal && !words) throw new NotConstant(e.span, x.name);
        const idx = this.evalInt(e.dims.length === 0 ? e.hi : e.dims[0]!, scope, 'A memory index', store);
        const word = idx - x.mem.base;
        const v = word >= 0 && word < x.mem.depth ? words?.[word] ?? cv.allX(x.mem.width, x.signed) : cv.allX(x.mem.width, x.signed);
        if (e.dims.length === 0) return v;
        base = v;
        info = { msb: x.msb, lsb: x.lsb, width: x.mem.width };
      } else {
        const v = store?.vars.get(x) ?? (store && x.isLocal ? cv.allX(x.width, x.signed) : undefined);
        if (!v) throw new NotConstant(e.span, x.name);
        base = v;
        info = x;
      }
    } else if (x.kind === 'genvar') {
      if (!x.value) throw new NotConstant(e.span, e.base.name);
      base = x.value;
      info = { msb: 31, lsb: 0, width: 32 };
    } else return this.diag.fail('bad-select', 'This name cannot be indexed.', e.span);
    const wsel = this.selectWidth(e, scope);
    if (e.mode === 'bit') {
      const i = this.evalSelfOrX(e.hi, scope, store);
      if (!i) return cv.allX(1);
      const p = bitPos(info, Number(i));
      return p === undefined ? cv.allX(1) : cv.slice(base, p, 1);
    }
    let lowIndex: number;
    if (e.mode === 'range') {
      const hi = this.evalInt(e.hi, scope, 'A part-select bound');
      const lo = this.evalInt(e.lo!, scope, 'A part-select bound');
      lowIndex = info.msb >= info.lsb ? Math.min(hi, lo) : Math.max(hi, lo);
    } else {
      const b = this.evalSelfOrX(e.hi, scope, store);
      if (b === undefined) return cv.allX(wsel);
      const bi = Number(b);
      lowIndex = e.mode === 'plus' ? (info.msb >= info.lsb ? bi : bi + wsel - 1) : info.msb >= info.lsb ? bi - wsel + 1 : bi;
    }
    const p = info.msb >= info.lsb ? lowIndex - info.lsb : info.lsb - lowIndex;
    if (p < 0 || p + wsel > info.width) return cv.allX(wsel);
    return cv.slice(base, p, wsel);
  }

  private evalSelfOrX(e: A.Expr, scope: Scope, store?: Store): bigint | undefined {
    const v = this.evalSelf(e, scope, store);
    return cv.known(v) ? cv.toBigInt(v) : undefined;
  }

  // ------------------------------------------------------------ functions and tasks over concrete values

  /** Run a function on constant arguments. `args` are evaluated in the caller's `scope` and `store`. */
  callFunction(f: FuncEntry, args: A.Expr[], scope: Scope, store: Store | undefined, at: A.Expr): CVal {
    return this.deeper(at.span, () => {
      const d = f.decl;
      const fs = new Scope('func', '', f.scope);
      const inner = newStore();
      const rt = this.funcReturn(f);
      const ret = localVar(d.name.name, rt.w, rt.s, d.name.span, d.type === 'integer' ? 'integer' : 'reg');
      fs.syms.set(d.name.name, ret);
      inner.vars.set(ret, cv.allX(rt.w, rt.s));
      const inputs = this.declareTfPorts(fs, d, inner);
      if (args.length !== inputs.length) this.diag.fail('bad-declaration', `The function '${d.name.name}' takes ${inputs.length} argument${inputs.length === 1 ? '' : 's'}, but this call gives ${args.length}.`, at.span);
      args.forEach((a, i) => {
        const p = inputs[i]!;
        const t = this.typeOf(a, scope);
        const v = this.evalCtx(a, scope, Math.max(t.w, p.width), t.s, store);
        inner.vars.set(p, cv.withSign(cv.resize(v, p.width, t.s), p.signed));
      });
      this.execBlockDecls(fs, d.decls, inner);
      this.exec(d.body, fs, inner);
      return inner.vars.get(ret)!;
    });
  }

  /** Declare the ports of a function or task header or body in `fs`; returns the inputs in order. */
  declareTfPorts(fs: Scope, d: A.FunctionDecl | A.TaskDecl, store: Store): Var[] {
    const inputs: Var[] = [];
    const add = (name: A.Ident, dir: string, range: A.RangeSpec | undefined, signed: boolean, type: string | undefined) => {
      const v = this.declareScalarLike(fs, name, range, signed, type);
      fs.syms.set(name.name, v);
      store.vars.set(v, cv.allX(v.width, v.signed));
      if (dir === 'input') inputs.push(v);
    };
    for (const p of d.ports) add(p.name, p.dir, p.range, p.signed, p.net);
    for (const decl of d.decls) {
      if (decl.kind === 'portDecl') for (const n of decl.names) add(n.name, decl.dir, decl.range, decl.signed, decl.net);
    }
    return inputs;
  }

  private declareScalarLike(scope: Scope, name: A.Ident, range: A.RangeSpec | undefined, signed: boolean, type: string | undefined): Var {
    let width = 1;
    let msb = 0;
    let lsb = 0;
    if (type === 'integer') return localVar(name.name, 32, true, name.span, 'integer', 31, 0);
    if (type === 'time') return localVar(name.name, 64, false, name.span, 'time', 63, 0);
    if (range) {
      msb = this.evalInt(range.msb, scope, 'A range bound');
      lsb = this.evalInt(range.lsb, scope, 'A range bound');
      width = Math.abs(msb - lsb) + 1;
    }
    return localVar(name.name, width, signed, name.span, 'reg', msb, lsb, range === undefined);
  }

  /** Declarations in a function body or named block become locals of `scope`. */
  execBlockDecls(scope: Scope, decls: A.BlockDecl[], store: Store) {
    for (const d of decls) {
      if (d.kind === 'netDecl') {
        for (const decl of d.declarators) {
          if (d.net !== 'reg' && d.net !== 'integer' && d.net !== 'time') this.diag.fail('not-supported', `'${d.net}' declarations inside a function are not supported yet.`, d.span);
          if (decl.dims.length > 0) this.diag.fail('not-supported', 'Arrays inside a function are not supported yet.', decl.span);
          const v = this.declareScalarLike(scope, decl.name, d.range, d.signed, d.net);
          scope.syms.set(decl.name.name, v);
          store.vars.set(v, decl.init ? this.evalSelf(decl.init, scope, store) : cv.allX(v.width, v.signed));
        }
      } else if (d.kind === 'paramDecl') {
        for (const a of d.assigns) scope.syms.set(a.name.name, { kind: 'param', name: a.name.name, value: this.evalSelf(a.value, scope, store), span: a.span, local: true });
      }
    }
  }

  // ------------------------------------------------------------ statements

  exec(s: A.Stmt, scope: Scope, store: Store): void {
    this.deeper(s.span, () => this.execNode(s, scope, store));
  }

  private execNode(s: A.Stmt, scope: Scope, store: Store): void {
    switch (s.kind) {
      case 'empty':
        return;
      case 'block': {
        if (s.parallel) this.diag.fail('not-synthesizable', "A 'fork' block is not synthesizable; a testbench feature (coming with the simulator).", s.span);
        let inner = scope;
        if (s.decls.length > 0) {
          inner = new Scope('block', '', scope);
          this.execBlockDecls(inner, s.decls, store);
        }
        for (const st of s.stmts) this.exec(st, inner, store);
        return;
      }
      case 'assign': {
        if (s.control) this.diag.fail('not-synthesizable', 'A delay or event control inside an assignment is not synthesizable; a testbench feature (coming with the simulator).', s.control.span);
        const lw = this.lvalueWidth(s.lhs, scope);
        const t = this.typeOf(s.rhs, scope);
        const v = this.evalCtx(s.rhs, scope, Math.max(t.w, lw), t.s, store);
        this.writeLvalue(s.lhs, scope, store, cv.resize(v, lw, t.s));
        return;
      }
      case 'if': {
        const c = cv.truth(this.evalSelf(s.cond, scope, store));
        if (cv.known(c) && cv.bigA(c) === 1n) this.exec(s.then, scope, store);
        else if (s.else) this.exec(s.else, scope, store);
        return;
      }
      case 'case': {
        const ts = [s.expr, ...s.items.flatMap((i) => i.labels ?? [])].map((x) => this.typeOf(x, scope));
        const w = Math.max(...ts.map((t) => t.w));
        const sg = ts.every((t) => t.s);
        const v = this.evalCtx(s.expr, scope, w, sg, store);
        let dflt: A.CaseItem | undefined;
        for (const it of s.items) {
          if (!it.labels) {
            dflt = it;
            continue;
          }
          if (it.labels.some((l) => caseMatches(s.flavor, v, this.evalCtx(l, scope, w, sg, store)))) return this.exec(it.body, scope, store);
        }
        if (dflt) this.exec(dflt.body, scope, store);
        return;
      }
      case 'for': {
        this.execAssignHeader(s.init, scope, store);
        let n = 0;
        while (this.truthy(s.cond, scope, store)) {
          if (++n > MAX_LOOP) this.diag.fail('bad-loop', `This loop runs more than ${MAX_LOOP} times in a constant function.`, s.span);
          this.exec(s.body, scope, store);
          this.execAssignHeader(s.step, scope, store);
        }
        return;
      }
      case 'while': {
        let n = 0;
        while (this.truthy(s.cond, scope, store)) {
          if (++n > MAX_LOOP) this.diag.fail('bad-loop', `This loop runs more than ${MAX_LOOP} times in a constant function.`, s.span);
          this.exec(s.body, scope, store);
        }
        return;
      }
      case 'repeat': {
        const n = this.evalInt(s.count, scope, 'A repeat count', store);
        for (let i = 0; i < n; i++) this.exec(s.body, scope, store);
        return;
      }
      case 'sysTask':
        if (isReadmem(s.name)) return this.readmem(s, scope, store);
        if (isIgnorable(s.name) && !store.initial) return;
        return this.diag.fail('not-synthesizable', `The system task ${s.name} is not synthesizable; a testbench feature (coming with the simulator).`, s.span);
      default:
        return this.diag.fail('not-synthesizable', `${STMT_NAMES[s.kind] ?? `A '${s.kind}' statement`} here is not synthesizable; a testbench feature (coming with the simulator).`, s.span);
    }
  }

  private truthy(cond: A.Expr, scope: Scope, store: Store): boolean {
    const c = cv.truth(this.evalSelf(cond, scope, store));
    return cv.known(c) && cv.bigA(c) === 1n;
  }

  private execAssignHeader(a: A.LoopAssign, scope: Scope, store: Store) {
    const lw = this.lvalueWidth(a.lhs, scope);
    const t = this.typeOf(a.rhs, scope);
    const v = this.evalCtx(a.rhs, scope, Math.max(t.w, lw), t.s, store);
    this.writeLvalue(a.lhs, scope, store, cv.resize(v, lw, t.s));
  }

  lvalueWidth(lhs: A.Expr, scope: Scope): number {
    if (lhs.kind === 'concat') return lhs.parts.reduce((n, p) => n + this.lvalueWidth(p, scope), 0);
    if (lhs.kind === 'index') {
      const x = this.entryOf(lhs.base, scope);
      if (x.kind === 'var' && x.mem && lhs.dims.length === 0 && lhs.mode === 'bit') return x.mem.width;
      return this.selectWidth(lhs, scope);
    }
    if (lhs.kind === 'ident' || lhs.kind === 'hier') {
      const x = this.entryOf(lhs, scope);
      if (x.kind === 'var') return x.width;
    }
    return this.diag.fail('bad-assignment', 'This cannot be assigned to.', lhs.span);
  }

  private writeLvalue(lhs: A.Expr, scope: Scope, store: Store, val: CVal) {
    if (lhs.kind === 'concat') {
      let hi = val.width;
      for (const p of lhs.parts) {
        const w = this.lvalueWidth(p, scope);
        hi -= w;
        this.writeLvalue(p, scope, store, cv.slice(val, hi, w));
      }
      return;
    }
    if (lhs.kind === 'ident' || lhs.kind === 'hier') {
      const x = this.entryOf(lhs, scope);
      if (x.kind !== 'var') return this.diag.fail('bad-assignment', 'This cannot be assigned to.', lhs.span);
      store.vars.set(x, cv.withSign(val, x.signed));
      return;
    }
    if (lhs.kind !== 'index') return this.diag.fail('bad-assignment', 'This cannot be assigned to.', lhs.span);
    const x = this.entryOf(lhs.base, scope);
    if (x.kind !== 'var') return this.diag.fail('bad-assignment', 'This cannot be assigned to.', lhs.span);
    if (x.mem) {
      let words = store.mems.get(x);
      if (!words) store.mems.set(x, (words = Array.from({ length: x.mem.depth }, () => cv.allX(x.mem!.width, x.signed))));
      const idx = this.evalInt(lhs.dims.length === 0 ? lhs.hi : lhs.dims[0]!, scope, 'A memory index', store);
      const word = idx - x.mem.base;
      if (word < 0 || word >= x.mem.depth) return;
      if (lhs.dims.length === 0) words[word] = cv.withSign(val, x.signed);
      else words[word] = this.insertBits(words[word]!, { msb: x.msb, lsb: x.lsb, width: x.mem.width }, lhs, scope, val, store);
      return;
    }
    const cur = store.vars.get(x) ?? cv.allX(x.width, x.signed);
    store.vars.set(x, cv.withSign(this.insertBits(cur, x, lhs, scope, val, store), x.signed));
  }

  private insertBits(cur: CVal, info: { msb: number; lsb: number; width: number }, e: A.IndexExpr, scope: Scope, val: CVal, store: Store): CVal {
    const wsel = this.selectWidth(e, scope);
    let lowIndex: number;
    if (e.mode === 'bit') lowIndex = this.evalInt(e.hi, scope, 'A select index', store);
    else if (e.mode === 'range') {
      const hi = this.evalInt(e.hi, scope, 'A part-select bound');
      const lo = this.evalInt(e.lo!, scope, 'A part-select bound');
      lowIndex = info.msb >= info.lsb ? Math.min(hi, lo) : Math.max(hi, lo);
    } else {
      const b = this.evalInt(e.hi, scope, 'A select index', store);
      lowIndex = e.mode === 'plus' ? (info.msb >= info.lsb ? b : b + wsel - 1) : info.msb >= info.lsb ? b - wsel + 1 : b;
    }
    const p = info.msb >= info.lsb ? lowIndex - info.lsb : info.lsb - lowIndex;
    if (p < 0 || p + wsel > info.width) return cur;
    const parts: CVal[] = [];
    if (p + wsel < info.width) parts.push(cv.slice(cur, p + wsel, info.width - p - wsel));
    parts.push(cv.resize(val, wsel, false));
    if (p > 0) parts.push(cv.slice(cur, 0, p));
    return cv.concat(parts);
  }

  // ------------------------------------------------------------ $readmem

  private readmem(s: A.SysTaskStmt, scope: Scope, store: Store) {
    const args = s.args;
    if (args.length < 2 || !args[0] || !args[1]) this.diag.fail('bad-declaration', `${s.name} needs a file name and a memory.`, s.span);
    const nameV = this.evalSelf(args[0], scope, store);
    const fileName = cv.known(nameV) ? bitsToString(cv.toBits(nameV)) : '';
    const target = args[1];
    if (target.kind !== 'ident' && target.kind !== 'hier') this.diag.fail('bad-declaration', `${s.name} needs the name of a memory as its second argument.`, target.span);
    const x = this.entryOf(target, scope);
    if (x.kind !== 'var' || !x.mem) this.diag.fail('bad-declaration', `'${target.name}' is not a memory, so ${s.name} cannot load it.`, target.span);
    const mem = x.mem;
    const text = this.findFile(fileName);
    if (text === undefined) {
      this.diag.warn('ignored', `The file '${fileName}' for ${s.name} is not among the files given to the compiler, so the memory '${x.name}' starts unknown (x).`, s.span);
      return;
    }
    const lo = args[2] ? this.evalInt(args[2], scope, 'A start address') : undefined;
    const hi = args[3] ? this.evalInt(args[3], scope, 'A finish address') : undefined;
    const binary = s.name === '$readmemb';
    let words = store.mems.get(x);
    if (!words) store.mems.set(x, (words = Array.from({ length: mem.depth }, () => cv.allX(mem.width, x.signed))));
    let addr = lo ?? mem.base;
    const last = hi ?? mem.base + mem.depth - 1;
    for (const tok of tokenizeMem(text)) {
      if (tok.startsWith('@')) {
        addr = parseInt(tok.slice(1), 16);
        continue;
      }
      if (addr > last && lo === undefined && hi === undefined && addr >= mem.base + mem.depth) break;
      const digits = tok.replace(/_/g, '');
      let bits: string;
      if (binary) bits = digits.toLowerCase();
      else bits = [...digits.toLowerCase()].map((c) => (c === 'x' ? 'xxxx' : c === 'z' || c === '?' ? 'zzzz' : parseInt(c, 16).toString(2).padStart(4, '0'))).join('');
      bits = bits.length >= mem.width ? bits.slice(bits.length - mem.width) : (/^[xz]/.test(bits) ? bits[0]! : '0').repeat(mem.width - bits.length) + bits;
      const word = addr - mem.base;
      if (word >= 0 && word < mem.depth) words[word] = cv.fromBits(bits, x.signed);
      addr++;
    }
  }

  private findFile(name: string): string | undefined {
    if (name in this.files) return this.files[name];
    const base = name.split('/').pop()!;
    for (const [k, v] of Object.entries(this.files)) if (k.split('/').pop() === base) return v;
    return undefined;
  }
}

// ---------------------------------------------------------------- helpers

const STMT_NAMES: Record<string, string> = {
  timing: 'A delay or event control',
  taskCall: 'A task call',
  wait: "A 'wait' statement",
  forever: "A 'forever' loop",
  trigger: 'An event trigger',
  disable: "A 'disable' statement",
  procAssign: 'A procedural assign, deassign, force or release',
};

export function isReadmem(name: string): boolean {
  return name === '$readmemh' || name === '$readmemb';
}

const IGNORABLE = new Set(['$display', '$write', '$strobe', '$monitor', '$displayb', '$displayh', '$displayo', '$writeb', '$writeh', '$writeo', '$fdisplay', '$fwrite', '$finish', '$stop', '$dumpfile', '$dumpvars', '$monitoron', '$monitoroff', '$info', '$warning', '$error', '$fatal', '$fflush', '$fclose', '$timeformat']);
export const isIgnorable = (name: string) => IGNORABLE.has(name);

/** `case` matching on four-state values: plain `case` needs identical bits, `casez` treats z as a wildcard, `casex` x and z. */
export function caseMatches(flavor: 'case' | 'casez' | 'casex', a: CVal, b: CVal): boolean {
  const ab = cv.bigB(a);
  const bb = cv.bigB(b);
  const aa = cv.bigA(a);
  const ba = cv.bigA(b);
  let wild = 0n;
  const zA = ab & ~aa;
  const zB = bb & ~ba;
  if (flavor === 'casez') wild = zA | zB;
  else if (flavor === 'casex') wild = ab | bb;
  const m = ~wild;
  return ((aa ^ ba) & m) === 0n && ((ab ^ bb) & m) === 0n;
}

function decodeString(text: string): string {
  const body = text.startsWith('"') ? text.slice(1, -1) : text;
  return body.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

function bitsToString(bits: string): string {
  let s = '';
  const padded = bits.padStart(Math.ceil(bits.length / 8) * 8, '0');
  for (let i = 0; i < padded.length; i += 8) {
    const c = parseInt(padded.slice(i, i + 8), 2);
    if (c) s += String.fromCharCode(c);
  }
  return s;
}

function* tokenizeMem(text: string): Generator<string> {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const t of stripped.split(/\s+/)) if (t) yield t;
}

export type { Genvar, Param };
