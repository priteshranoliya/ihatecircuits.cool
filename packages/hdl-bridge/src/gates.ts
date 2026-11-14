import type { Cell, NetId } from '@ihatecircuits/hdl';
import { type Ctx, powerOnProp } from './ctx';
import { type GB, type Src, type SupportLib } from './gb';

/**
 * The gates view: word-level cells built from basic gates (and, or, not, xor, mux) and single-bit
 * flip-flops and latches. Arithmetic and comparison cells become support circuits of their own, so a
 * module stays readable and a student can open `add8` and see eight full adders, and open `fa`
 * and see the gates. Support circuits are shared: every `add8` in the project is the same circuit.
 *
 * What each construction does on unknown inputs. The ripple adders, the comparators and the shifters
 * keep what they can: a bit of a sum stays known while no unknown bit has reached it. The multiplier
 * and the dividers may give any value where the IR says x, which the comparison allows.
 */

const log2ceil = (n: number) => Math.max(0, Math.ceil(Math.log2(n)));

// ---------------------------------------------------------------- support circuits

export function fullAdder(lib: SupportLib): string {
  return lib.circuit('fa', 'fa', (b) => {
    const [a, x, c] = [b.input('a', 1), b.input('b', 1), b.input('ci', 1)];
    const t = b.xor(a, x);
    b.output('s', b.xor(t, c), 1);
    b.output('co', b.or(b.and(a, x), b.and(t, c)), 1);
  });
}

/** Ripple-carry addition of two equally wide bit lists. Without `cin` the lowest bit is a half adder. */
export function ripple(b: GB, fa: string, a: Src[], x: Src[], cin: Src | undefined, tag: string): { sum: Src[]; cout: Src } {
  const sum: Src[] = [];
  let carry = cin;
  a.forEach((bit, i) => {
    if (carry === undefined) {
      sum.push(b.xor(bit, x[i]!));
      carry = b.and(bit, x[i]!);
      return;
    }
    const r = b.instance(fa, `${tag}${i}`, { a: bit, b: x[i]!, ci: carry }, ['s', 'co']);
    sum.push(r.s!);
    carry = r.co!;
  });
  return { sum, cout: carry! };
}

export function adderCircuit(lib: SupportLib, n: number): string {
  const fa = fullAdder(lib);
  return lib.circuit(`add${n}`, `add${n}`, (b) => {
    const a = b.inputBits('a', n);
    const x = b.inputBits('b', n);
    b.outputBits('s', ripple(b, fa, a, x, undefined, 'fa').sum);
  });
}

/** a - b as a + ~b + 1. */
export function subtractorCircuit(lib: SupportLib, n: number): string {
  const fa = fullAdder(lib);
  return lib.circuit(`sub${n}`, `sub${n}`, (b) => {
    const a = b.inputBits('a', n);
    const x = b.inputBits('b', n).map((bit) => b.not(bit));
    b.outputBits('d', ripple(b, fa, a, x, b.konst(1), 'fa').sum);
  });
}

/** Two's complement negation: bit i flips when any lower bit is 1. */
export function negatorCircuit(lib: SupportLib, n: number): string {
  return lib.circuit(`neg${n}`, `neg${n}`, (b) => {
    const a = b.inputBits('a', n);
    const out: Src[] = [a[0]!];
    let seen: Src = a[0]!;
    for (let i = 1; i < n; i++) {
      out.push(b.xor(a[i]!, seen));
      if (i < n - 1) seen = b.or(seen, a[i]!);
    }
    b.outputBits('y', out);
  });
}

/** Array multiplier: row i adds `a & b[i]`, shifted left by i, into the running sum; only the low n bits are kept. */
export function multiplierCircuit(lib: SupportLib, n: number): string {
  const fa = fullAdder(lib);
  return lib.circuit(`mul${n}`, `mul${n}`, (b) => {
    const a = b.inputBits('a', n);
    const x = b.inputBits('b', n);
    let acc: Src[] = a.map((bit) => b.and(bit, x[0]!));
    for (let i = 1; i < n; i++) {
      const row = a.slice(0, n - i).map((bit) => b.and(bit, x[i]!));
      acc = [...acc.slice(0, i), ...ripple(b, fa, acc.slice(i), row, undefined, `r${i}_`).sum];
    }
    b.outputBits('p', acc);
  });
}

