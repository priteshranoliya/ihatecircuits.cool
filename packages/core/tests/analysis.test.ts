import { describe, expect, it } from 'vitest';
import { covers, evaluatePos, evaluateSop, expressions, formatPos, formatSop, grayCode, groupCells, hasMemory, kmap, minimize, primeImplicants, truthTable, type TruthTable } from '../src/analysis';
import { T } from './helpers';

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe('minimisation', () => {
  it('textbook results', () => {
    expect(formatSop(minimize(3, [3, 5, 6, 7]), ['A', 'B', 'C']).split(' + ').sort()).toEqual(['AB', 'AC', 'BC']);
    expect(formatSop(minimize(4, [0, 2, 8, 10]), ['A', 'B', 'C', 'D'])).toBe('B′D′');
    expect(formatSop(minimize(4, [5, 6, 7, 8, 9], [10, 11, 12, 13, 14, 15]), ['A', 'B', 'C', 'D']).split(' + ').sort()).toEqual(['A', 'BC', 'BD']);
    expect(formatSop(minimize(2, []), ['A', 'B'])).toBe('0');
    expect(formatSop(minimize(2, [0, 1, 2, 3]), ['A', 'B'])).toBe('1');
  });

  it('product of sums via the zeros (De Morgan)', () => {
    // Majority: zeros at 0,1,2,4 → (A + B)(A + C)(B + C)
    const pos = formatPos(minimize(3, [0, 1, 2, 4]), ['A', 'B', 'C']);
    expect(pos.match(/\([^)]*\)/g)!.sort()).toEqual(['(A + B)', '(A + C)', '(B + C)']);
    expect(formatPos(minimize(2, [0, 1, 2]), ['A', 'B'])).toBe('AB');
    expect(formatPos(minimize(2, [1]), ['A', 'B'])).toBe('(A + B′)');
  });

  it('SOP and POS are both equivalent to the function (400 random functions)', () => {
    const rand = rng(7);
    for (let k = 0; k < 400; k++) {
      const n = 1 + Math.floor(rand() * 6);
      const on: number[] = [];
      const off: number[] = [];
      const dc: number[] = [];
      for (let m = 0; m < 1 << n; m++) {
        const r = rand();
        (r < 0.4 ? on : r < 0.85 ? off : dc).push(m);
      }
      const sop = minimize(n, on, dc);
      const pos = minimize(n, off, dc);
      for (const m of on) {
        expect(evaluateSop(sop, m)).toBe(1);
        expect(evaluatePos(pos, m)).toBe(1);
      }
      for (const m of off) {
        expect(evaluateSop(sop, m)).toBe(0);
        expect(evaluatePos(pos, m)).toBe(0);
      }
    }
  });
});

describe('Karnaugh maps', () => {
  it('uses Gray-code axes so neighbours differ in one variable', () => {
    expect(grayCode(2)).toEqual([0, 1, 3, 2]);
    const map = kmap(4, Array(16).fill(0), ['A', 'B', 'C', 'D'])!;
    expect(map.rowVars).toEqual(['A', 'B']);
    expect(map.cells[2][3].m).toBe(0b1110);
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++) {
        const right = map.cells[r][(c + 1) % 4].m ^ map.cells[r][c].m;
        const down = map.cells[(r + 1) % 4][c].m ^ map.cells[r][c].m;
        expect(right & (right - 1)).toBe(0);
        expect(down & (down - 1)).toBe(0);
      }
  });

  it('a corner group wraps around both edges', () => {
    const map = kmap(4, Array(16).fill(0), ['A', 'B', 'C', 'D'])!;
    const cells = groupCells(map, '-0-0');
    expect(cells.sort()).toEqual([
      [0, 0],
      [0, 3],
      [3, 0],
      [3, 3],
    ]);
  });
});

