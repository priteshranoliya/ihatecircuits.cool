import { describe, expect, it } from 'vitest';
import '../src/parts';
import { bitAt } from '../src/bits';
import { boundsOf } from '../src/geometry';
import { evaluate, mkAnd, mkConst, mkNot, mkOr, mkVar, mkXor, parse, rowAssignment, type AST } from '../src/expr';
import { Simulator } from '../src/sim';
import { buildCircuit, type SynthOptions } from '../src/synth';
import type { Circuit } from '../src/types';

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
const ex = (t: string): AST => {
  const r = parse(t);
  if ('error' in r) throw new Error(r.error.message);
  return r.ast;
};

/** Simulate every input combination and compare each output with the expression. */
function verify(c: Circuit, outputs: { name: string; expr: AST }[], inputs: string[]) {
  const comps = Object.values(c.components);
  const inPins = inputs.map((n) => comps.find((x) => x.type === 'pin' && x.props.io === 'in' && x.label === n)!);
  const outPins = outputs.map((o) => comps.find((x) => x.type === 'pin' && x.props.io === 'out' && x.label === o.name)!);
  expect(inPins.every(Boolean)).toBe(true);
  expect(outPins.every(Boolean)).toBe(true);
  for (let r = 0; r < 1 << inputs.length; r++) {
    const sim = new Simulator(c);
    const asg = rowAssignment(inputs, r);
    inPins.forEach((p, i) => sim.setRuntime(p.id, 'value', String(asg[inputs[i]])));
    expect(sim.settle().stable).toBe(true);
    outputs.forEach((o, k) => {
      const got = bitAt(sim.input(outPins[k].id, 'p'), 0);
      expect(got, `${o.name} row ${r}`).toBe(evaluate(o.expr, asg));
    });
  }
}

function gateTypes(c: Circuit) {
  return new Set(Object.values(c.components).filter((x) => x.type !== 'pin' && x.type !== 'const').map((x) => x.type));
}

function noOverlap(c: Circuit) {
  const boxes = Object.values(c.components).map((x) => ({ id: x.id, ...boundsOf(x) }));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
}

const FORMS: SynthOptions['form'][] = ['expression', 'sop', 'pos'];
const combos: SynthOptions[] = FORMS.flatMap((form) =>
  [false, true].flatMap((twoInputOnly) => [false, true].map((nandOnly) => ({ form, twoInputOnly, nandOnly }))),
);

