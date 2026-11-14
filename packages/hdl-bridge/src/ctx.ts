import type { Module, NetId } from '@ihatecircuits/hdl';
import type { GB, Src, SupportLib } from './gb';
import type { ModuleGraph } from './graph';

export type View = 'blocks' | 'gates';

/** What a cell needs to turn itself into parts: the module's graph, a gate builder on it, and the nets around it. */
export interface Ctx {
  view: View;
  g: ModuleGraph;
  b: GB;
  m: Module;
  lib: SupportLib;
  circuitOf: (module: string) => string;
  width(net: NetId): number;
  /** Make `src` the driver (or one of the drivers) of an IR net. */
  drive(net: NetId, src: Src): void;
  /** A source for an IR net, to feed any pin. */
  net(net: NetId): Src;
}

/**
 * The `init` property of a register, flip-flop or latch part for an IR power-on value (MSB first over 0 1 x), or undefined
 * when no bit is known (a z bit is x, as a Verilog reg holds it when loaded): such a part keeps the project's power-on 0, and the trace runner sets it to x like any other reg.
 */
export const powerOnProp = (init: string | undefined): string | undefined => (init !== undefined && /[01]/.test(init) ? init.toLowerCase().replace(/z/g, 'x') : undefined);
