import { type Bits, bitAt, bits, fromMasks, fromStates, isKnown, mask, unknown, unknownMask, xor, type BitState } from '../bits';
import { BITS, DELAY, chip, layoutFrom, range, type ComponentDef, type PinSpec } from '../library';
import type { Props } from '../types';
import { indexBits, w } from './util';

/**
 * Arithmetic parts. Operands are unsigned unless a "numeric" property says otherwise.
 *
 * Adders and subtractors evaluate partially: result bits below the lowest
 * unknown input bit are exact, and everything from there up is x (a ripple
 * circuit would behave the same way). The multiplier and divider treat any
 * unknown input bit as making the whole result unknown.
 */

const TWO = (n: number) => (n < 31 ? 1 << n : 2 ** n);
const ALL_X = (width: number) => unknown(width);
const num = (b: Bits) => b.v >>> 0;
const lowPart = (b: Bits, m: number) => (b.v & m) >>> 0;
/** `width` bits where the low `lowKnown` bits come from `v` and the rest are x. */
const xBits = (width: number, lowKnown: number, v: number): Bits => {
  const known = mask(Math.min(lowKnown, width));
  return fromMasks(width, v & known, ~known);
};

const CIN_PIN = (name: string, label: string): PinSpec => [name, label, 1, { floatAs: 0 }];

/** Number of low bits of a+b+cin-style inputs that are fully known (0 if the carry-in is unknown). */
function knownLow(width: number, carry: Bits, ...ops: Bits[]): number {
  if (!isKnown(carry)) return 0;
  const u = ops.reduce((m, b) => m | unknownMask(b), 0) & mask(width);
  if (u === 0) return width;
  return 31 - Math.clz32(u & -u);
}

// ---------------------------------------------------------------- adder / subtractor

const adder: ComponentDef = {
  type: 'adder',
  name: 'Adder',
  category: 'Arithmetic',
  description: 'Adds two numbers plus a carry in. Gives the sum (same width as the inputs) and the carry out. Unknown inputs only spoil the sum bits at and above the first unknown bit.',
  keywords: ['add', 'plus', 'sum', 'carry', 'ripple', 'full adder'],
  title: () => '+',
  props: [BITS(8), DELAY],
  ...layoutFrom((p) => chip([['a', 'A', w(p)], ['b', 'B', w(p)], CIN_PIN('cin', 'Cin')], [['s', 'Σ', w(p)], ['cout', 'Cout']], 40)),
  eval: (ctx) => {
    const width = w(ctx.props);
    const a = ctx.get('a'), b = ctx.get('b'), c = ctx.get('cin');
    const k = knownLow(width, c, a, b);
    const m = mask(k);
    const total = lowPart(a, m) + lowPart(b, m) + (num(c) & 1);
    const sum = xBits(width, k, total % TWO(k));
    return { out: { s: sum, cout: k === width ? bits(1, total >= TWO(width) ? 1 : 0) : unknown(1) } };
  },
};

const subtractor: ComponentDef = {
  type: 'subtractor',
  name: 'Subtractor',
  category: 'Arithmetic',
  description: 'Computes A − B − borrow in. Gives the difference (wrapping around) and a borrow out that is 1 when the unsigned result went below zero.',
  keywords: ['subtract', 'minus', 'difference', 'borrow'],
  title: () => '−',
  props: [BITS(8), DELAY],
  ...layoutFrom((p) => chip([['a', 'A', w(p)], ['b', 'B', w(p)], CIN_PIN('bin', 'Bin')], [['d', 'Δ', w(p)], ['bout', 'Bout']], 40)),
  eval: (ctx) => {
    const width = w(ctx.props);
    const a = ctx.get('a'), b = ctx.get('b'), c = ctx.get('bin');
    const k = knownLow(width, c, a, b);
    const m = mask(k);
    const t = lowPart(a, m) - lowPart(b, m) - (num(c) & 1);
    const diff = xBits(width, k, ((t % TWO(k)) + TWO(k)) % TWO(k));
    return { out: { d: diff, bout: k === width ? bits(1, t < 0 ? 1 : 0) : unknown(1) } };
  },
};

// ---------------------------------------------------------------- multiplier / divider

/** Low `width` bits of a BigInt as a number. */
const low = (n: bigint, width: number) => Number(BigInt.asUintN(width, n));