/** Restoring divider: each step shifts the next dividend bit into the remainder and subtracts the divisor when it fits. */
export function unsignedDividerCircuit(lib: SupportLib, n: number): string {
  const fa = fullAdder(lib);
  return lib.circuit(`divu${n}`, `divu${n}`, (b) => {
    const a = b.inputBits('a', n);
    const d = b.inputBits('b', n);
    const notD = d.map((bit) => b.not(bit));
    let r: Src[] = b.fan(b.konst(0, n), n);
    const q: Src[] = Array(n);
    for (let i = n - 1; i >= 0; i--) {
      const t = [a[i]!, ...r];
      const { sum, cout } = ripple(b, fa, t, [...notD, b.konst(1)], b.konst(1), `s${i}_`);
      q[i] = cout;
      r = t.slice(0, n).map((bit, j) => b.mux(cout, bit, sum[j]!));
    }
    b.outputBits('q', q);
    b.outputBits('r', r);
  });
}

/** Signed division on magnitudes: the quotient is negative when the signs differ, the remainder takes the dividend's sign. */
export function signedDividerCircuit(lib: SupportLib, n: number): string {
  const neg = negatorCircuit(lib, n);
  const divu = unsignedDividerCircuit(lib, n);
  return lib.circuit(`divs${n}`, `divs${n}`, (b) => {
    const a = b.input('a', n);
    const d = b.input('b', n);
    const sa = b.fan(a, n)[n - 1]!;
    const sd = b.fan(d, n)[n - 1]!;
    const abs = (x: Src, sign: Src, tag: string) => b.mux(sign, x, b.instance(neg, tag, { a: x }, ['y']).y!, n);
    const { q, r } = b.instance(divu, 'divu', { a: abs(a, sa, 'nega'), b: abs(d, sd, 'negb') }, ['q', 'r']);
    const flip = (x: Src, sign: Src, tag: string) => b.mux(sign, x, b.instance(neg, tag, { a: x }, ['y']).y!, n);
    b.output('q', flip(q!, b.xor(sa, sd), 'negq'), n);
    b.output('r', flip(r!, sa, 'negr'), n);
  });
}

/** Unsigned (or two's complement, by flipping both sign bits) less-than: from the low bit up, the highest differing bit decides. */
export function lessCircuit(lib: SupportLib, n: number, signed: boolean): string {
  const name = `${signed ? 'lts' : 'ltu'}${n}`;
  return lib.circuit(name, name, (b) => {
    let a = b.inputBits('a', n);
    let x = b.inputBits('b', n);
    if (signed) {
      a = [...a.slice(0, n - 1), b.not(a[n - 1]!)];
      x = [...x.slice(0, n - 1), b.not(x[n - 1]!)];
    }
    let lt: Src = b.and(b.not(a[0]!), x[0]!);
    for (let i = 1; i < n; i++) lt = b.mux(b.xor(a[i]!, x[i]!), lt, x[i]!);
    b.output('lt', lt, 1);
  });
}

/**
 * Barrel shifter. Stage k shifts by 2^k when bit k of the amount is set. An amount with bits above those
 * the stages cover is at least the width, so it selects the fill instead.
 */
export function shifterCircuit(lib: SupportLib, kind: 'shl' | 'shr' | 'sshr', n: number, amountWidth: number): string {
  const name = `${kind}${n}_${amountWidth}`;
  return lib.circuit(name, name, (b) => {
    const a = b.inputBits('a', n);
    const amount = b.inputBits('n', amountWidth);
    const stages = Math.min(amountWidth, log2ceil(n));
    const fill: Src = kind === 'sshr' ? a[n - 1]! : b.konst(0);
    let cur = a;
    for (let k = 0; k < stages; k++) {
      const d = 1 << k;
      const prev = cur;
      cur = prev.map((bit, i) => {
        const from = kind === 'shl' ? i - d : i + d;
        const moved = from >= 0 && from < n ? prev[from]! : fill;
        return b.mux(amount[k]!, bit, moved);
      });
    }
    if (amountWidth > stages) {
      const big = b.tree('or', amount.slice(stages));
      cur = cur.map((bit) => b.mux(big, bit, fill));
    }
    b.outputBits('y', cur);
  });
}

// ---------------------------------------------------------------- sequential elements one bit at a time

export interface BitDffOptions {
  trigger: 'rising' | 'falling';
  clk: Src;
  /** Source of the load value. Absent when the caller wires `d` itself. */
  d?: Src;
  set?: Src;
  clr?: Src;
  label?: string;
  /** Power-on value of the bit: '0', '1' or 'x'. Absent means the project's power-on 0. */
  init?: string;
}

