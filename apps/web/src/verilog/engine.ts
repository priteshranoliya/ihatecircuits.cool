/**
 * The compiler worker's logic as a pure function from request to response, so the main thread never compiles
 * and tests can run it without a worker. compiler.worker.ts only forwards messages to `handle`.
 */
import { DiagnosticSink, compile, lex, parse, preprocess } from '@ihatecircuits/hdl';
import { ExportError, LowerError, exportVerilog, lowerToProject } from '@ihatecircuits/hdl-bridge';
import { type BuildOutcome, type Request, type Response, toProblems } from './protocol';

/** Names of the modules in the text, in order, even when the text has errors elsewhere. */
export function moduleNames(source: string): string[] {
  try {
    const sink = new DiagnosticSink();
    const pre = preprocess(source, {}, sink);
    const file = parse(lex(pre.map, sink), sink);
    return [...new Set(file.modules.map((m) => m.name.name))];
  } catch {
    return [];
  }
}

const what = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function handle(req: Request): Response {
  switch (req.kind) {
    case 'lint': {
      const r = compile(req.source, { top: req.top });
      return { id: req.id, kind: 'lint', problems: toProblems(r.diagnostics, req.source), modules: moduleNames(req.source), top: r.design?.top };
    }
    case 'build': {
      const r = compile(req.source, { top: req.top });
      const common = { id: req.id, kind: 'build' as const, problems: toProblems(r.diagnostics, req.source), modules: moduleNames(req.source), top: r.design?.top };
      if (!r.design) return { ...common, outcome: { type: 'blocked' } };
      let outcome: BuildOutcome;
      try {
        outcome = { type: 'built', project: lowerToProject(r.design, { view: req.view }), top: r.design.top };
      } catch (e) {
        outcome = { type: 'failed', message: e instanceof LowerError ? e.message : `The builder hit an internal error (${what(e)}). This is a bug in iHateCircuits, not in your design.` };
      }
      return { ...common, outcome };
    }
    case 'export': {
      try {
        return { id: req.id, kind: 'export', text: exportVerilog(req.project) };
      } catch (e) {
        const error = e instanceof ExportError ? `${e.message} Parts that are only for testing by hand, such as switches, LEDs and clocks, have no Verilog form. Use Pin parts for the circuit's inputs and outputs.` : `Could not turn the circuit into Verilog (${what(e)}).`;
        return { id: req.id, kind: 'export', error };
      }
    }
  }
}
