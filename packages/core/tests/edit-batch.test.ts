import { describe, expect, it } from 'vitest';
import '../src/parts';
import { addComponent, buildCircuit, connect, connectMany, emptyCircuit, setWireMid } from '../src/edit';
import type { Circuit, PinRef } from '../src/types';

/** n NOT gates in a row, wired output to input, built one pure edit at a time. */
function oneByOne(n: number): Circuit {
  let c = emptyCircuit('chain');
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = addComponent(c, { type: 'not', x: 20 * i, y: 0 });
    c = r.circuit;
    ids.push(r.id);
  }
  for (let i = 1; i < n; i++) {
    const r = connect(c, { comp: ids[i - 1]!, pin: 'out' }, { comp: ids[i]!, pin: 'in0' });
    if ('error' in r) throw new Error(r.error);
    c = setWireMid(r.circuit, r.id, 10 * i);
  }
  return c;
}

describe('the batch builder gives the same circuit as the pure edits', () => {
  it('builds identical components, wires, ids and bends', () => {
    const expected = oneByOne(30);
    const built = buildCircuit(emptyCircuit('chain'), (d) => {
      const ids = Array.from({ length: 30 }, (_, i) => d.addComponent({ type: 'not', x: 20 * i, y: 0 }));
      for (let i = 1; i < 30; i++) {
        const r = d.connect({ comp: ids[i - 1]!, pin: 'out' }, { comp: ids[i]!, pin: 'in0' });
        if ('error' in r) throw new Error(r.error);
        d.setWireMid(r.id, 10 * i);
      }
    });
    expect(built).toEqual(expected);
  });

  it('puts the output end first, like connect', () => {
    const base = addComponent(addComponent(emptyCircuit(), { type: 'not', x: 0, y: 0 }).circuit, { type: 'not', x: 100, y: 0 });
    const a = { comp: 'c1', pin: 'in0' };
    const b = { comp: 'c2', pin: 'out' };
    const pure = connect(base.circuit, a, b);
    const batch = connectMany(base.circuit, [[a, b]]);
    if ('error' in pure || 'error' in batch) throw new Error('unexpected error');
    expect(batch.circuit).toEqual(pure.circuit);
    expect(pure.circuit.wires[pure.id]!.from).toEqual(b);
  });

  it('reports the same errors as connect: unknown pin, same pin, duplicate in either direction', () => {
    const base = addComponent(addComponent(emptyCircuit(), { type: 'not', x: 0, y: 0 }).circuit, { type: 'not', x: 100, y: 0 });
    const out1: PinRef = { comp: 'c1', pin: 'out' };
    const in2: PinRef = { comp: 'c2', pin: 'in0' };
    const cases: Array<[PinRef, PinRef, string]> = [
      [out1, { comp: 'c2', pin: 'nope' }, 'unknown-pin'],
      [out1, { comp: 'c9', pin: 'out' }, 'unknown-pin'],
      [out1, out1, 'same-pin'],
    ];
    for (const [a, b, error] of cases) {
      expect(connect(base.circuit, a, b)).toEqual({ error });
      expect(connectMany(base.circuit, [[a, b]])).toEqual({ error, index: 0 });
    }
    const first = connect(base.circuit, out1, in2);
    if ('error' in first) throw new Error(first.error);
    expect(connect(first.circuit, in2, out1)).toEqual({ error: 'duplicate' });
    expect(connectMany(base.circuit, [[out1, in2], [in2, out1]])).toEqual({ error: 'duplicate', index: 1 });
    expect(connectMany(first.circuit, [[out1, in2]])).toEqual({ error: 'duplicate', index: 0 });
  });

  it('leaves the circuit it started from untouched', () => {
    const base = oneByOne(5);
    const snapshot = JSON.stringify(base);
    buildCircuit(base, (d) => {
      const id = d.addComponent({ type: 'not', x: 0, y: 100 });
      d.connect({ comp: id, pin: 'out' }, { comp: 'c1', pin: 'in0' });
    });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('keeps the existing pure edits working as before', () => {
    const c = oneByOne(3);
    expect(Object.keys(c.wires)).toEqual(['w4', 'w5']);
    expect(c.nextId).toBe(6);
  });
});

describe('the batch builder is linear', () => {
  it('connects 1,600 wires in well under the time the pure edits need', () => {
    const t0 = performance.now();
    buildCircuit(emptyCircuit('wide'), (d) => {
      const src = d.addComponent({ type: 'pin', x: 0, y: 0, props: { io: 'in', bits: 1 } });
      for (let i = 0; i < 1600; i++) {
        const sink = d.addComponent({ type: 'not', x: 100, y: 40 * i });
        const r = d.connect({ comp: src, pin: 'p' }, { comp: sink, pin: 'in0' });
        if ('error' in r) throw new Error(r.error);
      }
    });
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
