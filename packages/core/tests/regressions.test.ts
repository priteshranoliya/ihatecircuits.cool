import { describe, expect, it } from 'vitest';
import { truthTable, type TruthTable } from '../src/analysis';
import { addComponent, connect } from '../src/edit';
import { addCircuit, circuitById, lookupIn, newProject, replaceCircuit, subcircuitDef, subType, useProject } from '../src/project';
import { CircuitFileError, parseProject } from '../src/serialize';
import { Simulator } from '../src/sim';
import type { Circuit } from '../src/types';
import { T, drive, str } from './helpers';

describe('found by independent verification', () => {
  it('pins with the same label stay separate connections on a subcircuit', () => {
    let p = newProject();
    const r = addCircuit(p, 'Two inputs');
    let c: Circuit = circuitById(r.project, r.id)!;
    const add = (type: string, label: string, props: Record<string, unknown>, y: number) => {
      const x = addComponent(c, { type, x: 0, y, label, props });
      c = x.circuit;
      return x.id;
    };
    const x1 = add('pin', 'X', {}, 0);
    const x2 = add('pin', 'X', {}, 40);
    const o1 = add('pin', 'Y1', { io: 'out' }, 0);
    const o2 = add('pin', 'Y2', { io: 'out' }, 40);
    for (const [a, b] of [
      [x1, o1],
      [x2, o2],
    ]) {
      const w = connect(c, { comp: a, pin: 'p' }, { comp: b, pin: 'p' });
      if ('error' in w) throw new Error(w.error);
      c = w.circuit;
    }
    p = replaceCircuit(r.project, c);
    useProject(p);
    const names = subcircuitDef(c).pins({}).map((q) => q.name);
    expect(new Set(names).size).toBe(names.length);
    const t = new T();
    const s1 = t.add('switch');
    const s2 = t.add('switch');
    const inst = t.add(subType(r.id));
    const ins = names.filter((n) => n.startsWith('X'));
    t.wire(s1, 'out', inst, ins[0]).wire(s2, 'out', inst, ins[1]);
    const sim = new Simulator(t.c, { lookup: lookupIn(p) });
    drive(sim, { [s2]: 1 });
    expect(str(sim.value(inst, 'Y1'))).toBe('0');
    expect(str(sim.value(inst, 'Y2'))).toBe('1');
  });

  it('crafted endpoint names and bad versions give file errors, not crashes', () => {
    const base = { format: 'ihatecircuits-project', version: 2, name: 'x', main: 'main' };
    for (const comp of ['__proto__', 'constructor', 'toString']) {
      const text = JSON.stringify({ ...base, circuits: [{ id: 'main', name: 'M', components: [{ id: 'c1', type: 'switch', x: 0, y: 0 }], wires: [{ id: 'w2', from: { comp, pin: 'out' }, to: { comp: 'c1', pin: 'out' } }] }] });
      expect(() => parseProject(text)).toThrow(CircuitFileError);
      expect(() => parseProject(text)).toThrow(/does not exist/);
    }
    expect(() => parseProject(JSON.stringify({ ...base, version: '2', circuits: [] }))).toThrow(/invalid format version/);
  });

  it('sliders are truth-table inputs and probes are outputs', () => {
    const t = new T();
    const s = t.add('slider', { bits: 2 }, 'S');
    const p = t.add('probe', {}, 'P');
    t.wire(s, 'out', p, 'p');
    const tt = truthTable(t.c, t.sim()) as TruthTable;
    expect(tt.inputs.map((c) => c.name)).toEqual(['S1', 'S0']);
    expect(tt.outputs.map((c) => c.name)).toEqual(['P1', 'P0']);
    tt.rows.forEach((r) => expect(r.outputs).toEqual(r.inputs));
  });

  it('reset restarts simulated time', () => {
    const t = new T();
    const c = t.add('clock');
    void c;
    const sim = t.sim();
    sim.step();
    sim.step();
    expect(sim.time).toBeGreaterThan(0);
    sim.reset();
    expect(sim.time).toBe(sim.lastSettle.steps);
  });
});

describe('files saved before the rename', () => {
  it('still open', async () => {
    const { parseProject, serialize } = await import('../src/serialize');
    const { newProject } = await import('../src/project');
    const text = serialize(newProject()).replace('"ihatecircuits-project"', '"gatewright-project"');
    expect(parseProject(text).project.circuits.length).toBe(1);
  });
});
