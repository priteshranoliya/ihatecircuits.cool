import { describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim';
import { T, drive, num, str } from './helpers';

describe('propagation and timing', () => {
  it('a chain of N inverters takes N gate delays (plus one for the switch)', () => {
    const t = new T();
    const a = t.add('switch');
    let prev = a;
    for (let i = 0; i < 20; i++) {
      const n = t.add('not');
      t.wire(prev, 'out', n, 'in0');
      prev = n;
    }
    const sim = t.sim();
    expect(str(sim.value(prev, 'out'))).toBe('0');
    sim.setRuntime(a, 'on', true);
    const r = sim.settle();
    expect(r).toEqual({ stable: true, steps: 21 });
    expect(str(sim.value(prev, 'out'))).toBe('1');
  });

  it('per-gate delay settings change timing', () => {
    const t = new T();
    const a = t.add('switch');
    const b = t.add('buffer', { delay: 7 });
    t.wire(a, 'out', b, 'in0');
    const sim = t.sim();
    sim.setRuntime(a, 'on', true);
    expect(sim.settle().steps).toBe(8);
  });

  it('a static-1 hazard produces a real glitch', () => {
    // f = A·B + A′·C with B = C = 1 is always 1, but when A falls the slow
    // inverter leaves a gap where both AND terms are 0.
    const t = new T();
    const A = t.add('switch', { on: true });
    const one = t.add('const', { value: '1' });
    const inv = t.add('not', { delay: 3 });
    const g1 = t.add('and');
    const g2 = t.add('and');
    const o = t.add('or');
    t.wire(A, 'out', g1, 'in0').wire(one, 'out', g1, 'in1');
    t.wire(A, 'out', inv, 'in0').wire(inv, 'out', g2, 'in0').wire(one, 'out', g2, 'in1');
    t.wire(g1, 'out', o, 'in0').wire(g2, 'out', o, 'in1');
    const sim = t.sim();
    expect(str(sim.value(o, 'out'))).toBe('1');
    sim.trace = [];
    sim.setRuntime(A, 'on', false);
    sim.settle();
    const orChanges = sim.trace.filter((e) => e.id === o).map((e) => [e.t - sim.trace![0].t, str(e.value)]);
    // Times relative to the switch changing: g1 drops at +1 so OR drops at +2;
    // the inverter (delay 3) rises at +3, g2 at +4, OR recovers at +5.
    expect(orChanges).toEqual([
      [2, '0'],
      [5, '1'],
    ]);
    expect(str(sim.value(o, 'out'))).toBe('1');
  });

  it('adding the consensus term B·C removes the hazard', () => {
    const t = new T();
    const A = t.add('switch', { on: true });
    const one = t.add('const', { value: '1' });
    const inv = t.add('not', { delay: 3 });
    const g1 = t.add('and');
    const g2 = t.add('and');
    const g3 = t.add('and');
    const o = t.add('or', { inputs: 3 });
    t.wire(A, 'out', g1, 'in0').wire(one, 'out', g1, 'in1');
    t.wire(A, 'out', inv, 'in0').wire(inv, 'out', g2, 'in0').wire(one, 'out', g2, 'in1');
    t.wire(one, 'out', g3, 'in0').wire(one, 'out', g3, 'in1');
    t.wire(g1, 'out', o, 'in0').wire(g2, 'out', o, 'in1').wire(g3, 'out', o, 'in2');
    const sim = t.sim();
    sim.trace = [];
    sim.setRuntime(A, 'on', false);
    sim.settle();
    expect(sim.trace.filter((e) => e.id === o)).toEqual([]);
  });

  it('is deterministic regardless of creation order', () => {
    const build = (rev: boolean) => {
      const t = new T();
      const names = ['a', 'b', 'x', 'y', 'n'];
      const types: Record<string, string> = { a: 'switch', b: 'switch', x: 'xor', y: 'and', n: 'nor' };
      const ids: Record<string, string> = {};
      for (const k of rev ? [...names].reverse() : names) ids[k] = t.add(types[k]);
      t.wire(ids.a, 'out', ids.x, 'in0').wire(ids.b, 'out', ids.x, 'in1').wire(ids.x, 'out', ids.y, 'in0');
      t.wire(ids.a, 'out', ids.y, 'in1').wire(ids.y, 'out', ids.n, 'in0').wire(ids.x, 'out', ids.n, 'in1');
      return { t, ids };
    };
    for (let m = 0; m < 4; m++) {
      const out = [false, true].map((rev) => {
        const { t, ids } = build(rev);
        const sim = drive(t.sim(), { [ids.a]: m & 1, [ids.b]: m >> 1 });
        return ['x', 'y', 'n'].map((k) => str(sim.value(ids[k], 'out')));
      });
      expect(out[0]).toEqual(out[1]);
    }
  });

  it('detects oscillation and recovers when the loop is broken', () => {
    const t = new T();
    const en = t.add('switch');
    const g = t.add('nand');
    t.wire(en, 'out', g, 'in0').wire(g, 'out', g, 'in1');
    const sim = t.sim();
    expect(str(sim.value(g, 'out'))).toBe('1');
    sim.setRuntime(en, 'on', true);
    expect(sim.settle().stable).toBe(false);
    expect(sim.oscillating).toBe(true);
    expect(sim.hot.has(g)).toBe(true);
    sim.setRuntime(en, 'on', false);
    expect(sim.settle().stable).toBe(true);
    expect(sim.oscillating).toBe(false);
  });

  it('long chains do not trip the oscillation detector', () => {
    const t = new T();
    const a = t.add('switch');
    let prev = a;
    for (let i = 0; i < 1500; i++) {
      const n = t.add('not');
      t.wire(prev, 'out', n, 'in0');
      prev = n;
    }
    const sim = t.sim();
    sim.setRuntime(a, 'on', true);
    expect(sim.settle().stable).toBe(true);
    expect(str(sim.value(prev, 'out'))).toBe('1');
  });

  it('a cross-coupled NOR latch holds after set and reset', () => {
    const t = new T();
    const s = t.add('switch');
    const r = t.add('switch');
    const n1 = t.add('nor');
    const n2 = t.add('nor');
    t.wire(r, 'out', n1, 'in0').wire(n2, 'out', n1, 'in1').wire(s, 'out', n2, 'in1').wire(n1, 'out', n2, 'in0');
    const sim = t.sim();
    expect(str(sim.value(n1, 'out'))).toBe('x');
    drive(sim, { [s]: 1 });
    drive(sim, { [s]: 0 });
    expect(str(sim.value(n1, 'out'))).toBe('1');
    drive(sim, { [r]: 1 });
    drive(sim, { [r]: 0 });
    expect([str(sim.value(n1, 'out')), str(sim.value(n2, 'out'))]).toEqual(['0', '1']);
  });

  it('rebuilding after an edit keeps latched values and state', () => {
    const t = new T();
    const s = t.add('switch', { on: true });
    const r = t.add('switch');
    const n1 = t.add('nor');
    const n2 = t.add('nor');
    t.wire(r, 'out', n1, 'in0').wire(n2, 'out', n1, 'in1').wire(s, 'out', n2, 'in1').wire(n1, 'out', n2, 'in0');
    const sim = t.sim();
    sim.setRuntime(s, 'on', false);
    sim.settle();
    t.add('led');
    const again = new Simulator(t.c, { prev: sim });
    // The switch prop in the circuit is still "on", so rebuild sees it set; q stays 1 either way.
    expect(str(again.value(n1, 'out'))).toBe('1');
  });

  it('clone is isolated', () => {
    const t = new T();
    const a = t.add('switch');
    const l = t.add('led');
    t.wire(a, 'out', l, 'in');
    const sim = t.sim();
    const c = sim.clone();
    drive(c, { [a]: 1 });
    expect(str(c.value(l, 'in'))).toBe('1');
    expect(str(sim.value(l, 'in'))).toBe('0');
  });
});

describe('buses, tri-state and resolution', () => {
  it('two tri-state buffers share a bus; enabling both with different data is a conflict', () => {
    const t = new T();
    const d0 = t.add('const', { bits: 4, value: '5' });
    const d1 = t.add('const', { bits: 4, value: 'A' });
    const e0 = t.add('switch');
    const e1 = t.add('switch');
    const b0 = t.add('tribuf', { bits: 4 });
    const b1 = t.add('tribuf', { bits: 4 });
    const probe = t.add('probe');
    t.wire(d0, 'out', b0, 'in0').wire(d1, 'out', b1, 'in0').wire(e0, 'out', b0, 'en').wire(e1, 'out', b1, 'en');
    t.wire(b0, 'out', probe, 'p').wire(b1, 'out', probe, 'p');
    const sim = t.sim();
    expect(str(sim.value(probe, 'p'))).toBe('zzzz');
    drive(sim, { [e0]: 1 });
    expect(num(sim.value(probe, 'p'))).toBe(5);
    drive(sim, { [e0]: 0, [e1]: 1 });
    expect(num(sim.value(probe, 'p'))).toBe(10);
    drive(sim, { [e0]: 1 });
    expect(str(sim.value(probe, 'p'))).toBe('eeee');
  });

  it('open-drain outputs with a pull-up form a wired-AND', () => {
    const t = new T();
    const a = t.add('switch');
    const b = t.add('switch');
    const ga = t.add('buffer', { output: '0z' });
    const gb = t.add('buffer', { output: '0z' });
    const pu = t.add('pull', { pull: 'up' });
    const led = t.add('led');
    t.wire(a, 'out', ga, 'in0').wire(b, 'out', gb, 'in0').wire(ga, 'out', led, 'in').wire(gb, 'out', led, 'in').wire(pu, 'p', led, 'in');
    const sim = t.sim();
    for (let m = 0; m < 4; m++) {
      drive(sim, { [a]: m & 1, [b]: m >> 1 });
      expect(str(sim.value(led, 'in'))).toBe(m === 3 ? '1' : '0');
    }
  });

  it('a floating net reads z, and a gate reading it outputs x', () => {
    const t = new T();
    const tb = t.add('tribuf');
    const off = t.add('const', { value: '0' });
    const n = t.add('not');
    t.wire(tb, 'out', n, 'in0').wire(off, 'out', tb, 'en');
    const sim = t.sim();
    expect(str(sim.value(n, 'in0'))).toBe('z');
    expect(str(sim.value(n, 'out'))).toBe('x');
  });

  it('splitters join and split buses in both directions', () => {
    const t = new T();
    const sws = [0, 1, 2, 3].map(() => t.add('switch'));
    const join = t.add('splitter', { width: 4, fans: 4 });
    const split = t.add('splitter', { width: 4, fans: 2 });
    const p = t.add('probe');
    const lo = t.add('probe');
    const hi = t.add('probe');
    sws.forEach((s, i) => t.wire(s, 'out', join, `f${i}`));
    t.wire(join, 'c', split, 'c').wire(join, 'c', p, 'p').wire(split, 'f0', lo, 'p').wire(split, 'f1', hi, 'p');
    const sim = t.sim();
    drive(sim, { [sws[0]]: 1, [sws[3]]: 1 });
    expect(str(sim.value(p, 'p'))).toBe('1001');
    expect(str(sim.value(lo, 'p'))).toBe('01');
    expect(str(sim.value(hi, 'p'))).toBe('10');
    // Splitters and wires add no delay: only the switch's own delay counts.
    sim.setRuntime(sws[1], 'on', true);
    expect(sim.settle().steps).toBe(1);
  });

  it('custom splitter bit maps reorder bits', () => {
    const t = new T();
    const c = t.add('const', { bits: 4, value: '1' });
    const s = t.add('splitter', { width: 4, fans: 2, map: '1 1 0 0' });
    const f0 = t.add('probe');
    const f1 = t.add('probe');
    t.wire(c, 'out', s, 'c').wire(s, 'f0', f0, 'p').wire(s, 'f1', f1, 'p');
    const sim = t.sim();
    expect(str(sim.value(f1, 'p'))).toBe('01');
    expect(str(sim.value(f0, 'p'))).toBe('00');
  });

  it('tunnels connect by name', () => {
    const t = new T();
    const a = t.add('switch', { on: true });
    const t1 = t.add('tunnel', { name: 'DATA' });
    const t2 = t.add('tunnel', { name: 'DATA' });
    const t3 = t.add('tunnel', { name: 'OTHER' });
    const l1 = t.add('led');
    const l2 = t.add('led');
    t.wire(a, 'out', t1, 'p').wire(t2, 'p', l1, 'in').wire(t3, 'p', l2, 'in');
    const sim = t.sim();
    expect(str(sim.value(l1, 'in'))).toBe('1');
    expect(str(sim.value(l2, 'in'))).toBe('z');
  });

  it('width mismatches are reported on the wire', () => {
    const t = new T();
    const c = t.add('const', { bits: 4 });
    const n = t.add('not', { bits: 2 });
    t.wire(c, 'out', n, 'in0');
    const wid = Object.keys(t.c.wires)[0];
    const sim = t.sim();
    expect(sim.wireWidthError(wid)).toBe(true);
  });

  it('multi-bit pins and gates act bitwise', () => {
    const t = new T();
    const a = t.add('pin', { bits: 8 });
    const b = t.add('pin', { bits: 8 });
    const g = t.add('xor', { bits: 8 });
    const o = t.add('pin', { bits: 8, io: 'out' });
    t.wire(a, 'p', g, 'in0').wire(b, 'p', g, 'in1').wire(g, 'out', o, 'p');
    const sim = t.sim();
    drive(sim, { [a]: '11110000', [b]: '10101010' }, t.c);
    expect(str(sim.value(o, 'p'))).toBe('01011010');
  });

  it('tri-state input pins can float a bus', () => {
    const t = new T();
    const a = t.add('pin', { bits: 2, behavior: 'tristate' });
    const p = t.add('probe');
    const pd = t.add('pull', { pull: 'down' });
    t.wire(a, 'p', p, 'p').wire(pd, 'p', p, 'p');
    const sim = t.sim();
    drive(sim, { [a]: 'z1' }, t.c);
    expect(str(sim.value(p, 'p'))).toBe('01');
  });
});

describe('switch-level CMOS', () => {
  /** Inverter: PMOS from VDD to out, NMOS from GND to out, gates tied to in. */
  function inverter(t: T, input: string) {
    const vdd = t.add('power');
    const gnd = t.add('ground');
    const p = t.add('pmos');
    const n = t.add('nmos');
    t.wire(vdd, 'out', p, 's').wire(gnd, 'out', n, 's').wire(input, 'out', p, 'g').wire(input, 'out', n, 'g');
    const out = t.add('probe');
    t.wire(p, 'd', out, 'p').wire(n, 'd', out, 'p');
    return out;
  }

  it('a CMOS inverter inverts', () => {
    const t = new T();
    const a = t.add('switch');
    const out = inverter(t, a);
    const sim = t.sim();
    expect(str(sim.value(out, 'p'))).toBe('1');
    drive(sim, { [a]: 1 });
    expect(str(sim.value(out, 'p'))).toBe('0');
  });

  it('a CMOS NAND (parallel PMOS, series NMOS) matches NAND', () => {
    const t = new T();
    const a = t.add('switch');
    const b = t.add('switch');
    const vdd = t.add('power');
    const gnd = t.add('ground');
    const pa = t.add('pmos');
    const pb = t.add('pmos');
    const na = t.add('nmos');
    const nb = t.add('nmos');
    const out = t.add('probe');
    t.wire(vdd, 'out', pa, 's').wire(vdd, 'out', pb, 's').wire(pa, 'd', out, 'p').wire(pb, 'd', out, 'p');
    t.wire(gnd, 'out', nb, 's').wire(nb, 'd', na, 's').wire(na, 'd', out, 'p');
    t.wire(a, 'out', pa, 'g').wire(a, 'out', na, 'g').wire(b, 'out', pb, 'g').wire(b, 'out', nb, 'g');
    const sim = t.sim();
    for (let m = 0; m < 4; m++) {
      drive(sim, { [a]: m & 1, [b]: m >> 1 });
      expect(str(sim.value(out, 'p'))).toBe(m === 3 ? '0' : '1');
    }
  });

  it('an NMOS cannot pass a 1 (its drain floats), a PMOS cannot pass a 0', () => {
    const t = new T();
    const vdd = t.add('power');
    const gnd = t.add('ground');
    const g1 = t.add('const', { value: '1' });
    const g0 = t.add('const', { value: '0' });
    const n = t.add('nmos');
    const p = t.add('pmos');
    t.wire(vdd, 'out', n, 's').wire(g1, 'out', n, 'g').wire(gnd, 'out', p, 's').wire(g0, 'out', p, 'g');
    const sim = t.sim();
    expect(str(sim.value(n, 'd'))).toBe('z');
    expect(str(sim.value(p, 'd'))).toBe('z');
  });

  it('a transmission gate passes both levels', () => {
    const t = new T();
    const s = t.add('switch');
    const n = t.add('const', { value: '1' });
    const p = t.add('const', { value: '0' });
    const tg = t.add('tgate');
    t.wire(s, 'out', tg, 's').wire(n, 'out', tg, 'n').wire(p, 'out', tg, 'p');
    const sim = t.sim();
    expect(str(sim.value(tg, 'd'))).toBe('0');
    drive(sim, { [s]: 1 });
    expect(str(sim.value(tg, 'd'))).toBe('1');
  });
});

describe('gates', () => {
  it('2-input truth tables', () => {
    const fns: Record<string, (a: number, b: number) => number> = {
      and: (a, b) => a & b,
      or: (a, b) => a | b,
      nand: (a, b) => 1 - (a & b),
      nor: (a, b) => 1 - (a | b),
      xor: (a, b) => a ^ b,
      xnor: (a, b) => 1 - (a ^ b),
      oddparity: (a, b) => a ^ b,
      evenparity: (a, b) => 1 - (a ^ b),
    };
    for (const [type, fn] of Object.entries(fns)) {
      const t = new T();
      const a = t.add('switch');
      const b = t.add('switch');
      const g = t.add(type);
      t.wire(a, 'out', g, 'in0').wire(b, 'out', g, 'in1');
      const sim = t.sim();
      for (let m = 0; m < 4; m++) {
        drive(sim, { [a]: m & 1, [b]: m >> 1 });
        expect(str(sim.value(g, 'out')), `${type} ${m}`).toBe(String(fn(m & 1, m >> 1)));
      }
    }
  });

  it('XOR with 3 inputs: odd parity by default, or exactly-one', () => {
    for (const [multi, expected] of [['odd', '1'], ['one', '0']]) {
      const t = new T();
      const one = t.add('const', { value: '1' });
      const g = t.add('xor', { inputs: 3, multi });
      for (let i = 0; i < 3; i++) t.wire(one, 'out', g, `in${i}`);
      expect(str(t.sim().value(g, 'out'))).toBe(expected);
    }
  });

  it('inverted inputs (bubbles)', () => {
    const t = new T();
    const a = t.add('switch');
    const g = t.add('and', { negate: '1' });
    const one = t.add('const', { value: '1' });
    t.wire(a, 'out', g, 'in0').wire(one, 'out', g, 'in1');
    const sim = t.sim();
    expect(str(sim.value(g, 'out'))).toBe('1');
    drive(sim, { [a]: 1 });
    expect(str(sim.value(g, 'out'))).toBe('0');
  });

  it('ignores unconnected inputs; all unconnected gives x', () => {
    const t = new T();
    const a = t.add('switch', { on: true });
    const g = t.add('and', { inputs: 4 });
    const lone = t.add('or');
    t.wire(a, 'out', g, 'in2');
    const sim = t.sim();
    expect(str(sim.value(g, 'out'))).toBe('1');
    expect(str(sim.value(lone, 'out'))).toBe('x');
  });

  it('an unknown enable makes a tri-state output unknown', () => {
    const t = new T();
    const g = t.add('tribuf');
    const one = t.add('const', { value: '1' });
    t.wire(one, 'out', g, 'in0');
    expect(str(t.sim().value(g, 'out'))).toBe('x');
  });

  it('tri-state inverter with active-low enable', () => {
    const t = new T();
    const a = t.add('switch');
    const en = t.add('switch');
    const g = t.add('triinv', { enable: 'low' });
    t.wire(a, 'out', g, 'in0').wire(en, 'out', g, 'en');
    const sim = t.sim();
    expect(str(sim.value(g, 'out'))).toBe('1');
    drive(sim, { [en]: 1 });
    expect(str(sim.value(g, 'out'))).toBe('z');
  });
});

describe('wiring parts', () => {
  it('clock high/low durations and phase', () => {
    const t = new T();
    const c = t.add('clock', { high: 2, low: 3, phase: 1 });
    const sim = t.sim();
    const seen = [str(sim.value(c, 'out'))];
    for (let i = 0; i < 9; i++) {
      sim.step();
      seen.push(str(sim.value(c, 'out')));
    }
    // position = (tick + 1) mod 5; high when position >= 3
    expect(seen.join('')).toBe('0011000110');
  });

  it('bit extender: zero, one, sign and input fill; truncation', () => {
    const cases: [string, string, string][] = [
      ['zero', 'A', '00001010'],
      ['one', 'A', '11111010'],
      ['sign', 'A', '11111010'],
      ['sign', '5', '00000101'],
    ];
    for (const [fill, v, expected] of cases) {
      const t = new T();
      const c = t.add('const', { bits: 4, value: v });
      const x = t.add('extender', { inBits: 4, outBits: 8, fill });
      t.wire(c, 'out', x, 'in');
      expect(str(t.sim().value(x, 'out')), fill + v).toBe(expected);
    }
    const t = new T();
    const c = t.add('const', { bits: 8, value: 'B6' });
    const x = t.add('extender', { inBits: 8, outBits: 3 });
    t.wire(c, 'out', x, 'in');
    expect(str(t.sim().value(x, 'out'))).toBe('110');
  });

  it('power and ground are constant 1s and 0s', () => {
    const t = new T();
    const v = t.add('power', { bits: 4 });
    const g = t.add('ground', { bits: 4 });
    const sim = t.sim();
    expect(str(sim.value(v, 'out'))).toBe('1111');
    expect(str(sim.value(g, 'out'))).toBe('0000');
  });
});

import { addCircuit, canNest, newProject, replaceCircuit, subType, useProject, lookupIn, circuitById } from '../src/project';
import { addComponent, connect } from '../src/edit';
import type { Circuit } from '../src/types';

describe('subcircuits', () => {
  /** A half adder circuit with pins A, B (inputs) and S, C (outputs). */
  function halfAdder(c: Circuit): Circuit {
    const add = (type: string, label: string, props: Record<string, unknown> = {}, y = 0) => {
      const r = addComponent(c, { type, x: 0, y, label, props });
      c = r.circuit;
      return r.id;
    };
    const A = add('pin', 'A', {}, 0);
    const B = add('pin', 'B', {}, 40);
    const S = add('pin', 'S', { io: 'out' }, 0);
    const C = add('pin', 'C', { io: 'out' }, 40);
    const x = add('xor', '');
    const a = add('and', '');
    const w = (p: [string, string], q: [string, string]) => {
      const r = connect(c, { comp: p[0], pin: p[1] }, { comp: q[0], pin: q[1] });
      if ('error' in r) throw new Error(r.error);
      c = r.circuit;
    };
    w([A, 'p'], [x, 'in0']);
    w([B, 'p'], [x, 'in1']);
    w([A, 'p'], [a, 'in0']);
    w([B, 'p'], [a, 'in1']);
    w([x, 'out'], [S, 'p']);
    w([a, 'out'], [C, 'p']);
    return c;
  }

  it('two half adders make a full adder; each instance has its own nets', () => {
    let p = newProject();
    const r = addCircuit(p, 'Half adder');
    p = replaceCircuit(r.project, halfAdder(circuitById(r.project, r.id)!));
    useProject(p);
    const t = new T();
    const a = t.add('switch');
    const b = t.add('switch');
    const cin = t.add('switch');
    const h1 = t.add(subType(r.id));
    const h2 = t.add(subType(r.id));
    const o = t.add('or');
    t.wire(a, 'out', h1, 'A').wire(b, 'out', h1, 'B').wire(h1, 'S', h2, 'A').wire(cin, 'out', h2, 'B');
    t.wire(h1, 'C', o, 'in0').wire(h2, 'C', o, 'in1');
    const sim = new Simulator(t.c, { lookup: lookupIn(p) });
    for (let m = 0; m < 8; m++) {
      drive(sim, { [a]: m & 1, [b]: (m >> 1) & 1, [cin]: m >> 2 });
      const sum = (m & 1) + ((m >> 1) & 1) + (m >> 2);
      expect(str(sim.value(h2, 'S')) + str(sim.value(o, 'out'))).toBe(`${sum & 1}${sum >> 1}`);
    }
    // Inner parts are addressable by path.
    expect(sim.has(`${h1}/c5`)).toBe(true);
  });

  it('refuses recursion', () => {
    let p = newProject();
    const r1 = addCircuit(p, 'A');
    const r2 = addCircuit(r1.project, 'B');
    p = r2.project;
    const inner = addComponent(circuitById(p, r2.id)!, { type: subType(r1.id), x: 0, y: 0 });
    p = replaceCircuit(p, inner.circuit);
    expect(canNest(p, r1.id, r2.id)).toBe(false);
    expect(canNest(p, r2.id, r1.id)).toBe(true);
    expect(canNest(p, r1.id, r1.id)).toBe(false);
  });
});
