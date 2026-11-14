import type { TracePort, TraceResult } from '@ihatecircuits/hdl/trace';

export interface Mismatch {
  cycle: number;
  phase: 'pre' | 'post';
  port: string;
  ref: string;
  ours: string;
}

export type CompareResult =
  | { ok: true }
  | {
      ok: false;
      /** `ref-error` and `ours-error` mean a runner failed to produce a trace; `ports` and `length` are shape differences; `value` carries `mismatch`. */
      kind: 'ref-error' | 'ours-error' | 'ports' | 'length' | 'value';
      message: string;
      mismatch?: Mismatch;
    };

const portKey = (p: TracePort) => `${p.dir} ${p.name}[${p.width}]`;

export interface CompareOptions {
  /** Exact equality: a reference 'x' must be matched by 'x' (and 'z' by 'z'). For targeted runs, since our circuits may legitimately be more precise than Verilog's pessimism. */
  strict?: boolean;
}

/**
 * Does `ours` agree with the reference trace? A reference 'x' accepts any value, because our
 * circuits may be more precise than Verilog's pessimism. Every other reference bit ('0', '1',
 * 'z') must be matched exactly, so an 'x' or 'z' from us where the reference is 0 or 1 fails.
 * With `strict` every bit must match exactly. Reports the first mismatch in cycle order, pre
 * before post, ports in reference order.
 */
export function compareTraces(ref: TraceResult, ours: TraceResult, opts: CompareOptions = {}): CompareResult {
  if (!ref.ok) return { ok: false, kind: 'ref-error', message: `reference failed: ${ref.error}` };
  if (!ours.ok) return { ok: false, kind: 'ours-error', message: `runner failed: ${ours.error}` };

  const a = ref.ports.map(portKey).sort().join(', ');
  const b = ours.ports.map(portKey).sort().join(', ');
  if (a !== b) return { ok: false, kind: 'ports', message: `ports differ: reference {${a}} vs ours {${b}}` };
  if (ref.cycles.length !== ours.cycles.length) {
    return { ok: false, kind: 'length', message: `cycle count differs: reference ${ref.cycles.length} vs ours ${ours.cycles.length}` };
  }

  const outputs = ref.ports.filter((p) => p.dir === 'out');
  for (let cycle = 0; cycle < ref.cycles.length; cycle++) {
    for (const phase of ['pre', 'post'] as const) {
      for (const port of outputs) {
        const r = (ref.cycles[cycle]![phase][port.name] ?? '').toLowerCase();
        const o = (ours.cycles[cycle]![phase][port.name] ?? '').toLowerCase();
        if (!bitsAccept(r, o, port.width, opts.strict === true)) {
          const mismatch: Mismatch = { cycle, phase, port: port.name, ref: r, ours: o };
          return { ok: false, kind: 'value', message: describeMismatch(mismatch), mismatch };
        }
      }
    }
  }
  return { ok: true };
}

function bitsAccept(r: string, o: string, width: number, strict: boolean): boolean {
  if (r.length !== width || o.length !== width) return false;
  if (strict) return r === o;
  for (let i = 0; i < width; i++) if (r[i] !== 'x' && r[i] !== o[i]) return false;
  return true;
}

export function describeMismatch(m: Mismatch): string {
  return `cycle ${m.cycle} ${m.phase} port ${m.port}: reference ${m.ref} vs ours ${m.ours}`;
}
