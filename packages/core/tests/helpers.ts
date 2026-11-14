import '../src/parts';
import { type Bits, bits, fromStates, toStates, type BitState } from '../src/bits';
import { addComponent, connect, emptyCircuit } from '../src/edit';
import { Simulator } from '../src/sim';
import type { Circuit } from '../src/types';

/** Terse circuit construction for tests. */
export class T {
  c: Circuit = emptyCircuit('test');
  add(type: string, props: Record<string, unknown> = {}, label = ''): string {
    const r = addComponent(this.c, { type, x: 0, y: 0, props, label });
    this.c = r.circuit;
    return r.id;
  }
  wire(a: string, ap: string, b: string, bp: string): this {
    const r = connect(this.c, { comp: a, pin: ap }, { comp: b, pin: bp });
    if ('error' in r) throw new Error(r.error);
    this.c = r.circuit;
    return this;
  }
  sim(): Simulator {
    return new Simulator(this.c);
  }
}

/** Set switches (1-bit) and pins (multi-bit, number) then settle. */
export function drive(sim: Simulator, values: Record<string, boolean | number | string>, c?: Circuit): Simulator {
  for (const [id, v] of Object.entries(values)) {
    const type = c?.components[id]?.type;
    if (type === 'pin' || typeof v === 'string') sim.setRuntime(id, 'value', typeof v === 'string' ? v : v.toString(2));
    else sim.setRuntime(id, 'on', !!v);
  }
  const r = sim.settle();
  if (!r.stable) throw new Error('circuit did not settle');
  return sim;
}

/** Bits as a compact string, MSB first: "01xz". */
export const str = (b: Bits) =>
  toStates(b)
    .reverse()
    .map((s: BitState) => String(s))
    .join('');

export const num = (b: Bits): number | null => (b.x | b.z | b.e ? null : b.v);
export { bits, fromStates };
