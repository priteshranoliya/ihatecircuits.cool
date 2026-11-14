import type { NetId } from '@ihatecircuits/hdl';
import { MAX_GATE_INPUTS, ModuleGraph } from './graph';
import type { PinKey } from './layout';

/** A signal: the output pin of a part, or an IR net of the module being lowered (read through whatever pin needs it). */
export type Src = PinKey | { net: NetId };

export const isNet = (s: Src): s is { net: NetId } => 'net' in s;

/** Support circuits (the word-level building blocks of the gates view) are made once and shared by every module of the project. */
export interface SupportLib {
  /** The id of the circuit with this key, built by `build` the first time it is asked for. */
  circuit(key: string, name: string, build: (b: GB) => void): string;
}

export type GateType = 'and' | 'or' | 'xor' | 'nand' | 'nor' | 'xnor';

/**
 * Builds gate-level logic: single-bit and bus-wide gates, multiplexers, constants, splitters and
 * instances of support circuits. Everything returns a `Src` that can feed any number of pins.
 */
export class GB {
  /** The Pin parts, in declaration order (set when this builder makes a support circuit). */
  readonly inputs: number[] = [];
  readonly outputs: number[] = [];

  constructor(
    readonly g: ModuleGraph,
    readonly lib: SupportLib,
  ) {}

  connect(src: Src, to: PinKey) {
    if (isNet(src)) this.g.read(src.net, to);
    else this.g.edge(src, to);
  }

  /** A Sig for sources that must be an output pin (to drive a net). */
  sig(src: Src, width = 1): PinKey {
    if (!isNet(src)) return src;
    const part = this.g.add('extender', { inBits: width, outBits: width, fill: 'zero' });
    this.connect(src, { part, pin: 'in' });
    return { part, pin: 'out' };
  }

  // ---------------------------------------------------------------- ports of a support circuit

  input(name: string, width: number): PinKey {
    const part = this.g.add('pin', { io: 'in', bits: width }, name);
    this.inputs.push(part);
    return { part, pin: 'p' };
  }

  /** An input pin broken into single bits, bit 0 first. */
  inputBits(name: string, width: number): Src[] {
    return this.fan(this.input(name, width), width);
  }

  output(name: string, src: Src, width: number) {
    const part = this.g.add('pin', { io: 'out', bits: width }, name);
    this.outputs.push(part);
    this.connect(src, { part, pin: 'p' });
  }

  outputBits(name: string, bits: Src[]) {
    this.output(name, this.join(bits), bits.length);
  }

  // ---------------------------------------------------------------- wiring

  /** Break a bus into single bits, bit 0 first. A one-bit source is returned as it is. */
  fan(src: Src, width: number): Src[] {
    if (width === 1) return [src];
    return this.g.bitFan(width, (to) => this.connect(src, to));
  }

  /** Join single bits (bit 0 first) into a bus. One bit is returned as it is. */
  join(bits: Src[]): Src {
    if (bits.length === 1) return bits[0]!;
    const part = this.g.add('splitter', { width: bits.length, fans: bits.length }, '', 180);
    bits.forEach((b, i) => this.connect(b, { part, pin: `f${i}` }));
    return { part, pin: 'c' };
  }

  /** The bits `[lsb, lsb + width)` of a bus as a bus of their own. */
  slice(src: Src, srcWidth: number, lsb: number, width: number): Src {
    const bits = this.fan(src, srcWidth);
    return this.join(bits.slice(lsb, lsb + width));
  }

  // ---------------------------------------------------------------- logic

  konst(bit: 0 | 1, bits = 1): PinKey {
    return this.konstWord(bit ? 2n ** BigInt(bits) - 1n : 0n, bits);
  }

  konstWord(value: bigint, bits: number): PinKey {
    const part = this.g.add('const', { bits, value: value.toString(16).toUpperCase() });
    return { part, pin: 'out' };
  }

  not(a: Src, bits = 1): PinKey {
    const part = this.g.add('not', { bits });
    this.connect(a, { part, pin: 'in0' });
    return { part, pin: 'out' };
  }

  /** A gate over several inputs (2..16). For more, use `tree`. */
  gate(type: GateType, ins: Src[], bits = 1): PinKey {
    const part = this.g.add(type, { inputs: ins.length, bits });
    ins.forEach((s, i) => this.connect(s, { part, pin: `in${i}` }));
    return { part, pin: 'out' };
  }

  and(a: Src, b: Src, bits = 1) {
    return this.gate('and', [a, b], bits);
  }
  or(a: Src, b: Src, bits = 1) {
    return this.gate('or', [a, b], bits);
  }
  xor(a: Src, b: Src, bits = 1) {
    return this.gate('xor', [a, b], bits);
  }

  /** A tree of gates over single bits; `type` is the function of the whole tree. */
  tree(type: GateType, bits: Src[]): Src {
    const base = type === 'nand' ? 'and' : type === 'nor' ? 'or' : type === 'xnor' ? 'xor' : type;
    if (bits.length === 1) return type === base ? bits[0]! : this.not(bits[0]!);
    if (bits.length <= MAX_GATE_INPUTS) return this.gate(type, bits);
    const level: Src[] = [];
    for (let i = 0; i < bits.length; i += MAX_GATE_INPUTS) {
      const chunk = bits.slice(i, i + MAX_GATE_INPUTS);
      level.push(chunk.length === 1 ? chunk[0]! : this.gate(base, chunk));
    }
    return this.tree(type, level);
  }

  /** `sel ? d1 : d0`, `bits` wide. */
  mux(sel: Src, d0: Src, d1: Src, bits = 1): PinKey {
    const part = this.g.add('mux', { bits, sel: 1 });
    this.connect(d0, { part, pin: 'd0' });
    this.connect(d1, { part, pin: 'd1' });
    this.connect(sel, { part, pin: 's' });
    return { part, pin: 'y' };
  }

  /** An instance of a support circuit; returns its output pins by name. */
  instance(circuit: string, label: string, inputs: Record<string, Src>, outputs: string[]): Record<string, PinKey> {
    const part = this.g.add(`sub:${circuit}`, {}, label);
    for (const [name, src] of Object.entries(inputs)) this.connect(src, { part, pin: name });
    return Object.fromEntries(outputs.map((o) => [o, { part, pin: o }]));
  }
}
