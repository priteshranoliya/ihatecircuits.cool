import { compile, type Stimulus } from '@ihatecircuits/hdl';
import { expect } from 'vitest';
import { compareTraces } from '../../../tools/hdl-fuzz/src/compare';
import { irRunners } from '../../../tools/hdl-fuzz/src/ir-runners';
import { iverilogAvailable, iverilogRunner } from '../../../tools/hdl-fuzz/src/iverilog';

export const haveIcarus = iverilogAvailable();

/**
 * Verilog source against Icarus on every back end of the pipeline: the interpreter (exact), the circuit in both views, and
 * the circuit exported to Verilog and run in Icarus. A reference x accepts any value; every other bit must match.
 * Returns the reference trace so a test can also pin the answer the standard gives.
 */
export async function agreeWithIcarus(source: string, stimulus: Stimulus, opts: { clock?: string; top?: string } = {}) {
  const top = opts.top ?? 'top';
  const compiled = compile(source, { top });
  expect(compiled.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
  const ref = await iverilogRunner({ source, top, clock: opts.clock, stimulus });
  if (!ref.ok) throw new Error(ref.error);
  const failures: string[] = [];
  for (const r of irRunners) {
    const verdict = compareTraces(ref, await r.run({ design: compiled.design!, clock: opts.clock, stimulus }), { strict: r.name === 'interp' });
    if (!verdict.ok) failures.push(`${r.name}: ${verdict.message}`);
  }
  expect(failures).toEqual([]);
  return { ref: ref.cycles, diagnostics: compiled.diagnostics };
}
