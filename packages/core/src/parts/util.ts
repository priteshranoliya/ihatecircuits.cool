import { type Bits, bitAt, bits, floating, fromStates, isKnown, mask, unknown, type BitState } from '../bits';
import type { Props } from '../types';

/** Helpers shared by component definitions. */

export const w = (p: Props, key = 'bits', fallback = 1) => (typeof p[key] === 'number' ? (p[key] as number) : fallback);

/** A 1-bit value from a JS boolean / 0|1 / unknown. */
export const bit1 = (v: 0 | 1 | boolean | 'x'): Bits => (v === 'x' ? unknown(1) : bits(1, v ? 1 : 0));

/** State of a 1-bit input as 0, 1 or 'x' (z and e read as x). */
export function level(b: Bits): 0 | 1 | 'x' {
  const s = bitAt(b, 0);
  return s === 0 || s === 1 ? s : 'x';
}

export type Trigger = 'rising' | 'falling' | 'high' | 'low';

/**
 * Whether a clock input fires, given its previous and current level.
 * Edge triggers fire on the transition; level triggers are active while the
 * level holds. Returns 'x' when an unknown level means it might have fired.
 */
export function fires(trigger: Trigger, prev: 0 | 1 | 'x', now: 0 | 1 | 'x'): boolean | 'x' {
  switch (trigger) {
    case 'high':
      return now === 'x' ? 'x' : now === 1;
    case 'low':
      return now === 'x' ? 'x' : now === 0;
    case 'falling':
      if (prev === 1 && now === 0) return true;
      if (prev === 0 || now === 1) return false;
      return 'x';
    default:
      if (prev === 0 && now === 1) return true;
      if (prev === 1 || now === 0) return false;
      return 'x';
  }
}

/** Merge two possible results bit by bit: bits that agree keep their value, others become x. */
export function merge(a: Bits, b: Bits): Bits {
  const differ = (a.v ^ b.v) | a.x | b.x | a.z | b.z | a.e | b.e;
  return fromStates(Array.from({ length: a.w }, (_, i): BitState => (differ & (1 << i) ? 'x' : a.v & (1 << i) ? 1 : 0)));
}

/** Parse a hex string prop into a value masked to `width` bits. */
export function hexValue(s: unknown, width: number): number {
  const n = parseInt(String(s ?? '0'), 16);
  return Number.isFinite(n) ? (n & mask(width)) >>> 0 : 0;
}

/** Number of bits needed to index `n` items (at least 1). */
export const indexBits = (n: number) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

export { bits, floating, unknown, isKnown, mask, bitAt, fromStates };
