import { compile } from '@ihatecircuits/hdl';
import type { TraceRunner } from '@ihatecircuits/hdl/trace';
import { exportVerilog, lowerToProject, runSimulator } from '@ihatecircuits/hdl-bridge';
import type { NamedRunner } from './fuzz';
import { iverilogRunner } from './iverilog';

/**
 * Round trip: our compiler builds the circuit, we export that circuit back to
 * structural Verilog, and the reference simulator runs the export. This checks
 * what our synthesis produced independently of our own simulator.
 */
export const runExportedViaIverilog: TraceRunner = async (req) => {
  const { design, diagnostics } = compile(req.source, { top: req.top });
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (!design || errors.length) return { ok: false, error: errors.map((d) => d.message).join('\n') || 'no design' };
  let text: string;
  try {
    text = exportVerilog(lowerToProject(design, { view: 'blocks' }));
  } catch (e) {
    return { ok: false, error: `export failed: ${(e as Error).message}` };
  }
  const top = /Top module: ([A-Za-z_][A-Za-z0-9_$]*)\./.exec(text)?.[1];
  if (!top) return { ok: false, error: 'export did not name a top module' };
  return iverilogRunner({ ...req, source: text, top });
};

/** Runners compared against the iverilog reference by `npm run fuzz:hdl`, in addition to the built-in self-tests. */
export const extraRunners: NamedRunner[] = [
  { name: 'ihatecircuits', run: runSimulator },
  { name: 'ihatecircuits-export-iverilog', run: runExportedViaIverilog },
];