/** A one-bit D flip-flop. Returns its Q pin and the part, so a caller can wire D later (a register with an enable feeds Q back). */
export function bitDff(b: GB, o: BitDffOptions): { q: Src; part: number } {
  const part = b.g.add('dff', { trigger: o.trigger, ...(o.init ? { init: o.init } : {}) }, o.label ?? '');
  b.connect(o.clk, { part, pin: 'clk' });
  if (o.d) b.connect(o.d, { part, pin: 'd' });
  if (o.set) b.connect(o.set, { part, pin: 'set' });
  if (o.clr) b.connect(o.clr, { part, pin: 'clr' });
  return { q: { part, pin: 'q' }, part };
}

/**
 * A register of single-bit flip-flops with optional asynchronous reset to `value` (MSB first). Bits that reset to 0
 * use CLR and bits that reset to 1 use SET, so only one of the two is ever connected on a bit and CLR winning over
 * SET never matters. `active` is the reset signal at its active-high level.
 */
export function bitwiseRegister(b: GB, width: number, d: Src, clk: Src, trigger: 'rising' | 'falling', reset?: { active: Src; value: string }, label = '', init?: string): Src {
  const dBits = b.fan(d, width);
  const start = powerOnProp(init);
  const q = dBits.map((bit, i) => {
    const value = reset?.value[width - 1 - i];
    return bitDff(b, { trigger, clk, d: bit, ...(reset && value === '1' ? { set: reset.active } : {}), ...(reset && value === '0' ? { clr: reset.active } : {}), label: label && width > 1 ? `${label}[${i}]` : label, ...(start ? { init: start[width - 1 - i]! } : {}) }).q;
  });
  return b.join(q);
}

/** A level-sensitive latch, one D latch per bit, transparent while `en` is 1. */
export function bitwiseLatch(b: GB, width: number, d: Src, en: Src, init?: string): Src {
  const dBits = b.fan(d, width);
  const start = powerOnProp(init);
  const q = dBits.map((bit, i) => {
    const part = b.g.add('dlatch', start ? { init: start[width - 1 - i]! } : {});
    b.connect(bit, { part, pin: 'd' });
    b.connect(en, { part, pin: 'en' });
    return { part, pin: 'q' };
  });
  return b.join(q);
}

/** `net` as a bus-wide mux select helper: bit `i` of a net. */
export const bitOf = (b: GB, net: Src, width: number, i: number): Src => b.fan(net, width)[i]!;

// ---------------------------------------------------------------- cells

export function gatesCell(ctx: Ctx, cell: Cell): boolean {
  const { b, lib } = ctx;
  const w = (n: NetId) => ctx.width(n);
  const net = ctx.net;
  switch (cell.kind) {
    case 'add':
      ctx.drive(cell.out, b.instance(adderCircuit(lib, w(cell.out)), 'add', { a: net(cell.a), b: net(cell.b) }, ['s']).s!);
      return true;
    case 'sub':
      ctx.drive(cell.out, b.instance(subtractorCircuit(lib, w(cell.out)), 'sub', { a: net(cell.a), b: net(cell.b) }, ['d']).d!);
      return true;
    case 'mul':
      ctx.drive(cell.out, b.instance(multiplierCircuit(lib, w(cell.out)), 'mul', { a: net(cell.a), b: net(cell.b) }, ['p']).p!);
      return true;
    case 'divu':
    case 'remu': {
      const r = b.instance(unsignedDividerCircuit(lib, w(cell.out)), cell.kind, { a: net(cell.a), b: net(cell.b) }, ['q', 'r']);
      ctx.drive(cell.out, cell.kind === 'divu' ? r.q! : r.r!);
      return true;
    }
    case 'divs':
    case 'rems': {
      const r = b.instance(signedDividerCircuit(lib, w(cell.out)), cell.kind, { a: net(cell.a), b: net(cell.b) }, ['q', 'r']);
      ctx.drive(cell.out, cell.kind === 'divs' ? r.q! : r.r!);
      return true;
    }
    case 'ltu':
    case 'lts':
      ctx.drive(cell.out, b.instance(lessCircuit(lib, w(cell.a), cell.kind === 'lts'), cell.kind, { a: net(cell.a), b: net(cell.b) }, ['lt']).lt!);
      return true;
    case 'shl':
    case 'shr':
    case 'sshr':
      ctx.drive(cell.out, b.instance(shifterCircuit(lib, cell.kind, w(cell.a), w(cell.amount)), cell.kind, { a: net(cell.a), n: net(cell.amount) }, ['y']).y!);
      return true;
    default:
      return false;
  }
}

