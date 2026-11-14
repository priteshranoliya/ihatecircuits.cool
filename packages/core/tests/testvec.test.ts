import { describe, expect, it } from 'vitest';
import { LIBRARY } from '../src/library';
import { parseVectors, runVectors, type ParsedVectors, type VectorRun } from '../src/testvec';
import { T } from './helpers';

const parsed = (text: string): ParsedVectors => {
  const p = parseVectors(text);
  if ('error' in p) throw new Error(`line ${p.line}: ${p.error}`);
  return p;
};
const run = (t: T, text: string): VectorRun => {
  const r = runVectors(t.c, t.sim(), parsed(text));
  if ('error' in r) throw new Error(r.error);
  return r;
};

/** Half adder: switches A, B → LEDs S (xor) and C (and). */
function halfAdder() {
  const t = new T();
  const a = t.add('switch', {}, 'A');
  const b = t.add('switch', {}, 'B');
  const x = t.add('xor', {});
  const g = t.add('and', {});
  const s = t.add('led', {}, 'S');
  const c = t.add('led', {}, 'C');
  t.wire(a, 'out', x, 'in0').wire(b, 'out', x, 'in1').wire(a, 'out', g, 'in0').wire(b, 'out', g, 'in1').wire(x, 'out', s, 'in').wire(g, 'out', c, 'in');
  return t;
}

