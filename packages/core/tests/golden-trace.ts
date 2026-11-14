import { createHash } from 'node:crypto';
import { type Bits, bitAt } from '../src/bits';
import type { ComponentDef } from '../src/library';
import type { SubcircuitLookup } from '../src/netlist';
import { Simulator } from '../src/sim';
import type { Circuit } from '../src/types';
import '../src/parts';

/**
 * Deterministic recording of everything a Simulator emits, so a rewrite of the
 * engine can be compared byte for byte against the engine it replaces.
 */

export const bitsText = (b: Bits) => {
  let s = '';
  for (let i = b.w - 1; i >= 0; i--) s += String(bitAt(b, i));
  return s;
};

export const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export class Recorder {
  readonly lines: string[] = [];
  private pending: string[] = [];

  /** `full` keeps every event as a line; otherwise each settle is reduced to an event count and a digest. */
  constructor(private readonly full = true) {}

  private put(line: string) {
    (this.full ? this.lines : this.pending).push(line);
  }

  /** Hook a simulator so its trace and net-change events are recorded. */
  hook(sim: Simulator, tag: string) {
    sim.trace = [];
    sim.onNetChange = (t, n) => this.put(`${tag} net t=${t} n=${n}`);
  }

  /** Flush a simulator's trace events, then its settle outcome and a net-value snapshot. */
  settled(sim: Simulator, tag: string, what: string, withNets = true) {
    const events = sim.trace ?? [];
    for (const e of events) this.put(`${tag} out t=${e.t} ${e.id}.${e.pin}=${bitsText(e.value)}`);
    events.length = 0;
    if (!this.full) {
      this.lines.push(`${tag} ${what}: events=${this.pending.length} sha=${sha(this.pending.join('\n'))}`);
      this.pending = [];
    }
    const r = sim.lastSettle;
    this.lines.push(`${tag} ${what}: stable=${r.stable} steps=${r.steps} time=${sim.time} tick=${sim.tick} osc=${sim.oscillating} hot=[${this.full ? [...sim.hot].join(',') : sha([...sim.hot].join(',')) + ':' + sim.hot.size}]`);
    if (withNets) this.lines.push(`${tag} nets ${this.full ? snapshot(sim) : sha(snapshot(sim))}`);
  }
}

export function snapshot(sim: Simulator): string {
  return bitsText(sim.netsValue(sim.netlist.nets.map((_, i) => i)));
}

export const topLevel = (sim: Simulator) => sim.comps.filter((c) => !c.id.includes('/'));

const runtimeProps = (def: ComponentDef) => def.props.filter((p) => p.runtime);

function valuesFor(def: ComponentDef, key: string, width: number): unknown[] {
  const kind = def.props.find((p) => p.key === key)!.kind;
  if (kind === 'bool') return [true, false, true, false];
  if (kind === 'int') return [1, 2, 0, 3].map((v) => Math.min(v, def.props.find((p) => p.key === key)!.max ?? v));
  const w = Math.max(1, width);
  return ['1'.repeat(w), '01'.repeat(w).slice(0, w), '0'.repeat(w), 'z'.repeat(w), '10'.repeat(w).slice(0, w), '1'.repeat(w)];
}

/** A fixed, circuit-agnostic workout: flip every runtime input in turn, then together, with clock ticks and a clone. */
export function workout(circuit: Circuit, lookup: SubcircuitLookup | undefined, label: string, rec = new Recorder()): string[] {
  const sim = new Simulator(circuit, { lookup });
  rec.hook(sim, label);
  rec.lines.push(`${label} construct stable=${sim.lastSettle.stable} steps=${sim.lastSettle.steps} comps=${sim.comps.length} nets=${sim.netlist.nets.length}`);
  rec.lines.push(`${label} nets ${snapshot(sim)}`);
  sim.reset();
  rec.settled(sim, label, 'reset');

  const inputs = topLevel(sim).filter((c) => runtimeProps(c.def).length > 0);
  const plan = inputs.flatMap((c) => runtimeProps(c.def).map((p) => ({ id: c.id, key: p.key, values: valuesFor(c.def, p.key, c.pins[0]?.width ?? 1) })));
  const rounds = Math.max(0, ...plan.map((p) => p.values.length));
  let cloned = false;
  for (let r = 0; r < rounds; r++) {
    for (const p of plan) {
      if (r >= p.values.length) continue;
      sim.setRuntime(p.id, p.key, p.values[r]);
      sim.settle();
      rec.settled(sim, label, `set ${p.id}.${p.key}=${String(p.values[r])}`);
    }
    for (const p of plan) if (r < p.values.length) sim.setRuntime(p.id, p.key, p.values[(r + 1) % p.values.length]);
    sim.settle();
    rec.settled(sim, label, `all round ${r}`);
    for (let k = 0; k < 3; k++) {
      sim.step();
      rec.settled(sim, label, `step ${r}.${k}`);
    }
    if (!cloned && r === 1) {
      cloned = true;
      const c = sim.clone();
      rec.hook(c, `${label}~clone`);
      for (const p of plan.slice(0, 2)) {
        c.setRuntime(p.id, p.key, p.values[0]);
        c.settle();
        rec.settled(c, `${label}~clone`, `set ${p.id}.${p.key}`);
      }
      c.step();
      rec.settled(c, `${label}~clone`, 'step');
      rec.settled(sim, label, 'original after clone', true);
    }
  }
  const carried = new Simulator(circuit, { lookup, prev: sim });
  rec.lines.push(`${label}~prev construct stable=${carried.lastSettle.stable} steps=${carried.lastSettle.steps} time=${carried.time} tick=${carried.tick}`);
  rec.lines.push(`${label}~prev nets ${snapshot(carried)}`);
  rec.hook(carried, `${label}~prev`);
  carried.step();
  carried.step();
  rec.settled(carried, `${label}~prev`, 'steps');
  return rec.lines;
}
