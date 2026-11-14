import { compile } from '@ihatecircuits/hdl';
import { lowerToProject, runSimulator } from '@ihatecircuits/hdl-bridge';
import { it } from 'vitest';

const sizes = (process.env.PERF_CHAIN ?? '100,1000').split(',').map(Number);

it('a+a+... chain', () => {
  for (const n of sizes) {
    const source = `module top(input [7:0] a, output [7:0] o);\n  assign o = ${Array(n).fill('a').join(' + ')};\nendmodule\n`;
    const t0 = performance.now();
    const c = compile(source, { top: 'top' });
    const t1 = performance.now();
    lowerToProject(c.design!, { view: 'blocks' });
    const t2 = performance.now();
    const r = runSimulator({ source, top: 'top', stimulus: [{ a: '00000011' }, { a: '00000101' }] });
    const t3 = performance.now();
    const res = r instanceof Promise ? 'async' : r.ok ? JSON.stringify(r.cycles.map((c) => c.pre)) : r.error;
    process.stderr.write(`chain n=${n}: compile ${(t1 - t0).toFixed(0)} ms, lower ${(t2 - t1).toFixed(0)} ms, runSimulator total ${(t3 - t2).toFixed(0)} ms ${res}\n`);
  }
});