describe('test vector parsing', () => {
  it('reads header, comments and rows', () => {
    const p = parsed(`# adder
A B  Sum[4]   # trailing comment

0 1 0101
1 1 0xF  # hex
`);
    expect(p.header).toEqual([{ name: 'A', width: undefined }, { name: 'B', width: undefined }, { name: 'Sum', width: 4 }].map((c) => ({ ...c })));
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].line).toBe(4);
    expect(p.sequential).toBe(false);
  });

  it('accepts every value form', () => {
    const p = parsed('V[8]\n01010101\n0x1F\n13\n-3\nx\nz\n01xz01xz\n');
    expect(p.rows.map((r) => r.cells[0].kind)).toEqual(['digits', 'num', 'num', 'num', 'x', 'z', 'digits']);
  });

  it('reports errors with line numbers', () => {
    const bad = (text: string) => {
      const r = parseVectors(text);
      if (!('error' in r)) throw new Error('expected error');
      return r;
    };
    expect(bad('')).toMatchObject({ line: 1, error: expect.stringMatching(/header/) });
    expect(bad('# only a comment\n')).toMatchObject({ error: expect.stringMatching(/header/) });
    expect(bad('A B\n0 1\n1\n')).toMatchObject({ line: 3, error: expect.stringMatching(/1 value but the header has 2/) });
    expect(bad('A A\n0 1\n')).toMatchObject({ line: 1, error: expect.stringMatching(/twice/) });
    expect(bad('A[0]\n')).toMatchObject({ line: 1 });
    expect(bad('A[40]\n')).toMatchObject({ line: 1 });
    expect(bad('A[x]\n')).toMatchObject({ line: 1, error: expect.stringMatching(/not a valid column name/) });
    expect(bad('A\n0\nfoo\n')).toMatchObject({ line: 3, error: expect.stringMatching(/not a value for A/) });
    expect(bad('S[4]\n01x\n')).toMatchObject({ line: 2, error: expect.stringMatching(/3 digits but the column is 4 bits/) });
    expect(bad('S[4]\n0x1F\n')).toMatchObject({ line: 2, error: expect.stringMatching(/does not fit in 4 bits/) });
    expect(bad('S[4]\n-9\n')).toMatchObject({ error: expect.stringMatching(/does not fit/) });
    expect(bad('S[4]\n16\n')).toMatchObject({ error: expect.stringMatching(/does not fit/) });
    expect(bad('S\n0xZZ\n')).toMatchObject({ error: expect.stringMatching(/hex/) });
    expect(bad('A #clock\n0 5\n')).toMatchObject({ line: 2, error: expect.stringMatching(/#clock must be 0, 1 or \^/) });
    expect(bad('#clock #clock A\n')).toMatchObject({ error: expect.stringMatching(/twice/) });
  });

  it('#clock is the one place a hash is not a comment', () => {
    const p = parsed('A #clock Q # c\n1 ^ 1\n0 0 x\n');
    expect(p.sequential).toBe(true);
    expect(p.header.map((h) => h.name)).toEqual(['A', 'Q']);
    expect(p.rows.map((r) => r.clock)).toEqual(['^', '0']);
    expect(p.rows[0].cells).toHaveLength(2);
  });
});

describe('running combinational vectors', () => {
  it('passes a correct table', () => {
    const r = run(halfAdder(), 'A B S C\n0 0 0 0\n0 1 1 0\n1 0 1 0\n1 1 0 1\n');
    expect(r.passed).toBe(4);
    expect(r.failed).toBe(0);
    expect(r.results.every((x) => x.ok && x.mismatches.length === 0)).toBe(true);
    expect(r.results.map((x) => x.row)).toEqual([0, 1, 2, 3]);
  });

  it('detects failures and names the signal', () => {
    const r = run(halfAdder(), 'A B S C\n0 0 0 0\n1 1 1 1\n1 0 1 0\n');
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.results[1].ok).toBe(false);
    expect(r.results[1].mismatches).toEqual([{ signal: 'S', expected: '1', got: '0' }]);
    expect(r.results[1].line).toBe(3);
  });

  it('x is a don’t-care for outputs, also per digit', () => {
    const t = halfAdder();
    const r = run(t, 'A B S C\n1 1 x 1\n0 1 1 x\n1 0 x x\n');
    expect(r.failed).toBe(0);
    const t2 = new T();
    const pa = t2.add('pin', { io: 'in', bits: 4 }, 'In');
    const po = t2.add('pin', { io: 'out', bits: 4 }, 'Out');
    t2.wire(pa, 'p', po, 'p');
    const r2 = run(t2, 'In Out\n0101 01xx\n1101 x10x\n1101 x00x\n');
    expect(r2.results.map((x) => x.ok)).toEqual([true, true, false]);
    expect(r2.results[2].mismatches[0]).toEqual({ signal: 'Out', expected: 'x00x', got: '1101' });
  });

  it('multi-bit pins accept binary, hex, decimal and negative decimal', () => {
    const t = new T();
    const pa = t.add('pin', { io: 'in', bits: 4 }, 'In');
    const po = t.add('pin', { io: 'out', bits: 4 }, 'Out');
    t.wire(pa, 'p', po, 'p');
    const r = run(t, 'In[4] Out\n0101 5\n0xA 1010\n13 0xD\n-3 1101\n-8 8\n15 -1\n10 1010\n');
    // "10" in a 4-bit column is decimal ten; "1010" is binary.
    expect(r.failed, JSON.stringify(r.results.filter((x) => !x.ok))).toBe(0);
  });

  it('a 2-bit column reads 10 as binary and a 4-bit one as decimal', () => {
    const t = new T();
    const pa = t.add('pin', { io: 'in', bits: 2 }, 'In');
    const po = t.add('pin', { io: 'out', bits: 2 }, 'Out');
    t.wire(pa, 'p', po, 'p');
    expect(run(t, 'In Out\n10 10\n2 10\n').failed).toBe(0);
  });

  it('drives DIP switches and reads probes', () => {
    const t = new T();
    const d = t.add('dip', { count: 4 }, 'D');
    const p = t.add('probe', {}, 'Watch');
    t.wire(d, 'out', p, 'p');
    expect(run(t, 'D Watch\n0000 0\n1001 0x9\n0xF 15\n').failed).toBe(0);
    expect(run(t, 'D Watch\n0011 4\n').failed).toBe(1);
  });

  it('floating expected values with z', () => {
    const t = new T();
    const pa = t.add('pin', { io: 'in', bits: 1, behavior: 'tristate' }, 'En');
    const buf = t.add('tribuf', {});
    const pd = t.add('const', { bits: 1, value: '1' });
    const po = t.add('pin', { io: 'out', bits: 1 }, 'Q');
    t.wire(pd, 'out', buf, 'in0').wire(pa, 'p', buf, 'en').wire(buf, 'out', po, 'p');
    expect(run(t, 'En Q\n1 1\n0 z\n').failed).toBe(0);
    expect(run(t, 'En Q\n0 0\n').failed).toBe(1);
  });

  it('never disturbs the simulator it is given', () => {
    const t = halfAdder();
    const sim = t.sim();
    const a = t.c.components[Object.keys(t.c.components).find((k) => t.c.components[k].label === 'A')!];
    sim.setRuntime(a.id, 'on', true);
    sim.settle();
    const before = sim.propsOf(a.id)!.on;
    const timeBefore = sim.time;
    runVectors(t.c, sim, parsed('A B S C\n0 0 0 0\n1 1 0 1\n'));
    expect(sim.propsOf(a.id)!.on).toBe(before);
    expect(sim.time).toBe(timeBefore);
  });

  it('returns errors for unknown names, clashing widths, x inputs and ambiguous labels', () => {
    const t = halfAdder();
    const r = (text: string) => runVectors(t.c, t.sim(), parsed(text));
    expect(r('A B Q Z\n0 0 0 0\n')).toMatchObject({ error: expect.stringMatching(/"Q", "Z"/) });
    expect(r('A[2] B S C\n00 0 0 0\n')).toMatchObject({ error: expect.stringMatching(/A is 2 bits wide in the header but the part is 1 bits wide/) });
    expect(r('A B S C\nx 0 0 0\n')).toMatchObject({ error: expect.stringMatching(/A is an input/), line: 2 });
    expect(r('A B S C\n0 0 0 0\n0 z 0 0\n')).toMatchObject({ line: 3 });
    const t2 = halfAdder();
    t2.add('switch', {}, 'S');
    expect(runVectors(t2.c, t2.sim(), parsed('A B S C\n0 0 0 0\n'))).toMatchObject({ error: expect.stringMatching(/More than one/) });
    expect(runVectors(t.c, t.sim(), parsed('A B Foo\n0 0 0\n'))).toMatchObject({ error: expect.stringMatching(/"Foo"/) });
  });
});

