import { type Design, compile } from '../src';
import { IrSim } from '../src/interp';

/** Compile and return the design, failing the test with the diagnostics when it does not compile. */
export function design(source: string, top?: string): Design {
  const r = compile(source, { top });
  if (!r.design) throw new Error(`did not compile:\n${r.diagnostics.map((d) => `${d.span.line}:${d.span.col} ${d.message}`).join('\n')}`);
  return r.design;
}

export function sim(source: string, top?: string): IrSim {
  return new IrSim(design(source, top));
}
