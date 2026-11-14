/**
 * Multi-bit logic values, up to 32 bits wide.
 *
 * Each bit is in one of five states, held as bit masks:
 *   0 / 1  — a driven level (bit set in `v`)
 *   x      — unknown: driven but undetermined (bit set in `x`)
 *   z      — high impedance: nothing drives it (bit set in `z`)
 *   e      — conflict: two drivers disagree (bit set in `e`)
 * A bit is in at most one of x/z/e; for those bits `v` is 0.
 *
 * Components read z and e inputs as unknown, as a real CMOS input on a
 * floating or fought-over line has no defined level.
 */
export interface Bits {
  readonly w: number;
  readonly v: number;
  readonly x: number;
  readonly z: number;
  readonly e: number;
}

export type BitState = 0 | 1 | 'x' | 'z' | 'e';

export const MAX_WIDTH = 32;

/** All-ones mask for a width (1..32). */
export const mask = (w: number): number => (w >= 32 ? 0xffffffff : (1 << w) - 1) >>> 0;

const make = (w: number, v: number, x = 0, z = 0, e = 0): Bits => {
  const m = mask(w);
  const bad = (x | z | e) & m;
  return { w, v: (v & m & ~bad) >>> 0, x: (x & m) >>> 0, z: (z & m & ~x) >>> 0, e: (e & m & ~x & ~z) >>> 0 };
};

/** A value built from per-state bit masks (v: known ones, x: unknown, z: floating, e: conflict); stray bits are masked off. */
export const fromMasks = make;

export const bits = (w: number, v: number): Bits => make(w, v >>> 0);
export const unknown = (w: number): Bits => make(w, 0, mask(w));
export const floating = (w: number): Bits => make(w, 0, 0, mask(w));
export const ZERO1 = bits(1, 0);
export const ONE1 = bits(1, 1);
export const X1 = unknown(1);

/** Bits with no x, z or e: a plain number. */
export const isKnown = (b: Bits): boolean => (b.x | b.z | b.e) === 0;
/** Bits that a reader cannot interpret (x, z or e). */
export const unknownMask = (b: Bits): number => (b.x | b.z | b.e) >>> 0;

export function bitAt(b: Bits, i: number): BitState {
  const m = 1 << i;
  if (b.e & m) return 'e';
  if (b.x & m) return 'x';
  if (b.z & m) return 'z';
  return b.v & m ? 1 : 0;
}

export function fromStates(states: readonly BitState[]): Bits {
  let v = 0,
    x = 0,
    z = 0,
    e = 0;
  states.forEach((s, i) => {
    const m = 1 << i;
    if (s === 1) v |= m;
    else if (s === 'x') x |= m;
    else if (s === 'z') z |= m;
    else if (s === 'e') e |= m;
  });
  return make(states.length, v, x, z, e);
}

export const toStates = (b: Bits): BitState[] => Array.from({ length: b.w }, (_, i) => bitAt(b, i));

export const sameBits = (a: Bits, b: Bits): boolean => a.w === b.w && a.v === b.v && a.x === b.x && a.z === b.z && a.e === b.e;

/** Unsigned value, or null if any bit is not a known level. */
export const toUnsigned = (b: Bits): number | null => (isKnown(b) ? b.v >>> 0 : null);

/** Two's-complement value, or null if any bit is not known. */
export function toSigned(b: Bits): number | null {
  if (!isKnown(b)) return null;
  if (b.w === 32) return b.v | 0;
  const sign = 1 << (b.w - 1);
  return b.v & sign ? b.v - (1 << b.w) : b.v;
}

/**
 * A value from text, most significant bit first, over 0, 1 and x. Text shorter than `w` is zero-extended on the left,
 * longer text keeps its low bits, and any other character is ignored. Empty text is all zeros.
 */
export function parseBitString(text: string, w: number): Bits {
  const t = text.toLowerCase().replace(/[^01x]/g, '').slice(-w).padStart(w, '0');
  return fromStates(Array.from({ length: w }, (_, i): BitState => (t[w - 1 - i] === 'x' ? 'x' : t[w - 1 - i] === '1' ? 1 : 0)));
}