describe('sequential vectors', () => {
  /** 2-bit synchronous counter from D flip-flops: D0 = Q0′, D1 = Q1 ⊕ Q0, async clear from a switch. */
  function counter() {
    const t = new T();
    const clk = t.add('clock', {});
    const clr = t.add('switch', {}, 'Clr');
    const d0 = t.add('dff', {});
    const d1 = t.add('dff', {});
    const inv = t.add('not', {});
    const x = t.add('xor', {});
    const q0 = t.add('led', {}, 'Q0');
    const q1 = t.add('led', {}, 'Q1');
    t.wire(clk, 'out', d0, 'clk').wire(clk, 'out', d1, 'clk').wire(clr, 'out', d0, 'clr').wire(clr, 'out', d1, 'clr');
    t.wire(d0, 'q', inv, 'in0').wire(inv, 'out', d0, 'd');
    t.wire(d1, 'q', x, 'in0').wire(d0, 'q', x, 'in1').wire(x, 'out', d1, 'd');
    t.wire(d0, 'q', q0, 'in').wire(d1, 'q', q1, 'in');
    return t;
  }

  it('is registered', () => {
    expect(LIBRARY.has('dff')).toBe(true);
  });

  it('counts with ^ rows', () => {
    const r = run(counter(), `Clr Q1 Q0 #clock
1   0  0  0
0   0  0  0
0   0  1  ^
0   1  0  ^
0   1  1  ^
0   0  0  ^
0   0  1  ^
`);
    expect(r.failed, JSON.stringify(r.results.filter((x) => !x.ok))).toBe(0);
    expect(r.passed).toBe(7);
  });

  it('detects a wrong count and keeps state between rows', () => {
    const r = run(counter(), 'Clr Q1 Q0 #clock\n1 0 0 0\n0 0 1 ^\n0 0 1 ^\n0 1 x ^\n');
    expect(r.results.map((x) => x.ok)).toEqual([true, true, false, true]);
    expect(r.results[2].mismatches).toEqual([{ signal: 'Q1', expected: '0', got: '1' }, { signal: 'Q0', expected: '1', got: '0' }].filter((m) => m.signal === 'Q1' || m.signal === 'Q0'));
  });

  it('clock value 0 holds time still and 1 takes a half-period step', () => {
    const t = counter();
    // one half-step after reset raises the clock: counter increments on the rising edge
    const r = run(t, 'Clr Q1 Q0 #clock\n1 0 0 0\n0 0 0 0\n0 0 1 1\n0 0 1 0\n0 0 1 1\n0 1 0 1\n');
    expect(r.failed, JSON.stringify(r.results.filter((x) => !x.ok))).toBe(0);
  });

  it('async clear rows reset the count mid-run', () => {
    const r = run(counter(), 'Clr Q1 Q0 #clock\n1 0 0 0\n0 0 1 ^\n0 1 0 ^\n1 0 0 0\n0 0 1 ^\n');
    expect(r.failed).toBe(0);
  });

  it('the original simulator is untouched by a sequential run', () => {
    const t = counter();
    const sim = t.sim();
    sim.reset();
    const tick = sim.tick;
    runVectors(t.c, sim, parsed('Clr Q1 Q0 #clock\n1 0 0 0\n0 0 1 ^\n0 1 0 ^\n'));
    expect(sim.tick).toBe(tick);
  });
});
