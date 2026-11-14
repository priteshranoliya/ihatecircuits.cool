/**
 * Four-state constants of any width, and the operators on them (IEEE 1364-2005 clause 5).
 *
 * A value is two planes. In `b` a 1 marks an unknown bit, and then `a` tells x (1) from z (0); where `b` is 0,
 * `a` is the bit. A plane is a number up to 32 bits wide and a bigint above that, so the common small constant
 * costs no bigint arithmetic to store. The operators work on bigints and convert at the edges.
 *
 * Operators take operands that are already extended to one width (the caller applies the width and sign rules)
 * and return that width, except comparisons and reductions, which return one bit.
 */

export type Plane = number | bigint;

export interface CVal {
  width: number;
  signed: boolean;
  a: Plane;
  b: Plane;
}

const big = (p: Plane): bigint => (typeof p === 'bigint' ? p : BigInt(p));
const maskOf = (w: number): bigint => (1n << BigInt(w)) - 1n;
const plane = (w: number, v: bigint): Plane => (w <= 32 ? Number(v) : v);

/** Build a value from raw planes, clearing the bits above `width`. */
export function make(width: number, signed: boolean, a: bigint, b: bigint): CVal {
  const m = maskOf(width);
  return { width, signed, a: plane(width, a & m), b: plane(width, b & m) };
}

export const known = (v: CVal): boolean => big(v.b) === 0n;
export const bigA = (v: CVal): bigint => big(v.a);
export const bigB = (v: CVal): bigint => big(v.b);

export function fromBits(bits: string, signed: boolean): CVal {
  let a = 0n;
  let b = 0n;
  for (const ch of bits) {
    a <<= 1n;
    b <<= 1n;
    if (ch === '1') a |= 1n;
    else if (ch === 'x' || ch === 'X') {
      a |= 1n;
      b |= 1n;
    } else if (ch === 'z' || ch === 'Z') b |= 1n;
  }
  return make(bits.length, signed, a, b);
}

export function toBits(v: CVal): string {
  const a = big(v.a);
  const b = big(v.b);
  let s = '';
  for (let i = v.width - 1; i >= 0; i--) {
    const bi = (b >> BigInt(i)) & 1n;
    const ai = (a >> BigInt(i)) & 1n;
    s += bi ? (ai ? 'x' : 'z') : ai ? '1' : '0';
  }
  return s;
}

/** Two's complement of `n` in `width` bits. */
export function fromBig(n: bigint, width: number, signed: boolean): CVal {
  return make(width, signed, n, 0n);
}

export const fromInt = (n: number, width = 32, signed = true): CVal => fromBig(BigInt(n), width, signed);
export const allX = (width: number, signed = false): CVal => make(width, signed, maskOf(width), maskOf(width));
export const allZ = (width: number, signed = false): CVal => make(width, signed, 0n, maskOf(width));

/** The value as an integer, reading the bits as two's complement when the value is signed. Unknown bits count as 0. */
export function toBigInt(v: CVal): bigint {
  const a = big(v.a) & ~big(v.b);
  if (v.signed && v.width > 0 && (a >> BigInt(v.width - 1)) & 1n) return a - (1n << BigInt(v.width));
  return a;
}

/** Signed or unsigned reading chosen by the caller. */
export function toBigIntAs(v: CVal, signed: boolean): bigint {
  return toBigInt({ ...v, signed });
}

export function withSign(v: CVal, signed: boolean): CVal {
  return { ...v, signed };
}

/** Resize to `width` bits; a signed value is sign-extended (an unknown sign bit extends as itself), an unsigned one zero-extended. */
export function resize(v: CVal, width: number, signed: boolean = v.signed): CVal {
  if (width === v.width) return v.signed === signed ? v : { ...v, signed };
  if (width < v.width) return make(width, signed, big(v.a), big(v.b));
  let a = big(v.a);
  let b = big(v.b);
  if (v.signed) {
    const top = BigInt(v.width - 1);
    const fill = maskOf(width) ^ maskOf(v.width);
    if ((a >> top) & 1n) a |= fill;
    if ((b >> top) & 1n) b |= fill;
  }
  return make(width, signed, a, b);
}

