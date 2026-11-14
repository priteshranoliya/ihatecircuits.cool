import type { Design } from '@ihatecircuits/hdl/design';
import { lowerToProject, type View } from '@ihatecircuits/hdl-bridge';
import { Simulator, lookupIn, useProject } from '@ihatecircuits/hdl-bridge/core';
import { it } from 'vitest';
import { designOf, ModuleBuilder } from '../src/irbuild';

/**
 * Times the gates view of a combinational multiplier: lowering, then one settle per input change.
 *   PERF_MUL=16 PERF_VIEW=gates PERF_STEPS=200 npx vitest run --config tools/hdl-fuzz/vitest.perf.config.ts mul16
 */
const width = Number(process.env.PERF_MUL ?? 16);
const views = (process.env.PERF_VIEW ?? 'gates,blocks').split(',') as View[];
const steps = Number(process.env.PERF_STEPS ?? 200);

function multiplier(w: number, kind: 'mul' | 'divu' | 'divs'): Design {
  const m = new ModuleBuilder('top');
  const a = m.input('a', w);
  const b = m.input('b', w);
  const out = m.net(w);
  m.add({ kind, a, b, out });
  m.output('p', out);
  return designOf(m.build());
}

it('multiplier settle time', () => {
  let seed = 12345;
  const rnd = (bits: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) & (2 ** bits - 1);
  };
  for (const kind of ['mul', 'divu'] as const) {
    for (const view of views) {
      const design = multiplier(width, kind);
      const t0 = performance.now();
      const project = lowerToProject(design, { view });
      const t1 = performance.now();
      useProject(project);
      const main = project.circuits[0]!;
      const sim = new Simulator(main, { lookup: lookupIn(project) });
      const pin = (label: string) => Object.values(main.components).find((c) => c.type === 'pin' && c.label === label)!.id;
      const [pa, pb, pp] = [pin('a'), pin('b'), pin('p')];
      sim.settle();
      const t2 = performance.now();
      let events = 0;
      const times: number[] = [];
      for (let i = 0; i < steps; i++) {
        sim.setRuntime(pa!, 'value', rnd(width).toString(2).padStart(width, '0'));
        sim.setRuntime(pb!, 'value', (rnd(width) | 1).toString(2).padStart(width, '0'));
        const s = performance.now();
        const r = sim.settle();
        times.push(performance.now() - s);
        events += (r as { events?: number }).events ?? 0;
      }
      void pp;
      times.sort((x, y) => x - y);
      const parts = sim.comps.length;
      const mean = times.reduce((x, y) => x + y, 0) / times.length;
      process.stderr.write(
        `${kind}${width} ${view}: ${project.circuits.length} circuits, ${parts} flattened parts, lower ${(t1 - t0).toFixed(0)} ms, build ${(t2 - t1).toFixed(0)} ms, ` +
          `settle mean ${mean.toFixed(2)} ms, median ${times[times.length >> 1]!.toFixed(2)} ms, p95 ${times[Math.floor(times.length * 0.95)]!.toFixed(2)} ms, max ${times[times.length - 1]!.toFixed(2)} ms${events ? `, ${events} events` : ''}\n`,
      );
    }
  }
}, 600_000);
