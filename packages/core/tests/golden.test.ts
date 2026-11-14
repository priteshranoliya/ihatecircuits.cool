import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../src/examples';
import { circuitById, lookupIn, useProject } from '../src/project';
import { Recorder, sha, workout } from './golden-trace';
import { T } from './helpers';

/**
 * Golden traces: every net change and output change the simulator produces for the
 * built-in examples and a set of hand-built stress circuits. The file is the engine's
 * recorded behaviour; a performance change must reproduce it byte for byte.
 * Regenerate deliberately with UPDATE_GOLDEN=1.
 */

const GOLDEN = join(import.meta.dirname, 'golden', 'examples.trace.txt');
const update = process.env.UPDATE_GOLDEN === '1';

function exampleLines(): string[] {
  const out: string[] = [];
  for (const ex of EXAMPLES) {
    const p = ex.build();
    useProject(p);
    const main = circuitById(p, p.main)!;
    out.push(`# ${ex.id}`, ...workout(main, lookupIn(p), ex.id));
  }
  return out;
}

function stressLines(): string[] {
  const out: string[] = [];
  const run = (label: string, t: T) => out.push(`# ${label}`, ...workout(t.c, undefined, label));

  {
    const t = new T();
    const en = t.add('switch');
    const g = t.add('nand');
    t.wire(en, 'out', g, 'in0').wire(g, 'out', g, 'in1');
    run('nand-oscillator', t);
  }
  {
    const t = new T();
    const en = t.add('switch');
    const g = t.add('nand', { delay: 3 });
    const a = t.add('not', { delay: 2 });
    const b = t.add('not');
    t.wire(en, 'out', g, 'in0').wire(g, 'out', a, 'in0').wire(a, 'out', b, 'in0').wire(b, 'out', g, 'in1');
    run('ring-three-delays', t);
  }
  {
    const t = new T();
    const s = t.add('switch');
    const r = t.add('switch');
    const n1 = t.add('nor');
    const n2 = t.add('nor', { delay: 2 });
    t.wire(r, 'out', n1, 'in0').wire(s, 'out', n2, 'in1').wire(n1, 'out', n2, 'in0').wire(n2, 'out', n1, 'in1');
    run('nor-latch', t);
  }
  {
    const t = new T();
    const a = t.add('switch');
    const b = t.add('switch');
    const e = t.add('switch');
    const ga = t.add('buffer', { output: '0z' });
    const gb = t.add('buffer', { output: '0z' });
    const tb = t.add('tribuf');
    const pu = t.add('pull', { pull: 'up' });
    const led = t.add('led');
    t.wire(a, 'out', ga, 'in0').wire(b, 'out', gb, 'in0').wire(e, 'out', tb, 'en').wire(a, 'out', tb, 'in0');
    t.wire(ga, 'out', led, 'in').wire(gb, 'out', led, 'in').wire(tb, 'out', led, 'in').wire(pu, 'p', led, 'in');
    run('bus-fight-pull', t);
  }
  {
    const t = new T();
    const d0 = t.add('const', { bits: 4, value: '5' });
    const d1 = t.add('const', { bits: 4, value: 'A' });
    const e0 = t.add('switch');
    const e1 = t.add('switch');
    const b0 = t.add('tribuf', { bits: 4 });
    const b1 = t.add('tribuf', { bits: 4, delay: 2 });
    const probe = t.add('probe');
    t.wire(d0, 'out', b0, 'in0').wire(d1, 'out', b1, 'in0').wire(e0, 'out', b0, 'en').wire(e1, 'out', b1, 'en');
    t.wire(b0, 'out', probe, 'p').wire(b1, 'out', probe, 'p');
    run('bus-conflict', t);
  }
  {
    const t = new T();
    const a = t.add('pin', { io: 'in', bits: 8, behavior: 'tristate', value: '00000011' });
    const b = t.add('pin', { io: 'in', bits: 8, behavior: 'tristate', value: '00000101' });
    const clk = t.add('clock');
    let acc = t.add('adder', { bits: 8 });
    t.wire(a, 'p', acc, 'a').wire(b, 'p', acc, 'b');
    for (let i = 0; i < 6; i++) {
      const next = t.add('adder', { bits: 8, delay: 1 + (i % 3) });
      t.wire(acc, 's', next, 'a').wire(a, 'p', next, 'b');
      acc = next;
    }
    const reg = t.add('register', { bits: 8 });
    const out = t.add('pin', { io: 'out', bits: 8 });
    t.wire(acc, 's', reg, 'd').wire(clk, 'out', reg, 'clk').wire(reg, 'q', out, 'p');
    run('adder-chain-register', t);
  }
  return out;
}

function check(file: string, lines: string[]) {
  const text = lines.join('\n') + '\n';
  if (update) {
    writeFileSync(file, text);
    return;
  }
  const want = readFileSync(file, 'utf8');
  if (want !== text) {
    const a = want.split('\n');
    const b = text.split('\n');
    const i = a.findIndex((l, k) => l !== b[k]);
    throw new Error(`golden trace differs at line ${i + 1}\n  golden: ${a[i]}\n  actual: ${b[i]}\n  (${a.length} golden lines, ${b.length} actual lines, digest ${sha(want)} vs ${sha(text)})`);
  }
}

describe('golden simulator traces', () => {
  it('built-in examples reproduce the recorded trace byte for byte', () => {
    check(GOLDEN, exampleLines());
  });

  it('stress circuits (oscillators, latches, bus fights, clocked adder chains) reproduce the recorded trace', () => {
    check(join(import.meta.dirname, 'golden', 'stress.trace.txt'), stressLines());
  });

  it('a recorder with no events is empty', () => {
    expect(new Recorder().lines).toEqual([]);
  });
});
