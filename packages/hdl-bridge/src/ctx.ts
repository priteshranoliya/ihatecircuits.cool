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

/** Label of a register that must power on at 0 (the project's own power-on state) instead of x. */
export const POWER_ON_MARK = ' (power-on 0)';
