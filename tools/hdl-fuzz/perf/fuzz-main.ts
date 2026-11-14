import { runSimulator } from '@ihatecircuits/hdl-bridge';
import { generateCase, parseFeatureList } from '../src/gen';

const n = Number(process.env.PERF_N ?? 20);
const size = Number(process.env.PERF_SIZE ?? 6);
const seed = Number(process.env.PERF_SEED ?? 100);
const times: number[] = [];
let bad = 0;
for (let i = 0; i < n; i++) {
  const g = generateCase(seed + i, { size, features: parseFeatureList(process.env.PERF_FEATURES ?? '') });
  const t0 = performance.now();
  const r = runSimulator({ source: g.source, top: g.top, clock: g.clock, stimulus: g.stimulus });
  times.push(performance.now() - t0);
  if (r instanceof Promise || !r.ok) bad++;
}
const total = times.reduce((a, b) => a + b, 0);
console.log(`fuzz size ${size}: ${n} programs, mean ${(total / n).toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms, errors ${bad}`);