const multiplier: ComponentDef = {
  type: 'multiplier',
  name: 'Multiplier',
  category: 'Arithmetic',
  description: 'Multiplies two unsigned numbers and adds a carry-in value. The full product is split into a low half (P) and a high half (Hi), so nothing overflows. Any unknown input makes both halves unknown.',
  keywords: ['multiply', 'times', 'product', 'mac', 'mul'],
  title: () => '×',
  props: [BITS(8), DELAY],
  ...layoutFrom((p) => chip([['a', 'A', w(p)], ['b', 'B', w(p)], ['cin', 'Cin', w(p), { floatAs: 0 }]], [['p', 'P', w(p)], ['hi', 'Hi', w(p)]], 40)),
  eval: (ctx) => {
    const width = w(ctx.props);
    const a = ctx.get('a'), b = ctx.get('b'), c = ctx.get('cin');
    if (!isKnown(a) || !isKnown(b) || !isKnown(c)) return { out: { p: ALL_X(width), hi: ALL_X(width) } };
    const prod = BigInt(num(a)) * BigInt(num(b)) + BigInt(num(c));
    return { out: { p: bits(width, low(prod, width)), hi: bits(width, low(prod >> BigInt(width), width)) } };
  },
};

const divider: ComponentDef = {
  type: 'divider',
  name: 'Divider',
  category: 'Arithmetic',
  description:
    'Divides an unsigned dividend (Hi:A, with Hi as the upper half) by B, giving the quotient (low bits only) and the remainder. Dividing by zero follows the RISC-V convention: the quotient is all 1s and the remainder is the dividend. Any unknown input makes both outputs unknown.',
  keywords: ['divide', 'quotient', 'remainder', 'modulo', 'mod', 'div'],
  title: () => '÷',
  props: [BITS(8), DELAY],
  ...layoutFrom((p) => chip([['a', 'A', w(p)], ['hi', 'Hi', w(p), { floatAs: 0 }], ['b', 'B', w(p)]], [['q', 'Q', w(p)], ['r', 'R', w(p)]], 40)),
  eval: (ctx) => {
    const width = w(ctx.props);
    const a = ctx.get('a'), hi = ctx.get('hi'), b = ctx.get('b');
    if (!isKnown(a) || !isKnown(hi) || !isKnown(b)) return { out: { q: ALL_X(width), r: ALL_X(width) } };
    const dividend = (BigInt(num(hi)) << BigInt(width)) | BigInt(num(a));
    // Divide by zero: quotient all ones, remainder = low half of the dividend (as RISC-V does).
    if (num(b) === 0) return { out: { q: bits(width, mask(width)), r: bits(width, num(a)) } };
    const d = BigInt(num(b));
    return { out: { q: bits(width, low(dividend / d, width)), r: bits(width, low(dividend % d, width)) } };
  },
};

// ---------------------------------------------------------------- negator

const negator: ComponentDef = {
  type: 'negator',
  name: 'Negator',
  category: 'Arithmetic',
  description: 'Two\'s complement negation: flips the sign of a signed number. The most negative value has no positive twin, so it maps to itself, and 0 stays 0.',
  keywords: ['negate', 'minus', 'twos complement', 'invert sign', 'neg'],
  title: () => '−x',
  props: [BITS(8), DELAY],
  ...layoutFrom((p) => chip([['a', 'A', w(p)]], [['y', '−A', w(p)]], 40)),
  eval: (ctx) => {
    const width = w(ctx.props);
    const a = ctx.get('a');
    // Bit i of -a is a_i flipped when any lower bit is 1: track that "seen a 1" flag with unknowns.
    let seen: 0 | 1 | 'x' = 0;
    const out = range(width).map((i): BitState => {
      const s = bitAt(a, i) as 0 | 1 | 'x';
      const r: BitState = seen === 'x' || s === 'x' ? 'x' : ((s ^ seen) as 0 | 1);
      seen = seen === 1 || s === 1 ? 1 : seen === 'x' || s === 'x' ? 'x' : 0;
      return r;
    });
    return { out: { y: fromStates(out) } };
  },
};

// ---------------------------------------------------------------- comparator