// ---------------------------------------------------------------- bitwise

const k1 = (v: CVal) => big(v.a) & ~big(v.b);
const k0 = (v: CVal) => ~big(v.a) & ~big(v.b) & maskOf(v.width);

function fromKnown(width: number, signed: boolean, ones: bigint, zeros: bigint): CVal {
  const m = maskOf(width);
  const unk = ~(ones | zeros) & m;
  return make(width, signed, ones | unk, unk);
}

export const not = (x: CVal): CVal => fromKnown(x.width, x.signed, k0(x), k1(x));
export const and = (x: CVal, y: CVal): CVal => fromKnown(x.width, x.signed && y.signed, k1(x) & k1(y), k0(x) | k0(y));
export const or = (x: CVal, y: CVal): CVal => fromKnown(x.width, x.signed && y.signed, k1(x) | k1(y), k0(x) & k0(y));
export function xor(x: CVal, y: CVal): CVal {
  const unk = big(x.b) | big(y.b);
  return make(x.width, x.signed && y.signed, (big(x.a) ^ big(y.a)) | unk, unk);
}
export const xnor = (x: CVal, y: CVal): CVal => not(xor(x, y));

// ---------------------------------------------------------------- arithmetic

const bothKnown = (x: CVal, y: CVal) => known(x) && known(y);

export function add(x: CVal, y: CVal): CVal {
  if (!bothKnown(x, y)) return allX(x.width, x.signed && y.signed);
  return make(x.width, x.signed && y.signed, big(x.a) + big(y.a), 0n);
}
export function sub(x: CVal, y: CVal): CVal {
  if (!bothKnown(x, y)) return allX(x.width, x.signed && y.signed);
  return make(x.width, x.signed && y.signed, big(x.a) - big(y.a), 0n);
}
export function neg(x: CVal): CVal {
  if (!known(x)) return allX(x.width, x.signed);
  return make(x.width, x.signed, -big(x.a), 0n);
}
export function mul(x: CVal, y: CVal): CVal {
  if (!bothKnown(x, y)) return allX(x.width, x.signed && y.signed);
  return make(x.width, x.signed && y.signed, big(x.a) * big(y.a), 0n);
}

/** Quotient (`rem` false) or remainder, truncating toward zero; the result is signed when both operands are. */
export function divide(x: CVal, y: CVal, rem: boolean): CVal {
  const signed = x.signed && y.signed;
  if (!bothKnown(x, y)) return allX(x.width, signed);
  const a = toBigIntAs(x, signed);
  const b = toBigIntAs(y, signed);
  if (b === 0n) return allX(x.width, signed);
  return make(x.width, signed, rem ? a % b : a / b, 0n);
}

/** `x ** y` for integers (IEEE 5.1.5): a negative exponent gives 0 unless the base is 1 or -1; 0 ** negative is x. */
export function power(x: CVal, y: CVal): CVal {
  const out = x.signed;
  if (!bothKnown(x, y)) return allX(x.width, out);
  const base = toBigIntAs(x, x.signed);
  const exp = toBigIntAs(y, y.signed);
  if (exp < 0n) {
    if (base === 1n) return fromBig(1n, x.width, out);
    if (base === -1n) return fromBig(exp % 2n === 0n ? 1n : -1n, x.width, out);
    if (base === 0n) return allX(x.width, out);
    return fromBig(0n, x.width, out);
  }
  let r = 1n;
  let b = base;
  let e = exp;
  const m = maskOf(x.width);
  while (e > 0n) {
    if (e & 1n) r = (r * b) & m;
    b = (b * b) & m;
    e >>= 1n;
  }
  return make(x.width, out, r, 0n);
}

// ---------------------------------------------------------------- shifts

export function shiftLeft(x: CVal, n: CVal): CVal {
  if (!known(n)) return allX(x.width, x.signed);
  const k = big(n.a);
  if (k >= BigInt(x.width)) return make(x.width, x.signed, 0n, 0n);
  return make(x.width, x.signed, big(x.a) << k, big(x.b) << k);
}

