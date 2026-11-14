import type { NetId } from '@ihatecircuits/hdl';
import { sanitizeProps } from './core';
import type { Edge, PartNode, PinKey } from './layout';

export class LowerError extends Error {}

type Rot = 0 | 180;

export const MAX_GATE_INPUTS = 16;

/**
 * Parts and connections of one circuit before they are placed. Cells add parts and read or drive IR nets
 * through it; `finish` turns the net connections into wires.
 */
export class ModuleGraph {
  readonly nodes: PartNode[] = [];
  readonly edges: Edge[] = [];
  private readonly drivers = new Map<NetId, PinKey[]>();
  private readonly sinks = new Map<NetId, PinKey[]>();
  /** Nets that float but read as a level: the part to tie to the net (`pull` with `up` or `down`). */
  private readonly pulls = new Map<NetId, 'up' | 'down'>();
  readonly constBits = new Map<NetId, string>();

  add(type: string, props: Record<string, unknown>, label = '', rot: Rot = 0): number {
    const clean = type.startsWith('sub:') ? {} : { ...sanitizeProps(type, props) };
    this.nodes.push({ type, props: clean, label, rot });
    return this.nodes.length - 1;
  }

  edge(from: PinKey, to: PinKey) {
    this.edges.push({ from, to });
  }

  /** Several drivers of one net are joined at a junction (their values resolve on the net). */
  drive(net: NetId, from: PinKey) {
    const list = this.drivers.get(net) ?? [];
    list.push(from);
    this.drivers.set(net, list);
  }

  /** The net's idle level when nothing drives it. */
  pull(net: NetId, level: 'up' | 'down') {
    this.pulls.set(net, level);
  }

  /** Connect a net to a pin that reads it. A constant gets its own part at every reader, so literals sit next to their use. */
  read(net: NetId, to: PinKey) {
    const bits = this.constBits.get(net);
    if (bits !== undefined) {
      if (/[xz]/.test(bits)) throw new LowerError(`The literal ${bits.length}'b${bits} has x or z bits, which iHateCircuits constants cannot hold.`);
      const part = this.add('const', { bits: bits.length, value: BigInt('0b' + bits).toString(16).toUpperCase() });
      this.edge({ part, pin: 'out' }, to);
      return;
    }
    const list = this.sinks.get(net) ?? [];
    list.push(to);
    this.sinks.set(net, list);
  }

  /**
   * Turn the recorded net connections into edges, in net order. A net that is read but never driven gets a junction,
   * so its readers sit on a real floating net (they read z, which is x to a gate) instead of an unconnected pin.
   * A net with several drivers, or a pull resistor, gets a junction where everything meets.
   */
  finish(nameOf: (net: NetId) => string) {
    const nets = new Set<NetId>([...this.sinks.keys(), ...this.drivers.keys(), ...this.pulls.keys()]);
    for (const net of [...nets].sort((a, b) => a - b)) {
      const drivers = this.drivers.get(net) ?? [];
      const sinks = this.sinks.get(net) ?? [];
      const pull = this.pulls.get(net);
      let hub: PinKey | undefined = drivers.length === 1 && !pull ? drivers[0] : undefined;
      if (!hub && (drivers.length > 1 || pull || sinks.length > 0)) {
        hub = { part: this.add('junction', {}, nameOf(net)), pin: 'p' };
        for (const d of drivers) this.edge(d, hub);
        if (pull) {
          const p = this.add('pull', { pull });
          this.edge(hub, { part: p, pin: 'p' });
        }
      }
      if (hub) for (const to of sinks) this.edge(hub, to);
    }
  }

  /** A splitter that breaks a source into single bits; returns the bit pins, bit 0 first. */
  bitFan(width: number, source: (to: PinKey) => void): PinKey[] {
    const part = this.add('splitter', { width, fans: width });
    source({ part, pin: 'c' });
    return Array.from({ length: width }, (_, i) => ({ part, pin: `f${i}` }));
  }

  /** Reduce single-bit pins with a gate (and/or/xor, or their inverted forms for the last level), as a tree of gates with at most 16 inputs each. */
  reduce(bits: PinKey[], type: 'and' | 'or' | 'xor' | 'nand' | 'nor' | 'xnor'): PinKey {
    const base = type === 'nand' ? 'and' : type === 'nor' ? 'or' : type === 'xnor' ? 'xor' : type;
    const gate = (ins: PinKey[], t: string): PinKey => {
      const part = this.add(t, { inputs: ins.length, bits: 1 });
      ins.forEach((p, i) => this.edge(p, { part, pin: `in${i}` }));
      return { part, pin: 'out' };
    };
    if (bits.length === 1) return type === base ? bits[0]! : this.invert(bits[0]!);
    if (bits.length <= MAX_GATE_INPUTS) return gate(bits, type);
    const firstLevel: PinKey[] = [];
    for (let i = 0; i < bits.length; i += MAX_GATE_INPUTS) {
      const chunk = bits.slice(i, i + MAX_GATE_INPUTS);
      firstLevel.push(chunk.length === 1 ? chunk[0]! : gate(chunk, base));
    }
    return this.reduce(firstLevel, type);
  }

  /** A single-bit inverter. */
  invert(from: PinKey, bits = 1): PinKey {
    const part = this.add('not', { bits });
    this.edge(from, { part, pin: 'in0' });
    return { part, pin: 'out' };
  }
}