const comparator: ComponentDef = {
  type: 'comparator',
  name: 'Comparator',
  category: 'Arithmetic',
  description: 'Compares A with B and raises one of three outputs: greater, equal or less. Works on unsigned or signed (two\'s complement) numbers. If an unknown bit is reached before the two numbers differ, all outputs are unknown.',
  keywords: ['compare', 'greater', 'less', 'equal', 'magnitude', 'cmp', 'equality'],
  title: () => 'CMP',
  props: [
    BITS(8),
    {
      key: 'numeric',
      label: 'Number type',
      kind: 'enum',
      default: 'unsigned',
      options: [
        { value: 'unsigned', label: 'Unsigned' },
        { value: 'signed', label: 'Signed (two\'s complement)' },
      ],
    },
    DELAY,
  ],
  ...layoutFrom((p) => chip([['a', 'A', w(p)], ['b', 'B', w(p)]], [['gt', '>'], ['eq', '='], ['lt', '<']], 40)),
  eval: (ctx) => {
    const width = w(ctx.props);
    const signed = ctx.props.numeric === 'signed';
    const a = ctx.get('a'), b = ctx.get('b');
    const u = (unknownMask(a) | unknownMask(b)) >>> 0;
    const res = (g: number, e: number, l: number) => ({ out: { gt: bits(1, g), eq: bits(1, e), lt: bits(1, l) } });
    for (let i = width - 1; i >= 0; i--) {
      if (u & (1 << i)) return { out: { gt: unknown(1), eq: unknown(1), lt: unknown(1) } };
      const ai = (a.v >>> i) & 1, bi = (b.v >>> i) & 1;
      if (ai !== bi) {
        // In signed mode the top bit has reversed meaning: a 1 there is the smaller number.
        const aBigger = (ai === 1) !== (signed && i === width - 1);
        return aBigger ? res(1, 0, 0) : res(0, 0, 1);
      }
    }
    return res(0, 1, 0);
  },
};

// ---------------------------------------------------------------- shifter

const MODES: Record<string, string> = { sll: 'SLL', srl: 'SRL', sra: 'SRA', rol: 'ROL', ror: 'ROR' };

const shifter: ComponentDef = {
  type: 'shifter',
  name: 'Shifter',
  category: 'Arithmetic',
  description:
    'Shifts or rotates a value by a number of places. Logical shifts fill with 0, the arithmetic right shift copies the sign bit, and rotates wrap around. Shifting by the width or more empties a logical shift (or fills with the sign), and rotates go round modulo the width. Unknown distance gives all unknown.',
  keywords: ['shift', 'rotate', 'barrel', 'left', 'right', 'sll', 'srl', 'sra', 'rol', 'ror'],
  title: (p) => MODES[String(p.mode)] ?? 'SHF',
  props: [
    BITS(8),
    {
      key: 'mode',
      label: 'Operation',
      kind: 'enum',
      default: 'sll',
      options: [
        { value: 'sll', label: 'Shift left (fill 0)' },
        { value: 'srl', label: 'Shift right (fill 0)' },
        { value: 'sra', label: 'Shift right (copy sign)' },
        { value: 'rol', label: 'Rotate left' },
        { value: 'ror', label: 'Rotate right' },
      ],
    },
    DELAY,
  ],
  ...layoutFrom((p) => chip([['a', 'A', w(p)], ['n', 'N', indexBits(w(p))]], [['y', '', w(p)]], 40)),
  eval: (ctx) => {
    const width = w(ctx.props);
    const a = ctx.get('a');
    const n = ctx.get('n');
    if (!isKnown(n)) return { out: { y: unknown(width) } };
    const d = num(n);
    const mode = String(ctx.props.mode);
    const at = (i: number): BitState => bitAt(a, i);
    const src = (i: number): BitState => {
      switch (mode) {
        case 'srl':
          return i + d < width ? at(i + d) : 0;
        case 'sra':
          return at(Math.min(width - 1, i + d));
        case 'rol':
          return at((((i - d) % width) + width) % width);
        case 'ror':
          return at((i + d) % width);
        default:
          return i - d >= 0 ? at(i - d) : 0;
      }
    };
    return { out: { y: fromStates(range(width).map(src)) } };
  },
};

// ---------------------------------------------------------------- bit adder (population count)

const countBits = (p: Props) => Math.max(1, Math.ceil(Math.log2(w(p, 'inputs', 2) * w(p) + 1)));

const bitadder: ComponentDef = {
  type: 'bitadder',
  name: 'Bit counter',
  category: 'Arithmetic',
  description: 'Counts how many of all its input bits are 1 (a population count). With unknown bits, an output bit stays known only if it is the same for every possible count.',
  keywords: ['popcount', 'population count', 'ones count', 'hamming weight', 'bit adder', 'count ones'],
  title: () => 'Σ1',
  props: [BITS(8), { key: 'inputs', label: 'Inputs', kind: 'int', default: 1, min: 1, max: 8 }, DELAY],
  ...layoutFrom((p) => chip(range(w(p, 'inputs', 1)).map((i): PinSpec => [`in${i}`, '', w(p)]), [['y', '', countBits(p)]], 40)),
  eval: (ctx) => {
    const ow = countBits(ctx.props);
    let lo = 0, hi = 0;
    for (let i = 0; i < w(ctx.props, 'inputs', 1); i++) {
      const b = ctx.get(`in${i}`);
      const ones = popcount(b.v);
      lo += ones;
      hi += ones + popcount(unknownMask(b) & mask(b.w));
    }
    // A bit is known only if it is constant across every count from lo to hi.
    const states = range(ow).map((i): BitState => {
      const first = (lo >> i) & 1;
      for (let c = lo + 1; c <= hi; c++) if (((c >> i) & 1) !== first) return 'x';
      return first as 0 | 1;
    });
    return { out: { y: fromStates(states) } };
  },
};

