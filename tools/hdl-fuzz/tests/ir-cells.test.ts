import { runDesign } from '@ihatecircuits/hdl/interp';
import type { Design, NetId } from '@ihatecircuits/hdl/design';
import { designToVerilog } from '@ihatecircuits/hdl-bridge/irVerilog';
import { describe, expect, it } from 'vitest';
import { compareTraces } from '../src/compare';
import { designOf, ModuleBuilder } from '../src/irbuild';
import { irReference, irRunners } from '../src/ir-runners';
import { iverilogAvailable, iverilogRunner } from '../src/iverilog';

const haveIcarus = iverilogAvailable();

/** Every string of length w over `alphabet`. */
function strings(w: number, alphabet: string): string[] {
  let all = [''];
  for (let i = 0; i < w; i++) all = all.flatMap((s) => [...alphabet].map((c) => s + c));
  return all;
}

type Maker = (m: ModuleBuilder, ins: NetId[], w: number) => NetId;

interface CellCase {
  name: string;
  inputs: (w: number) => number[];
  make: Maker;
}

const binary = (kind: 'and' | 'or' | 'xor' | 'xnor' | 'add' | 'sub' | 'mul' | 'divu' | 'remu' | 'divs' | 'rems'): CellCase => ({
  name: kind,
  inputs: (w) => [w, w],
  make: (m, [a, b], w) => {
    const out = m.net(w);
    m.add({ kind, a: a!, b: b!, out });
    return out;
  },
});
const compare = (kind: 'eq' | 'ne' | 'ltu' | 'lts'): CellCase => ({
  name: kind,
  inputs: (w) => [w, w],
  make: (m, [a, b]) => {
    const out = m.net(1);
    m.add({ kind, a: a!, b: b!, out });
    return out;
  },
});
const reduce = (kind: 'reduce_and' | 'reduce_or' | 'reduce_xor'): CellCase => ({
  name: kind,
  inputs: (w) => [w],
  make: (m, [a]) => {
    const out = m.net(1);
    m.add({ kind, a: a!, out });
    return out;
  },
});
const shiftCase = (kind: 'shl' | 'shr' | 'sshr', amountWidth: (w: number) => number): CellCase => ({
  name: `${kind}/amount${amountWidth(0) === 0 ? 'W' : amountWidth(0)}`,
  inputs: (w) => [w, amountWidth(w) || w],
  make: (m, [a, amount], w) => {
    const out = m.net(w);
    m.add({ kind, a: a!, amount: amount!, out });
    return out;
  },
});

const CASES: CellCase[] = [
  { name: 'not', inputs: (w) => [w], make: (m, [a], w) => (m.add({ kind: 'not', a: a!, out: m.net(w) }), m.cells.length ? (m.cells[m.cells.length - 1] as { out: NetId }).out : 0) },
  ...(['and', 'or', 'xor', 'xnor', 'add', 'sub', 'mul', 'divu', 'remu', 'divs', 'rems'] as const).map(binary),
  ...(['eq', 'ne', 'ltu', 'lts'] as const).map(compare),
  ...(['reduce_and', 'reduce_or', 'reduce_xor'] as const).map(reduce),
  shiftCase('shl', () => 0),
  shiftCase('shr', () => 0),
  shiftCase('sshr', () => 0),
  shiftCase('shl', () => 2),
  shiftCase('sshr', () => 3),
  shiftCase('shr', () => 5),
  {
    name: 'mux',
    inputs: (w) => [1, w, w],
    make: (m, [sel, f, t], w) => {
      const out = m.net(w);
      m.add({ kind: 'mux', sel: sel!, onFalse: f!, onTrue: t!, out });
      return out;
    },
  },
];

/**
 * A net of the given bits. With `floating`, bits that are not 0 or 1 come from a net nothing drives, because a circuit
 * has no way to make a constant with an unknown bit; a cell reads such a bit as x.
 */
function valueNet(m: ModuleBuilder, bits: string, floating: boolean): NetId {
  const net = m.net(bits.length);
  if (!floating || !/[xz]/.test(bits)) {
    m.add({ kind: 'const', out: net, bits });
    return net;
  }
  const parts: NetId[] = [];
  for (let i = 0; i < bits.length; ) {
    const c = bits[i]!;
    if (c === 'x' || c === 'z') {
      parts.push(m.net(1));
      i++;
      continue;
    }
    let j = i;
    while (j < bits.length && (bits[j] === '0' || bits[j] === '1')) j++;
    const run = m.net(j - i);
    m.add({ kind: 'const', out: run, bits: bits.slice(i, j) });
    parts.push(run);
    i = j;
  }
  m.add({ kind: 'concat', parts, out: net });
  return net;
}

/** A design whose outputs are one cell per input combination, fed by constants (or by floating nets). */
function combDesign(c: CellCase, w: number, combos: string[][], floating = false): Design {
  const m = new ModuleBuilder('t');
  const widths = c.inputs(w);
  combos.forEach((combo, k) => {
    const ins = combo.map((bits, i) => {
      void widths[i];
      return valueNet(m, bits, floating);
    });
    m.output(`o${k}`, c.make(m, ins, w));
  });
  return designOf(m.build());
}

function combosFor(c: CellCase, w: number): string[][] {
  const widths = c.inputs(w);
  const alphabet = (bits: number) => (bits <= 2 ? '01xz' : bits === 3 ? '01x' : '01');
  let all: string[][] = [[]];
  for (const width of widths) all = all.flatMap((prefix) => strings(width, alphabet(width)).map((s) => [...prefix, s]));
  return all;
}

async function check(design: Design) {
  const stimulus = [{}];
  const ours = runDesign({ design, stimulus });
  const ref = await iverilogRunner({ source: designToVerilog(design), top: 't', stimulus });
  expect(compareTraces(ref, ours, { strict: true })).toEqual({ ok: true });
}

function thin(combos: string[][], limit: number): string[][] {
  return combos.length > limit ? combos.filter((_, i) => i % Math.ceil(combos.length / limit) === 0) : combos;
}

describe.skipIf(!haveIcarus)('IR cells: interpreter against Icarus on the printed IR', () => {
  for (const c of CASES) {
    for (const w of [1, 2, 3, 4]) {
      it(`${c.name} at ${w} bit${w > 1 ? 's' : ''}`, async () => {
        await check(combDesign(c, w, thin(combosFor(c, w), 6000)));
      }, 120_000);
    }
  }
});

/** Every runner against the reference (Icarus on the printed IR). A reference x accepts any value. */
async function checkAll(design: Design, label: string) {
  const req = { design, stimulus: [{}] };
  const ref = await irReference.run(req);
  const failures: string[] = [];
  for (const r of irRunners) {
    const got = await r.run(req);
    const verdict = compareTraces(ref, got, { strict: r.name === 'interp' });
    if (!verdict.ok) failures.push(`${label} ${r.name}: ${verdict.message}`);
  }
  expect(failures).toEqual([]);
}

describe.skipIf(!haveIcarus)('IR cells: every back end against the reference, exhaustively at small widths', () => {
  for (const c of CASES) {
    for (const w of [1, 2, 3, 4]) {
      it(`${c.name} at ${w} bit${w > 1 ? 's' : ''}`, async () => {
        const combos = thin(combosFor(c, w), 450);
        for (let i = 0; i < combos.length; i += 150) await checkAll(combDesign(c, w, combos.slice(i, i + 150), true), `${c.name}/${w}`);
      }, 300_000);
    }
  }
});

