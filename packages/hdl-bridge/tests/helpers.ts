import { compile, type CycleSample, type TracePort, type TraceRequest } from '@ihatecircuits/hdl';
import { lowerToProject, runSimulator } from '../src';

export function project(source: string, top?: string) {
  const r = compile(source, { top });
  if (!r.design) throw new Error(r.diagnostics.map((d) => `${d.span.line}:${d.span.col} ${d.message}`).join('\n'));
  return lowerToProject(r.design, { view: 'blocks' });
}

export function trace(req: TraceRequest): { ports: TracePort[]; cycles: CycleSample[] } {
  const r = runSimulator(req);
  if (r instanceof Promise || !r.ok) throw new Error(r instanceof Promise ? 'async' : r.error);
  return r;
}

export const bin = (v: number, w: number) => (v & (2 ** w - 1)).toString(2).padStart(w, '0');