describe('synthesis', () => {
  it('builds the textbook circuit in every combination', () => {
    const outs = [{ name: 'Y', expr: ex("A·B′ + C") }];
    for (const o of combos) {
      const c = buildCircuit(outs, ['A', 'B', 'C'], o);
      verify(c, outs, ['A', 'B', 'C']);
      noOverlap(c);
    }
  });

  it('uses the requested gate vocabulary', () => {
    const outs = [{ name: 'Y', expr: ex('A ^ B + C·D·E') }];
    const inputs = ['A', 'B', 'C', 'D', 'E'];
    const nand = buildCircuit(outs, inputs, { form: 'expression', twoInputOnly: false, nandOnly: true });
    expect([...gateTypes(nand)]).toEqual(['nand']);
    verify(nand, outs, inputs);
    const two = buildCircuit(outs, inputs, { form: 'sop', twoInputOnly: true, nandOnly: false });
    for (const x of Object.values(two.components)) if (x.type !== 'pin' && x.type !== 'not') expect(Number(x.props.inputs)).toBe(2);
    verify(two, outs, inputs);
    const wide = buildCircuit([{ name: 'Y', expr: ex('A·B·C·D') }], ['A', 'B', 'C', 'D'], { form: 'expression', twoInputOnly: false, nandOnly: false });
    expect(Object.values(wide.components).filter((x) => x.type === 'and')).toHaveLength(1);
    expect(Object.values(wide.components).find((x) => x.type === 'and')!.props.inputs).toBe(4);
  });

  it('SOP of majority is two-level with shared inverters', () => {
    const outs = [{ name: 'M', expr: ex("A'BC + AB'C + ABC' + ABC") }];
    const c = buildCircuit(outs, ['A', 'B', 'C'], { form: 'sop', twoInputOnly: false, nandOnly: false });
    const types = Object.values(c.components).map((x) => x.type);
    expect(types.filter((t) => t === 'and')).toHaveLength(3);
    expect(types.filter((t) => t === 'or')).toHaveLength(1);
    expect(types.filter((t) => t === 'not')).toHaveLength(0);
    verify(c, outs, ['A', 'B', 'C']);
    const sopNand = buildCircuit(outs, ['A', 'B', 'C'], { form: 'sop', twoInputOnly: false, nandOnly: true });
    // NAND-NAND: three first-level NANDs and one output NAND.
    expect(Object.values(sopNand.components).filter((x) => x.type === 'nand')).toHaveLength(4);
    verify(sopNand, outs, ['A', 'B', 'C']);
  });

  it('shares one inverter per input', () => {
    const outs = [{ name: 'Y', expr: ex("A'B + A'C + B'C'") }];
    const c = buildCircuit(outs, ['A', 'B', 'C'], { form: 'expression', twoInputOnly: false, nandOnly: false });
    expect(Object.values(c.components).filter((x) => x.type === 'not')).toHaveLength(3);
    verify(c, outs, ['A', 'B', 'C']);
  });

  it('handles constants, passthrough and multiple outputs', () => {
    const outs = [
      { name: 'Zero', expr: mkConst(0) },
      { name: 'One', expr: mkAnd(mkConst(1), mkConst(1)) },
      { name: 'Same', expr: mkVar('A') },
      { name: 'Folded', expr: mkOr(mkAnd(mkVar('A'), mkConst(1)), mkAnd(mkVar('B'), mkConst(0))) },
      { name: 'Taut', expr: mkOr(mkVar('A'), mkNot(mkVar('A'))) },
      { name: 'Xc', expr: mkXor(mkVar('A'), mkConst(1), mkVar('B')) },
    ];
    for (const o of combos) {
      const c = buildCircuit(outs, ['A', 'B'], o);
      verify(c, outs, ['A', 'B']);
      noOverlap(c);
    }
    const c = buildCircuit(outs, ['A', 'B'], { form: 'expression', twoInputOnly: false, nandOnly: false });
    expect(Object.values(c.components).filter((x) => x.type === 'const').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps unused inputs and labels every port', () => {
    const c = buildCircuit([{ name: 'Y', expr: mkVar('B') }], ['A', 'B', 'C']);
    const labels = Object.values(c.components).map((x) => x.label).sort();
    expect(labels).toEqual(['A', 'B', 'C', 'Y']);
  });

  it('lays parts out on the grid, inputs left of gates left of outputs', () => {
    const outs = [{ name: 'Y', expr: ex("A·B′ + C·D + E′·F") }];
    const inputs = ['A', 'B', 'C', 'D', 'E', 'F'];
    const c = buildCircuit(outs, inputs, { form: 'sop', twoInputOnly: false, nandOnly: false });
    verify(c, outs, inputs);
    noOverlap(c);
    for (const comp of Object.values(c.components)) {
      expect(comp.x % 10).toBe(0);
      expect(comp.y % 10).toBe(0);
      expect(comp.x).toBeGreaterThanOrEqual(0);
      expect(comp.y).toBeGreaterThanOrEqual(0);
    }
    const xs = (f: (x: Circuit['components'][string]) => boolean) => Object.values(c.components).filter(f).map((x) => x.x);
    const inX = Math.max(...xs((x) => x.type === 'pin' && x.props.io === 'in'));
    const outX = Math.min(...xs((x) => x.type === 'pin' && x.props.io === 'out'));
    const gateX = xs((x) => x.type !== 'pin');
    expect(Math.min(...gateX)).toBeGreaterThan(inX);
    expect(Math.max(...gateX)).toBeLessThan(outX);
  });

  it('is deterministic', () => {
    const outs = [{ name: 'Y', expr: ex('A ^ B ^ C + D') }];
    const a = buildCircuit(outs, ['A', 'B', 'C', 'D'], { form: 'sop', twoInputOnly: true, nandOnly: true });
    const b = buildCircuit(outs, ['A', 'B', 'C', 'D'], { form: 'sop', twoInputOnly: true, nandOnly: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('wide gates beyond 16 inputs are split', () => {
    const names = Array.from({ length: 20 }, (_, i) => `X${i}`);
    const outs = [{ name: 'Y', expr: mkAnd(...names.map(mkVar)) }];
    const c = buildCircuit(outs, names, { form: 'expression', twoInputOnly: false, nandOnly: false });
    for (const x of Object.values(c.components)) if (x.type === 'and') expect(Number(x.props.inputs)).toBeLessThanOrEqual(16);
    // spot-check a few vectors rather than 2^20
    const comps = Object.values(c.components);
    const sim = new Simulator(c);
    for (const n of names) sim.setRuntime(comps.find((x) => x.label === n)!.id, 'value', '1');
    sim.settle();
    const y = comps.find((x) => x.label === 'Y')!;
    expect(bitAt(sim.input(y.id, 'p'), 0)).toBe(1);
    sim.setRuntime(comps.find((x) => x.label === 'X7')!.id, 'value', '0');
    sim.settle();
    expect(bitAt(sim.input(y.id, 'p'), 0)).toBe(0);
  });

  it('rejects undeclared variables and duplicate outputs with clear errors', () => {
    expect(() => buildCircuit([{ name: 'Y', expr: mkVar('Z') }], ['A'])).toThrow(/Z/);
    expect(() => buildCircuit([{ name: 'Y', expr: mkVar('A') }, { name: 'Y', expr: mkVar('A') }], ['A'])).toThrow(/different/);
  });

  it('random functions (60, up to 4 inputs) verified by simulation in every combination', () => {
    const rand = rng(2024);
    for (let k = 0; k < 60; k++) {
      const n = 1 + Math.floor(rand() * 4);
      const inputs = ['A', 'B', 'C', 'D'].slice(0, n);
      const nOut = 1 + Math.floor(rand() * 2);
      const outs = Array.from({ length: nOut }, (_, i) => {
        // Random truth table expressed as a canonical SOP so every function is reachable (incl. XOR-heavy ones via XOR terms).
        const terms: AST[] = [];
        for (let m = 0; m < 1 << n; m++)
          if (rand() < 0.45)
            terms.push(mkAnd(...inputs.map((v, j) => ((m >> (n - 1 - j)) & 1 ? mkVar(v) : mkNot(mkVar(v))))));
        let expr: AST = mkOr(...terms);
        if (rand() < 0.3) expr = mkXor(expr, mkVar(inputs[Math.floor(rand() * n)]));
        return { name: `Y${i + 1}`, expr };
      });
      for (const o of combos) {
        const c = buildCircuit(outs, inputs, o);
        verify(c, outs, inputs);
        noOverlap(c);
        if (o.nandOnly) expect([...gateTypes(c)].every((t) => t === 'nand')).toBe(true);
        if (o.twoInputOnly)
          for (const x of Object.values(c.components)) if (['and', 'or', 'nand', 'nor', 'xor', 'xnor'].includes(x.type)) expect(Number(x.props.inputs)).toBe(2);
      }
    }
  });

  it('XOR in NAND mode uses the 4-NAND construction', () => {
    const outs = [{ name: 'Y', expr: ex('A ^ B') }];
    const c = buildCircuit(outs, ['A', 'B'], { form: 'expression', twoInputOnly: false, nandOnly: true });
    expect(Object.values(c.components).filter((x) => x.type === 'nand')).toHaveLength(4);
    verify(c, outs, ['A', 'B']);
  });
});
