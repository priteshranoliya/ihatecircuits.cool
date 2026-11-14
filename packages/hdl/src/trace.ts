/**
 * Cycle-trace contract shared by every way of running a design: our own
 * pipelines and external reference simulators used in differential tests.
 *
 * Protocol, for each cycle k (race-free by construction):
 *   1. apply stimulus[k] to the input ports (clock held at 0), let it settle;
 *   2. sample every output port            -> trace[k].pre
 *   3. raise the clock (0 -> 1), let it settle;
 *   4. sample every output port            -> trace[k].post
 *   5. lower the clock (1 -> 0), let it settle.
 * Before cycle 0 every input is 0 and the clock is 0.
 *
 * Values are strings of '0' '1' 'x' 'z', most significant bit first, exactly
 * `width` characters long. A conflict (two drivers disagree) is reported as 'x',
 * as Verilog does.
 */

export interface TracePort {
  name: string;
  width: number;
  dir: 'in' | 'out';
}

/** One map per cycle: input port name -> binary string (no 'x'/'z' in stimulus). */
export type Stimulus = Array<Record<string, string>>;

export interface CycleSample {
  pre: Record<string, string>;
  post: Record<string, string>;
}

export interface TraceRequest {
  /** Verilog source text. */
  source: string;
  /** Name of the top module. */
  top: string;
  /** Name of the clock input port, if the design has one. It is excluded from `stimulus`. */
  clock?: string;
  stimulus: Stimulus;
}

export type TraceResult = { ok: true; ports: TracePort[]; cycles: CycleSample[] } | { ok: false; error: string };

/** Anything that can run a design under the protocol above. */
export type TraceRunner = (req: TraceRequest) => TraceResult | Promise<TraceResult>;