export function shiftRight(x: CVal, n: CVal, arithmetic: boolean): CVal {
  if (!known(n)) return allX(x.width, x.signed);
  const k = big(n.a);
  const w = BigInt(x.width);
  const topA = (big(x.a) >> (w - 1n)) & 1n;
  const topB = (big(x.b) >> (w - 1n)) & 1n;
  const fill = (top: bigint, by: bigint) => (arithmetic && top ? maskOf(x.width) ^ (by >= w ? 0n : maskOf(x.width - Number(by))) : 0n);
  if (k >= w) return make(x.width, x.signed, fill(topA, w), fill(topB, w));
  return make(x.width, x.signed, (big(x.a) >> k) | fill(topA, k), (big(x.b) >> k) | fill(topB, k));
}

// ---------------------------------------------------------------- comparison, reduction, logic

export const bit = (b: 0 | 1 | 'x'): CVal => (b === 'x' ? allX(1) : make(1, false, BigInt(b), 0n));

/** `==`: a known difference decides, otherwise an unknown bit makes it x. */
export function eq(x: CVal, y: CVal): CVal {
  const diff = (k1(x) & k0(y)) | (k0(x) & k1(y));
  if (diff !== 0n) return bit(0);
  if (!bothKnown(x, y)) return bit('x');
  return bit(1);
}
export function ne(x: CVal, y: CVal): CVal {
  const r = eq(x, y);
  return known(r) ? bit(big(r.a) === 1n ? 0 : 1) : r;
}

/** `x < y`, reading both as signed when `signed`. */
export function lessThan(x: CVal, y: CVal, signed: boolean): CVal {
  if (!bothKnown(x, y)) return bit('x');
  return bit(toBigIntAs(x, signed) < toBigIntAs(y, signed) ? 1 : 0);
}

export function reduceAnd(x: CVal): CVal {
  if (k0(x) !== 0n) return bit(0);
  return known(x) ? bit(1) : bit('x');
}
export function reduceOr(x: CVal): CVal {
  if (k1(x) !== 0n) return bit(1);
  return known(x) ? bit(0) : bit('x');
}
export function reduceXor(x: CVal): CVal {
  if (!known(x)) return bit('x');
  let n = big(x.a);
  let p = 0;
  while (n) {
    p ^= Number(n & 1n);
    n >>= 1n;
  }
  return bit(p ? 1 : 0);
}

/** A condition (`if`, `&&`, `?:` select): 1 when any bit is a known 1, 0 when every bit is a known 0, else x. */
export const truth = reduceOr;
export const logicalNot = (x: CVal): CVal => {
  const t = truth(x);
  return known(t) ? bit(big(t.a) === 1n ? 0 : 1) : t;
};

/** `sel ? t : f` with the bitwise merge for an unknown select. */
export function select(sel: CVal, t: CVal, f: CVal): CVal {
  const s = truth(sel);
  if (known(s)) return big(s.a) === 1n ? t : f;
  const same = ~(big(t.a) ^ big(f.a)) & ~(big(t.b) ^ big(f.b)) & maskOf(t.width);
  const unk = ~same & maskOf(t.width);
  return make(t.width, t.signed && f.signed, (big(t.a) & same) | unk, (big(t.b) & same) | unk);
}

// ---------------------------------------------------------------- structure

/** Parts most significant first. The result is unsigned. */
export function concat(parts: CVal[]): CVal {
  let a = 0n;
  let b = 0n;
  let width = 0;
  for (const p of parts) {
    a = (a << BigInt(p.width)) | big(p.a);
    b = (b << BigInt(p.width)) | big(p.b);
    width += p.width;
  }
  return make(width, false, a, b);
}

export function slice(x: CVal, lsb: number, width: number): CVal {
  return make(width, false, big(x.a) >> BigInt(lsb), big(x.b) >> BigInt(lsb));
}

export function replicate(x: CVal, n: number): CVal {
  return concat(Array.from({ length: n }, () => x));
}

/** `bits` over 0/1/x/z with the unknowns replaced, for naming and messages. */
export function describe(v: CVal): string {
  if (!known(v)) return `${v.width}'b${toBits(v)}`;
  return toBigInt(v).toString();
}
