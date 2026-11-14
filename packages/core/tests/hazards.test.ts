import { describe, expect, it } from 'vitest';
import { covers, evaluateSop, formatSop, minimize, primeImplicants } from '../src/analysis';
import { hazardFreeCover, staticHazards } from '../src/hazards';

const names3 = ['A', 'B', 'C'];

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe('static-1 hazards', () => {
  it('textbook f = AB + A′C has a hazard on A when B = C = 1, cured by BC', () => {
    // Variables A,B,C; f = AB + A'C → minterms 3 (011), 5 (101)? A'C: 001,011 ; AB: 110,111
    const ones = [1, 3, 6, 7];
    const cover = ['11-', '0-1'];
    for (const m of [0, 1, 2, 3, 4, 5, 6, 7]) expect(evaluateSop(cover, m)).toBe(ones.includes(m) ? 1 : 0);
    const h = staticHazards(3, cover, ones);
    expect(h).toEqual([{ variable: 0, minterms: [3, 7], consensus: '-11' }]);
    expect(formatSop([h[0].consensus], names3)).toBe('BC');
    const fixed = hazardFreeCover(3, ones);
    expect(fixed.added).toEqual(['-11']);
    expect(staticHazards(3, fixed.cover, ones)).toEqual([]);
    expect([...fixed.base].sort()).toEqual([...cover].sort());
  });

  it('a single implicant covering both minterms means no hazard', () => {
    expect(staticHazards(3, ['--1'], [1, 3, 5, 7])).toEqual([]);
    expect(staticHazards(2, ['--'], [0, 1, 2, 3])).toEqual([]);
  });

  it('reports every uncovered adjacent pair, ordered by minterm then variable', () => {
    // Two isolated minterm terms next to each other on two variables: f = A'B'C' + A'BC + AB'C + ABC' (even parity) has no adjacent 1s.
    expect(staticHazards(3, ['000', '011', '101', '110'], [0, 3, 5, 6])).toEqual([]);
    // f = A'B + AB' ... with A'C' + AC split into minterm terms: 000,010 adjacent via B; 101,111 via B
    const h = staticHazards(3, ['0-0', '1-1'].flatMap((p) => [p.replace('-', '0'), p.replace('-', '1')]), [0, 2, 5, 7]);
    expect(h.map((x) => [x.variable, ...x.minterms, x.consensus])).toEqual([
      [1, 0, 2, '0-0'],
      [1, 5, 7, '1-1'],
    ]);
  });

  it('consensus carries the variable that changes and the shared literals', () => {
    const h = staticHazards(4, ['1100', '1110'], [12, 14]);
    expect(h).toEqual([{ variable: 2, minterms: [12, 14], consensus: '11-0' }]);
    expect(formatSop([h[0].consensus], ['W', 'X', 'Y', 'Z'])).toBe('WXZ′');
  });

  it('a minimal cover with a Karnaugh-map seam hazard', () => {
    // f(A,B,C,D) = Σm(1,3,5,7,8,9,12,13)... check hazards found are really uncovered and fixed
    const ones = [1, 3, 5, 7, 8, 9, 12, 13];
    const cover = minimize(4, ones);
    const h = staticHazards(4, cover, ones);
    for (const x of h) {
      expect(cover.some((p) => covers(p, x.minterms[0]) && covers(p, x.minterms[1]))).toBe(false);
      expect(x.minterms[0] ^ x.minterms[1]).toBe(1 << (3 - x.variable));
    }
    const fixed = hazardFreeCover(4, ones);
    expect(staticHazards(4, fixed.cover, ones)).toEqual([]);
    for (let m = 0; m < 16; m++) expect(evaluateSop(fixed.cover, m)).toBe(ones.includes(m) ? 1 : 0);
  });

  it('a 2:1 multiplexer Y = S′A + SB needs the AB consensus term', () => {
    // variables S,A,B
    const ones = [1, 3, 6, 7]; // S'A: 001? with order S,A,B: S'A = 01-: minterms 2,3 ; SB = 1-1: 5,7 ; so recompute
    const f = (s: number, a: number, b: number) => (s ? b : a);
    const mt = [0, 1, 2, 3, 4, 5, 6, 7].filter((m) => f((m >> 2) & 1, (m >> 1) & 1, m & 1));
    expect(mt).toEqual([2, 3, 5, 7]);
    void ones;
    const fixed = hazardFreeCover(3, mt);
    expect(fixed.base.sort()).toEqual(['01-', '1-1']);
    expect(fixed.added).toEqual(['-11']);
    expect(formatSop(fixed.added, ['S', 'A', 'B'])).toBe('AB');
  });

  it('a hazard-free function (all primes essential and disjoint-adjacent) adds nothing', () => {
    const fixed = hazardFreeCover(3, [3, 5, 6, 7]); // majority: AB + AC + BC already holds every adjacent pair
    expect(fixed.added).toEqual([]);
    expect(staticHazards(3, fixed.base, [3, 5, 6, 7])).toEqual([]);
  });

  it('don’t-cares enlarge terms but are not hazard pairs', () => {
    const fixed = hazardFreeCover(3, [1, 3], [5, 7]);
    expect(fixed.cover).toEqual(['--1']);
    expect(fixed.added).toEqual([]);
  });

  it('random functions: result is equivalent, hazard-free, and uses only prime implicants', () => {
    const rand = rng(99);
    for (let k = 0; k < 200; k++) {
      const n = 2 + Math.floor(rand() * 4);
      const ones: number[] = [];
      const dc: number[] = [];
      for (let m = 0; m < 1 << n; m++) {
        const r = rand();
        if (r < 0.45) ones.push(m);
        else if (r < 0.55) dc.push(m);
      }
      const fixed = hazardFreeCover(n, ones, dc);
      expect(staticHazards(n, fixed.cover, ones)).toEqual([]);
      const primes = primeImplicants(n, ones, dc);
      for (const a of fixed.added) expect(primes).toContain(a);
      for (let m = 0; m < 1 << n; m++) {
        if (ones.includes(m)) expect(evaluateSop(fixed.cover, m)).toBe(1);
        else if (!dc.includes(m)) expect(evaluateSop(fixed.cover, m)).toBe(0);
      }
      // the hazards of the base cover are exactly the ones the added terms remove
      const base = staticHazards(n, fixed.base, ones);
      if (base.length === 0) expect(fixed.added).toEqual([]);
      else expect(fixed.added.length).toBeGreaterThan(0);
    }
  });
});