/** Treat z and e on an input as plain unknowns. */
export const asInput = (b: Bits): Bits => (b.z | b.e ? make(b.w, b.v, b.x | b.z | b.e) : b);

// ---------------------------------------------------------------- bitwise logic (Kleene, per bit)

export function and(vs: readonly Bits[], w: number): Bits {
  let zeros = 0;
  let unk = 0;
  for (const b of vs) {
    const u = unknownMask(b);
    zeros |= ~b.v & ~u;
    unk |= u;
  }
  zeros = (zeros & mask(w)) >>> 0;
  return make(w, ~zeros, unk & ~zeros);
}

export function or(vs: readonly Bits[], w: number): Bits {
  let ones = 0;
  let unk = 0;
  for (const b of vs) {
    ones |= b.v;
    unk |= unknownMask(b);
  }
  return make(w, ones, unk & ~ones);
}

export function xor(vs: readonly Bits[], w: number): Bits {
  let v = 0;
  let unk = 0;
  for (const b of vs) {
    v ^= b.v;
    unk |= unknownMask(b);
  }
  return make(w, v, unk);
}

/** 1 where exactly one input bit is 1 (the "exactly one" reading of a multi-input XOR). */
export function exactlyOne(vs: readonly Bits[], w: number): Bits {
  let seen = 0;
  let twice = 0;
  let unk = 0;
  for (const b of vs) {
    twice |= seen & b.v;
    seen |= b.v;
    unk |= unknownMask(b);
  }
  const ones = seen & ~twice;
  // A known second 1 decides "not exactly one" even if other inputs are unknown.
  return make(w, ones, unk & ~twice);
}

export function not(b: Bits): Bits {
  const u = unknownMask(b);
  return make(b.w, ~b.v, u);
}

// ---------------------------------------------------------------- net resolution

/**
 * Resolve every driver of one net, bit by bit, following the strong-value
 * part of the IEEE 1164 resolution table: z yields to anything, equal levels
 * agree, 0 against 1 is a conflict, and x against anything driven is x.
 * `pull` (a weak level from a pull resistor) applies only to bits left at z.
 */
export function resolve(w: number, drivers: readonly Bits[], pull?: 0 | 1): Bits {
  const m = mask(w);
  let driven = 0;
  let ones = 0;
  let zeros = 0;
  let unk = 0;
  for (const d of drivers) {
    const active = ~d.z & m;
    driven |= active;
    ones |= d.v & active;
    zeros |= ~d.v & ~d.x & ~d.e & active;
    unk |= (d.x | d.e) & active;
  }
  const conflict = ones & zeros & ~unk;
  const undriven = ~driven & m;
  let v = ones & ~conflict & ~unk;
  let z = undriven;
  if (pull !== undefined) {
    if (pull === 1) v |= undriven;
    z = 0;
  }
  // A real conflict (0 vs 1) is reported as e; an x driver makes the bit x.
  return make(w, v, unk, z, conflict);
}

// ---------------------------------------------------------------- formatting

export function formatBits(b: Bits, radix: 'bin' | 'hex' | 'dec' | 'signed' = 'bin'): string {
  if (radix === 'bin' || !isKnown(b)) {
    return toStates(b)
      .reverse()
      .map((s) => (s === 'e' ? 'E' : s === 'z' ? 'Z' : s === 'x' ? 'x' : String(s)))
      .join('');
  }
  if (radix === 'hex') return (b.v >>> 0).toString(16).toUpperCase().padStart(Math.ceil(b.w / 4), '0');
  if (radix === 'signed') return String(toSigned(b));
  return String(b.v >>> 0);
}

export function concat(parts: readonly Bits[]): Bits {
  // parts[0] supplies the least significant bits.
  let w = 0,
    v = 0,
    x = 0,
    z = 0,
    e = 0;
  for (const p of parts) {
    v |= p.v << w;
    x |= p.x << w;
    z |= p.z << w;
    e |= p.e << w;
    w += p.w;
  }
  return make(Math.max(1, w), v, x, z, e);
}

export function slice(b: Bits, from: number, w: number): Bits {
  return make(w, b.v >>> from, b.x >>> from, b.z >>> from, b.e >>> from);
}
