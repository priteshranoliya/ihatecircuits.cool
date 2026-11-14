import { type Design, type TraceRequest, type TraceResult, type TracePort, type TraceRunner, compile, findModule, formatDiagnostic } from '@ihatecircuits/hdl';
import { type Bits, type Circuit, Simulator, bitAt, lookupIn, unknown, useProject } from './core';
import { type View, powerOnProp } from './ctx';
import { lowerToProject } from './lower';

/**
 * Runs Verilog through the whole pipeline (compile, lower, simulate) under the
 * cycle-trace protocol in @ihatecircuits/hdl/trace.
 *
 * Two places where the library's power-on state differs from Verilog's are
 * handled here, not in the circuit:
 *   - Verilog regs start as x; library registers, flip-flops and latches start at 0.
 *     Before the first cycle every one's stored value is set to x, so unreset
 *     registers show x as they would in a Verilog simulator. The exception is a
 *     part with an `init` property (`reg q = 4'd5;`, a memory word with initial
 *     contents, see memory.ts), which keeps the value that property gives it.
 *   - A fought-over net is 'e' in the library; the trace reports it as 'x'.
 */

function show(b: Bits): string {
  let s = '';
  for (let i = b.w - 1; i >= 0; i--) {
    const v = bitAt(b, i);
    s += v === 'e' ? 'x' : String(v);
  }
  return s;
}

/** What a design needs besides itself to run under the cycle-trace protocol. */
export interface DesignTraceRequest {
  clock?: string;
  stimulus: TraceRequest['stimulus'];
}

function simulate(design: Design, req: Omit<TraceRequest, 'source' | 'top'>, view: View): TraceResult {
  const project = lowerToProject(design, { view });
  useProject(project);
  const main = project.circuits.find((c) => c.id === project.main) as Circuit;
  const top = findModule(design, design.top)!;
  const ports: TracePort[] = top.ports.map((p) => ({ name: p.name, width: p.width, dir: p.dir }));

  const pinOf = new Map<string, string>();
  for (const c of Object.values(main.components)) if (c.type === 'pin') pinOf.set(c.label, c.id);
  const inputs = ports.filter((p) => p.dir === 'in');
  const outputs = ports.filter((p) => p.dir === 'out');

  if (req.clock !== undefined && !inputs.some((p) => p.name === req.clock)) {
    return { ok: false, error: `The clock '${req.clock}' is not an input of '${design.top}'.` };
  }
  const driven = inputs.filter((p) => p.name !== req.clock);
  for (let k = 0; k < req.stimulus.length; k++) {
    for (const [name, value] of Object.entries(req.stimulus[k]!)) {
      const p = driven.find((x) => x.name === name);
      if (!p) return { ok: false, error: `Cycle ${k}: '${name}' is not an input of '${design.top}'${name === req.clock ? ' (the clock is not part of the stimulus)' : ''}.` };
      if (!new RegExp(`^[01]{${p.width}}$`).test(value)) return { ok: false, error: `Cycle ${k}: '${name}' needs ${p.width} binary digits, got '${value}'.` };
    }
  }

  const sim = new Simulator(main, { lookup: lookupIn(project) });
  for (const fc of sim.comps) {
    if (powerOnProp(String(fc.comp.props.init ?? '')) !== undefined) continue;
    if (fc.def.type === 'register') sim.setState(fc.id, { q: unknown(Number(fc.comp.props.bits)), clk: null });
    else if (fc.def.type === 'dff') sim.setState(fc.id, { q: 'x', clk: null });
    else if (fc.def.type === 'dlatch') sim.setState(fc.id, { q: 'x', armed: false });
  }

  const settle = (what: string): string | undefined => (sim.settle().stable ? undefined : `The circuit did not settle ${what}; it may contain a combinational loop.`);
  const set = (name: string, value: string) => sim.setRuntime(pinOf.get(name)!, 'value', value);
  const sample = () => Object.fromEntries(outputs.map((p) => [p.name, show(sim.value(pinOf.get(p.name)!, 'p'))]));

  const first = settle('at start');
  if (first) return { ok: false, error: first };
  const cycles = [];
  for (let k = 0; k < req.stimulus.length; k++) {
    for (const [name, value] of Object.entries(req.stimulus[k]!)) set(name, value);
    let problem = settle(`in cycle ${k}`);
    if (problem) return { ok: false, error: problem };
    const pre = sample();
    let post = pre;
    if (req.clock !== undefined) {
      set(req.clock, '1');
      problem = settle(`after the clock rose in cycle ${k}`);
      if (problem) return { ok: false, error: problem };
      post = sample();
      set(req.clock, '0');
      problem = settle(`after the clock fell in cycle ${k}`);
      if (problem) return { ok: false, error: problem };
    }
    cycles.push({ pre, post });
  }
  return { ok: true, ports, cycles };
}

/** Run an IR design on the lowered circuit, in the blocks or the gates view, under the cycle-trace protocol. */
export function runDesignOnSimulator(design: Design, req: DesignTraceRequest, view: View = 'blocks'): TraceResult {
  try {
    return simulate(design, req, view);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const runSimulator: TraceRunner = (req) => {
  try {
    const compiled = compile(req.source, { top: req.top });
    if (!compiled.design) return { ok: false, error: compiled.diagnostics.map(formatDiagnostic).join('\n') };
    return simulate(compiled.design, req, 'blocks');
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};