function popcount(n: number): number {
  let c = 0;
  for (let v = n >>> 0; v; v &= v - 1) c++;
  return c;
}

// ---------------------------------------------------------------- bit finder

const bitfinder: ComponentDef = {
  type: 'bitfinder',
  name: 'Bit finder',
  category: 'Arithmetic',
  description: 'Finds the position of the lowest or highest 1 (or 0) in a value. "Found" tells whether there was one; if not, the index is 0. An unknown bit met before the target makes both outputs unknown.',
  keywords: ['find first set', 'ffs', 'clz', 'ctz', 'leading zeros', 'trailing zeros', 'lowest', 'highest', 'priority'],
  title: () => 'FND',
  props: [
    BITS(8),
    {
      key: 'mode',
      label: 'Find',
      kind: 'enum',
      default: 'low1',
      options: [
        { value: 'low1', label: 'Lowest 1' },
        { value: 'high1', label: 'Highest 1' },
        { value: 'low0', label: 'Lowest 0' },
        { value: 'high0', label: 'Highest 0' },
      ],
    },
    DELAY,
  ],
  ...layoutFrom((p) => chip([['a', 'A', w(p)]], [['index', 'Idx', indexBits(w(p))], ['found', 'Ok']], 40)),
  eval: (ctx) => {
    const width = w(ctx.props);
    const ib = indexBits(width);
    const mode = String(ctx.props.mode);
    const target = mode.endsWith('1') ? 1 : 0;
    const a = ctx.get('a');
    const order = mode.startsWith('low') ? range(width) : range(width).reverse();
    for (const i of order) {
      const s = bitAt(a, i);
      if (s === target) return { out: { index: bits(ib, i), found: bits(1, 1) } };
      if (s !== (1 - target)) return { out: { index: unknown(ib), found: unknown(1) } };
    }
    return { out: { index: bits(ib, 0), found: bits(1, 0) } };
  },
};

// ---------------------------------------------------------------- Gray code

const gray: ComponentDef = {
  type: 'gray',
  name: 'Gray code converter',
  category: 'Arithmetic',
  description: 'Converts between plain binary and Gray code, where consecutive numbers differ in exactly one bit. Choose which direction it converts.',
  keywords: ['gray code', 'reflected binary', 'encoder', 'rotary', 'binary to gray', 'gray to binary'],
  title: (p) => (p.direction === 'fromGray' ? 'G→B' : 'B→G'),
  props: [
    BITS(4),
    {
      key: 'direction',
      label: 'Direction',
      kind: 'enum',
      default: 'toGray',
      options: [
        { value: 'toGray', label: 'Binary to Gray' },
        { value: 'fromGray', label: 'Gray to binary' },
      ],
    },
    DELAY,
  ],
  ...layoutFrom((p) => chip([['a', 'In', w(p)]], [['y', 'Out', w(p)]], 40)),
  eval: (ctx) => {
    const width = w(ctx.props);
    const a = ctx.get('a');
    if (ctx.props.direction !== 'fromGray') {
      // g = b XOR (b >> 1)
      const shifted = bits(width, 0);
      const up: Bits = { ...shifted, w: width, v: a.v >>> 1, x: a.x >>> 1 };
      return { out: { y: xor([a, up], width) } };
    }
    // Each binary bit is the XOR of all Gray bits at and above it.
    let acc: 0 | 1 | 'x' = 0;
    const out: BitState[] = Array(width);
    for (let i = width - 1; i >= 0; i--) {
      const s = bitAt(a, i) as 0 | 1 | 'x';
      acc = acc === 'x' || s === 'x' ? 'x' : ((acc ^ s) as 0 | 1);
      out[i] = acc;
    }
    return { out: { y: fromStates(out) } };
  },
};

export const ARITHMETIC: ComponentDef[] = [adder, subtractor, multiplier, divider, negator, comparator, shifter, bitadder, bitfinder, gray];