describe('truth tables', () => {
  it('expands multi-bit inputs and outputs into bit columns', () => {
    const t = new T();
    const a = t.add('pin', { bits: 2 }, 'A');
    const b = t.add('switch', {}, 'C');
    const g = t.add('and', { bits: 2 });
    const o = t.add('pin', { bits: 2, io: 'out' }, 'Y');
    const s = t.add('splitter', { width: 2, fans: 2 });
    t.wire(a, 'p', g, 'in0').wire(b, 'out', s, 'f0').wire(b, 'out', s, 'f1').wire(s, 'c', g, 'in1').wire(g, 'out', o, 'p');
    const tt = truthTable(t.c, t.sim()) as TruthTable;
    expect(tt.inputs.map((c) => c.name)).toEqual(['A1', 'A0', 'C']);
    expect(tt.outputs.map((c) => c.name)).toEqual(['Y1', 'Y0']);
    // Y = A when C = 1, else 0.
    tt.rows.forEach((row) => {
      const [a1, a0, c] = row.inputs;
      expect(row.outputs).toEqual([a1 & c, a0 & c]);
    });
    const ex = expressions(tt);
    expect(ex[0].sop).toBe('A1·C');
    expect(ex[0].pos.match(/A1|C/g)!.sort()).toEqual(['A1', 'C']);
  });

  it('detects memory in feedback loops through undirected wires', () => {
    const t = new T();
    const n1 = t.add('nor');
    const n2 = t.add('nor');
    t.wire(n1, 'out', n2, 'in0').wire(n2, 'out', n1, 'in0');
    expect(hasMemory(t.c)).toBe(true);
    const u = new T();
    const a = u.add('switch');
    const g = u.add('not');
    u.wire(g, 'in0', a, 'out');
    expect(hasMemory(u.c)).toBe(false);
  });
});

describe('exact minimum cover', () => {
  /** Brute force: smallest set of prime implicants covering every minterm, by (terms, literals). */
  function bruteMin(n: number, on: number[], dc: number[]) {
    const primes = primeImplicants(n, on, dc);
    const lits = (p: string) => p.replace(/-/g, '').length;
    let best = Infinity;
    for (let mask = 1; mask < 1 << primes.length; mask++) {
      const pick = primes.filter((_, i) => mask & (1 << i));
      if (on.every((m) => pick.some((p) => covers(p, m)))) best = Math.min(best, pick.length * 1000 + pick.reduce((a, p) => a + lits(p), 0));
    }
    return best;
  }
  it('matches brute force on random 3–4 variable functions (cyclic cores included)', () => {
    const rand = rng(99);
    let checked = 0;
    for (let k = 0; k < 400; k++) {
      const n = 3 + Math.floor(rand() * 2);
      const on: number[] = [];
      const dc: number[] = [];
      for (let m = 0; m < 1 << n; m++) {
        const r = rand();
        if (r < 0.45) on.push(m);
        else if (r < 0.55) dc.push(m);
      }
      if (!on.length || primeImplicants(n, on, dc).length > 16) continue;
      const got = minimize(n, on, dc);
      const cost = got.length * 1000 + got.reduce((a, p) => a + p.replace(/-/g, '').length, 0);
      expect(cost).toBe(bruteMin(n, on, dc));
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });
  it('solves the classic cyclic function Σm(0,1,2,5,6,7) with 3 terms', () => {
    expect(minimize(3, [0, 1, 2, 5, 6, 7])).toHaveLength(3);
  });
});

describe('minimisation of large functions', () => {
  it('a 10-input function stays fast and equivalent', () => {
    const rand = rng(10);
    const n = 10;
    const on: number[] = [];
    const off: number[] = [];
    const dc: number[] = [];
    for (let m = 0; m < 1 << n; m++) {
      const r = rand();
      (r < 0.4 ? on : r < 0.85 ? off : dc).push(m);
    }
    const t = performance.now();
    const sop = minimize(n, on, dc);
    expect(performance.now() - t).toBeLessThan(2000);
    for (const m of on) expect(evaluateSop(sop, m)).toBe(1);
    for (const m of off) expect(evaluateSop(sop, m)).toBe(0);
  });
});
