import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { Simulator, lookupIn, unknown, useProject, type Circuit, type Project } from '../src/core';
import { Recorder, sha, snapshot } from '../../core/tests/golden-trace';

/**
 * Golden simulator traces for lowered fuzz programs (sizes 3 to 6, with clocks and undriven nets).
 * The circuits are frozen in fuzz-projects.json.gz, so the compiler can change without moving this
 * test. Each settle is recorded as an event count and a digest of every net change and output
 * change in order; the file must reproduce byte for byte. Regenerate with UPDATE_GOLDEN=1.
 */

interface FrozenCase {
  seed: number;
  size: number;
  top: string;
  clock?: string;
  stimulus: Record<string, string>[];
  project: Project;
}

const dir = join(import.meta.dirname, 'golden');
const cases = JSON.parse(gunzipSync(readFileSync(join(dir, 'fuzz-projects.json.gz'))).toString()) as FrozenCase[];

function record(c: FrozenCase): string[] {
  const label = `seed${c.seed}`;
  useProject(c.project);
  const main = c.project.circuits.find((x) => x.id === c.project.main) as Circuit;
  const pinOf = new Map<string, string>();
  for (const comp of Object.values(main.components)) if (comp.type === 'pin') pinOf.set(comp.label, comp.id);
  const rec = new Recorder(false);
  const sim = new Simulator(main, { lookup: lookupIn(c.project) });
  rec.lines.push(`${label} construct stable=${sim.lastSettle.stable} comps=${sim.comps.length} nets=${sim.netlist.nets.length} nets=${sha(snapshot(sim))}`);
  rec.hook(sim, label);
  for (const fc of sim.comps) if (fc.def.type === 'register') sim.setState(fc.id, { q: unknown(Number(fc.comp.props.bits)), clk: null });
  const set = (name: string, value: string) => sim.setRuntime(pinOf.get(name)!, 'value', value);
  const settle = (what: string) => {
    sim.settle();
    rec.settled(sim, label, what);
  };
  settle('start');
  c.stimulus.forEach((cycle, k) => {
    for (const [name, value] of Object.entries(cycle)) set(name, value);
    settle(`cycle ${k}`);
    if (c.clock !== undefined) {
      set(c.clock, '1');
      settle(`cycle ${k} rise`);
      set(c.clock, '0');
      settle(`cycle ${k} fall`);
    }
  });
  const clone = sim.clone();
  rec.hook(clone, `${label}~clone`);
  clone.reset();
  rec.settled(clone, `${label}~clone`, 'reset');
  rec.settled(sim, label, 'original after clone');
  return rec.lines;
}

it('lowered fuzz programs reproduce the recorded simulator trace byte for byte', () => {
  const lines = cases.flatMap((c) => [`# seed ${c.seed} size ${c.size}`, ...record(c)]);
  const text = lines.join('\n') + '\n';
  const file = join(dir, 'fuzz.trace.txt');
  if (process.env.UPDATE_GOLDEN === '1') {
    writeFileSync(file, text);
    return;
  }
  const want = readFileSync(file, 'utf8');
  if (want !== text) {
    const a = want.split('\n');
    const b = text.split('\n');
    const i = a.findIndex((l, k) => l !== b[k]);
    expect.fail(`golden fuzz trace differs at line ${i + 1}\n  golden: ${a[i]}\n  actual: ${b[i]}`);
  }
}, 60_000);
