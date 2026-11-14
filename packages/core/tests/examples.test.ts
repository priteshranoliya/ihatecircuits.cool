import { describe, expect, it } from 'vitest';
import { truthTable, type TruthTable } from '../src/analysis';
import { EXAMPLES } from '../src/examples';
import { circuitById, lookupIn, useProject } from '../src/project';
import { parseProject, serialize } from '../src/serialize';
import { Simulator } from '../src/sim';
import type { Project } from '../src/types';
import { str } from './helpers';

function open(id: string) {
  const p = EXAMPLES.find((e) => e.id === id)!.build();
  useProject(p);
  const c = circuitById(p, p.main)!;
  const sim = new Simulator(c, { lookup: lookupIn(p) });
  const byLabel = (l: string) => {
    const comp = Object.values(c.components).find((x) => x.label === l);
    if (!comp) throw new Error(`no part labelled ${l}`);
    return comp.id;
  };
  const set = (label: string, key: string, v: unknown) => {
    sim.setRuntime(byLabel(label), key, v);
    const r = sim.settle();
    expect(r.stable).toBe(true);
  };
  return { p, c, sim, byLabel, set };
}

const table = (id: string) => {
  const { c, sim } = open(id);
  return truthTable(c, sim) as TruthTable;
};

describe('examples', () => {
  it('every example builds, settles, round-trips through the file format, and has no width errors', () => {
    for (const ex of EXAMPLES) {
      const p = ex.build();
      useProject(p);
      for (const c of p.circuits) {
        const sim = new Simulator(c, { lookup: lookupIn(p) });
        expect(sim.lastSettle.stable, `${ex.id}/${c.name}`).toBe(true);
        for (const w of Object.keys(c.wires)) expect(sim.wireWidthError(w), `${ex.id} ${w}`).toBe(false);
      }
      const back: Project = parseProject(serialize(p)).project;
      expect(back).toEqual(p);
    }
  });

  it('half adder, full adder, majority and mux truth tables', () => {
    const ha = table('half-adder');
    ha.rows.forEach((r) => expect(r.outputs).toEqual([r.inputs[0] & r.inputs[1], r.inputs[0] ^ r.inputs[1]]));
    const fa = table('full-adder');
    fa.rows.forEach((r) => {
      const sum = r.inputs[0] + r.inputs[1] + r.inputs[2];
      expect(r.outputs).toEqual([sum >> 1, sum & 1]);
    });
    const maj = table('majority');
    maj.rows.forEach((r) => expect(r.outputs[0]).toBe(r.inputs[0] + r.inputs[1] + r.inputs[2] >= 2 ? 1 : 0));
    const mux = table('mux-gates');
    mux.rows.forEach((r) => expect(r.outputs[0]).toBe(r.inputs[2] ? r.inputs[1] : r.inputs[0]));
  });

  it('decoder lights exactly the addressed LED', () => {
    const t = table('decoder');
    expect(t.inputs.map((c) => c.name)).toEqual(['A1', 'A0']);
    t.rows.forEach((r, n) => expect(r.outputs).toEqual([0, 1, 2, 3].map((k) => (k === n ? 1 : 0))));
  });

  it('4-bit adder on buses adds', () => {
    const { sim, byLabel, set } = open('adder4');
    for (const [a, b] of [
      [9, 5],
      [15, 15],
      [0, 0],
      [7, 8],
    ]) {
      set('A', 'value', a);
      set('B', 'value', b);
      expect(sim.value(byLabel('Sum'), 'd').v).toBe((a + b) & 15);
      expect(str(sim.value(byLabel('Cout'), 'in'))).toBe(String((a + b) >> 4));
    }
  });

  it('tri-state bus: floating, each source, and conflict', () => {
    const { sim, byLabel, set } = open('tristate-bus');
    const bus = () => str(sim.value(byLabel('Bus'), 'p'));
    expect(bus()).toBe('zzzz');
    set('EN0', 'on', true);
    expect(bus()).toBe('0101');
    set('EN0', 'on', false);
    set('EN1', 'on', true);
    expect(bus()).toBe('1010');
    set('EN0', 'on', true);
    expect(bus()).toBe('eeee');
  });

  it('wired-AND and CMOS NAND', () => {
    const w = table('wired-and');
    w.rows.forEach((r) => expect(r.outputs[0]).toBe(r.inputs[0] & r.inputs[1]));
    const { sim, byLabel, set } = open('cmos-nand');
    for (let m = 0; m < 4; m++) {
      set('A', 'on', !!(m & 1));
      set('B', 'on', !!(m >> 1));
      expect(str(sim.value(byLabel('Y'), 'p'))).toBe(m === 3 ? '0' : '1');
    }
  });

  it('hazard: F glitches when A falls, G (with the consensus term) does not', () => {
    const { sim, byLabel } = open('hazard');
    const F = byLabel('F');
    const G = byLabel('G');
    const seen = new Map<string, string[]>([
      [F, []],
      [G, []],
    ]);
    const nets = { F: sim.netsOf(F, 'in')!, G: sim.netsOf(G, 'in')! };
    sim.onNetChange = (_t, n) => {
      if (nets.F.includes(n)) seen.get(F)!.push(str(sim.netsValue(nets.F)));
      if (nets.G.includes(n)) seen.get(G)!.push(str(sim.netsValue(nets.G)));
    };
    sim.setRuntime(byLabel('A'), 'on', false);
    sim.settle();
    expect(seen.get(F)).toEqual(['0', '1']);
    expect(seen.get(G)).toEqual([]);
  });

  it('SR latch remembers', () => {
    const { sim, byLabel, set } = open('sr-latch');
    const q = () => str(sim.value(byLabel('Q'), 'in'));
    expect(q()).toBe('x');
    set('S', 'on', true);
    set('S', 'on', false);
    expect(q()).toBe('1');
    set('R', 'on', true);
    set('R', 'on', false);
    expect(q()).toBe('0');
  });

  it('counter counts rising edges and clears', () => {
    const { sim, byLabel, set } = open('counter');
    for (let i = 0; i < 10; i++) sim.step();
    expect(sim.value(byLabel('Count'), 'd').v).toBe(5);
    set('CLR', 'on', true);
    expect(sim.value(byLabel('Count'), 'd').v).toBe(0);
  });

  it('shift register shifts one stage per rising edge', () => {
    const { sim, byLabel, set } = open('shift-register');
    const q = () => [0, 1, 2, 3].map((i) => str(sim.value(byLabel(`Q${i}`), 'in'))).join('');
    sim.step(); // rising edge
    expect(q()).toBe('1000');
    set('DIN', 'on', false);
    sim.step();
    sim.step();
    expect(q()).toBe('0100');
  });

  it('hierarchy: full adder from half-adder instances', () => {
    const { c, sim } = open('hierarchy');
    const t = truthTable(c, sim) as TruthTable;
    expect(t.inputs.map((x) => x.name)).toEqual(['A', 'B', 'Cin']);
    t.rows.forEach((r) => {
      const sum = r.inputs[0] + r.inputs[1] + r.inputs[2];
      expect(r.outputs).toEqual([sum >> 1, sum & 1]);
    });
  });

  it('ripple-carry adder (three levels of hierarchy) adds every pair', () => {
    const { sim, byLabel, set } = open('ripple4');
    for (let a = 0; a < 16; a++)
      for (let b = 0; b < 16; b++) {
        set('A', 'value', a);
        set('B', 'value', b);
        expect(sim.value(byLabel('Sum'), 'd').v).toBe((a + b) & 15);
        expect(str(sim.value(byLabel('Cout'), 'in'))).toBe(String((a + b) >> 4));
      }
  });
});
