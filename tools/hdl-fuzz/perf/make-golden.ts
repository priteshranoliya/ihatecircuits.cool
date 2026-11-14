import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { compile } from '@ihatecircuits/hdl';
import { lowerToProject } from '@ihatecircuits/hdl-bridge';
import { generateCase } from '../src/gen';

/** Freezes lowered fuzz programs so the simulator golden test does not depend on the compiler. Run via vitest.perf.config.ts. */
const specs: { seed: number; size: number; features?: Record<string, boolean> }[] = [
  { seed: 8080, size: 3 },
  { seed: 8081, size: 4 },
  { seed: 8082, size: 5 },
  { seed: 8083, size: 6 },
  { seed: 8084, size: 6 },
  { seed: 8181, size: 3, features: { clocks: true, undriven: true } },
  { seed: 8182, size: 4, features: { clocks: true, undriven: true } },
  { seed: 8183, size: 5, features: { clocks: true } },
  { seed: 8184, size: 6, features: { clocks: true } },
  { seed: 8185, size: 6, features: { clocks: true, undriven: true } },
  { seed: 8190, size: 4, features: { undriven: true } },
  { seed: 8191, size: 5, features: { undriven: true } },
];

import type { Circuit, Project } from '@ihatecircuits/core/types';
import { it } from 'vitest';

/** Positions and wire routes do not affect simulation, so the fixture leaves them out. */
function stripGeometry(p: Project): Project {
  const circuits = p.circuits.map((c): Circuit => ({
    ...c,
    components: Object.fromEntries(Object.entries(c.components).map(([k, v]) => [k, { ...v, x: 0, y: 0 }])),
    wires: Object.fromEntries(Object.entries(c.wires).map(([k, { mid: _mid, ...w }]) => [k, w])),
  }));
  return { ...p, circuits };
}

it('make golden fixtures', () => {
  const cases = specs.map((s) => {
    for (let seed = s.seed; ; seed++) {
      const g = generateCase(seed, { size: s.size, features: s.features });
      const c = compile(g.source, { top: g.top });
      if (!c.design) continue;
      return { ...s, seed, top: g.top, clock: g.clock, stimulus: g.stimulus, project: stripGeometry(lowerToProject(c.design, { view: 'blocks' })) };
    }
  });
  const json = JSON.stringify(cases);
  const gz = gzipSync(Buffer.from(json), { level: 9 });
  writeFileSync(join(import.meta.dirname, '../../../packages/hdl-bridge/tests/golden/fuzz-projects.json.gz'), gz);
  process.stderr.write(`fixture ${json.length} bytes raw, ${gz.length} gz; comps ${cases.map((c) => c.project.circuits.reduce((a, x) => a + Object.keys(x.components).length, 0)).join(',')}\n`);
});
