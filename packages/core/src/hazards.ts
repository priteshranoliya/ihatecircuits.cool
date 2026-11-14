import { covers, minimize, primeImplicants, type Implicant } from './analysis';

/**
 * Static hazard analysis of a two-level (AND-OR) sum of products.
 *
 * A static hazard is a brief glitch on an output that should hold still while
 * one input changes. For a sum of products implemented as AND gates feeding an
 * OR gate:
 *
 *  - There are no static-0 hazards (for a single input change). A product term
 *    that contains both X and X′ never appears in a minimal cover, and every
 *    other term is held at 0 by some literal that does not change, so the OR
 *    output cannot rise while the function stays 0.
 *  - Static-1 hazards exist exactly where two adjacent 1s (minterms that
 *    differ in one variable) are not covered by a COMMON product term. Then
 *    one AND gate turns off while the other has not yet turned on, and the OR
 *    output can drop to 0 for a moment.
 *
 * The cure is the consensus term: add a product term that covers both
 * minterms, built from the literals the two minterms share (for f = AB + A′C
 * the hazard on A when B = C = 1 is removed by adding BC). The extra term is
 * redundant logically but keeps the output held at 1 across the change.
 *
 * Variable 0 is the first (most significant) bit of a minterm, matching the
 * implicant strings of analysis.ts.
 */

export interface StaticHazard {
  /** Index of the variable that changes (0 = first / most significant). */
  variable: number;
  /** The two adjacent minterms, lower first; the variable is 0 in the first and 1 in the second. */
  minterms: [number, number];
  /** The term that would remove the hazard: the literals both minterms share, e.g. "-11" for BC. */
  consensus: Implicant;
}

const bitOf = (n: number, variable: number) => 1 << (n - 1 - variable);

/** Static-1 hazards of the cover: adjacent 1s that no single implicant covers. Ordered by minterm, then variable. */
export function staticHazards(n: number, implicants: readonly Implicant[], ones: readonly number[]): StaticHazard[] {
  const on = new Set(ones);
  const out: StaticHazard[] = [];
  for (const m of [...on].sort((a, b) => a - b)) {
    for (let v = 0; v < n; v++) {
      const bit = bitOf(n, v);
      if (m & bit) continue;
      const other = m | bit;
      if (!on.has(other)) continue;
      if (implicants.some((imp) => covers(imp, m) && covers(imp, other))) continue;
      const bits = m.toString(2).padStart(n, '0');
      out.push({ variable: v, minterms: [m, other], consensus: bits.slice(0, v) + '-' + bits.slice(v + 1) });
    }
  }
  return out;
}

export interface HazardFreeCover {
  /** The minimal cover followed by the added consensus terms. */
  cover: Implicant[];
  /** The plain minimal sum of products. */
  base: Implicant[];
  /** The consensus terms added to remove every static-1 hazard. */
  added: Implicant[];
}

const literalCount = (imp: Implicant) => imp.replace(/-/g, '').length;

/**
 * Minimal cover plus the extra prime implicants needed so that every pair of
 * adjacent 1s shares a product term. Don't-cares may enlarge terms but never
 * create hazard pairs of their own.
 */
export function hazardFreeCover(n: number, ones: readonly number[], dontCares: readonly number[] = []): HazardFreeCover {
  const base = minimize(n, ones, dontCares);
  const primes = primeImplicants(n, ones, dontCares);
  const cover = [...base];
  const added: Implicant[] = [];
  for (;;) {
    const pending = staticHazards(n, cover, ones);
    if (pending.length === 0) break;
    // Take the prime covering the most pending pairs; fewer literals, then lexical order, break ties.
    let best: Implicant | null = null;
    let bestCount = 0;
    for (const p of primes) {
      if (cover.includes(p)) continue;
      const count = pending.filter((h) => covers(p, h.minterms[0]) && covers(p, h.minterms[1])).length;
      if (count > bestCount || (count === bestCount && count > 0 && best !== null && (literalCount(p) < literalCount(best) || (literalCount(p) === literalCount(best) && p < best)))) {
        best = p;
        bestCount = count;
      }
    }
    // Every adjacent pair of 1s lies inside some prime implicant, so a candidate always exists.
    if (!best) throw new Error('No prime implicant covers a hazard pair');
    cover.push(best);
    added.push(best);
  }
  return { cover, base, added };
}
