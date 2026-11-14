import type { ComponentDef, PinDef } from './library';
import { getDef, pinsOf } from './library';
import type { Circuit, Component } from './types';

/**
 * Turns a circuit (possibly containing subcircuit instances) into a flat,
 * bit-level netlist.
 *
 * 1. Wires, tunnels and junctions join pins into pin-nets (union-find).
 * 2. Every pin-net is split into bit nodes; splitters join individual bits
 *    of different pin-nets (they are pure wiring with no delay).
 * 3. Subcircuit instances are flattened: the instance's pin is joined to the
 *    net of the matching Pin component inside the subcircuit.
 * The result lists, for every resolved bit-net, who drives it, who reads it
 * and whether a pull resistor sets its idle level.
 */

export interface FlatComp {
  /** Path id: "c3" at top level, "c3/c7" inside instance c3. */
  id: string;
  comp: Component;
  def: ComponentDef;
  pins: PinDef[];
  /** For each pin: the bit-net of each of its bits. */
  bitNets: number[][];
  /** For each pin: whether anything else is attached to it. */
  connected: boolean[];
  /** A Pin inside a subcircuit instance: it is a port, not a driver. */
  nested?: boolean;
}

export interface BitNet {
  drivers: { comp: number; pin: number; bit: number }[];
  readers: number[];
  pull?: 0 | 1;
}

export interface Netlist {
  comps: FlatComp[];
  nets: BitNet[];
  /** Pin-nets whose pins disagree on width: their wires are drawn as errors. */
  widthErrors: Set<string>;
  /** Wire id (top level only) → bit-nets it carries, for drawing values. */
  wireNets: Map<string, number[]>;
}

/** Resolves a subcircuit component type to the circuit it instantiates. */
export type SubcircuitLookup = (type: string) => Circuit | undefined;

/** Position of the pin with this name, or -1. Parts with many pins (wide multiplexers) get a name index built once. */
const wideIndex = new WeakMap<PinDef[], Map<string, number>>();
function pinIndex(pins: PinDef[], name: string): number {
  if (pins.length <= 8) {
    for (let i = 0; i < pins.length; i++) if (pins[i].name === name) return i;
    return -1;
  }
  let index = wideIndex.get(pins);
  if (!index) {
    index = new Map();
    for (let i = pins.length - 1; i >= 0; i--) index.set(pins[i].name, i);
    wideIndex.set(pins, index);
  }
  return index.get(name) ?? -1;
}

class UnionFind {
  parent: number[] = [];
  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(a: number): number {
    while (this.parent[a] !== a) {
      this.parent[a] = this.parent[this.parent[a]];
      a = this.parent[a];
    }
    return a;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

const byNumericId = (a: { id: string }, b: { id: string }) => Number(a.id.slice(1)) - Number(b.id.slice(1)) || (a.id < b.id ? -1 : 1);

/** The parts of a circuit ordered by numeric id, parsing each id once. */
function inIdOrder(components: Record<string, Component>): Component[] {
  const keyed = Object.values(components).map((comp) => ({ comp, n: Number(comp.id.slice(1)) }));
  keyed.sort((a, b) => a.n - b.n || (a.comp.id < b.comp.id ? -1 : a.comp.id > b.comp.id ? 1 : 0));
  return keyed.map((k) => k.comp);
}

interface PinSlot {
  comp: number;
  pin: number;
  width: number;
}

export function buildNetlist(top: Circuit, lookup: SubcircuitLookup = () => undefined): Netlist {
  const comps: FlatComp[] = [];
  const slots: PinSlot[] = [];
  const pinUF = new UnionFind();
  /** Slot index of each component's pins: slotOf[comp][pin]. */
  const slotOf: number[][] = [];
  const attachCount: number[] = [];
  const wireSlots = new Map<string, number>();
  /** Pins joined for reasons other than wires (tunnels, subcircuit ports). */
  const extraJoins: [number, number][] = [];

  const instantiate = (circuit: Circuit, prefix: string, stack: string[]): Map<string, number> => {
    const local = new Map<string, number>();
    const tunnels = new Map<string, number[]>();
    for (const comp of inIdOrder(circuit.components)) {
      const def = getDef(comp.type);
      const idx = comps.length;
      const pins = pinsOf(comp);
      comps.push({ id: prefix + comp.id, comp, def, pins, bitNets: [], connected: [] });
      local.set(comp.id, idx);
      slotOf[idx] = pins.map((p, pi) => {
        slots.push({ comp: idx, pin: pi, width: p.width });
        attachCount.push(0);
        pinUF.add();
        return slots.length - 1;
      });
      if (def.wiring === 'tunnel') {
        const key = String(comp.props.name ?? comp.label ?? '');
        tunnels.set(key, [...(tunnels.get(key) ?? []), slotOf[idx][0]]);
      }
      if (def.subcircuit) {
        const inner = lookup(comp.type);
        if (inner && !stack.includes(comp.type)) {
          const innerMap = instantiate(inner, `${prefix}${comp.id}/`, [...stack, comp.type]);
          // Join each instance pin to the Pin component inside with the same port name.
          const names = portNames(inner);
          for (const ic of Object.values(inner.components)) {
            if (ic.type !== 'pin') continue;
            const port = names.get(ic.id)!;
            const pi = pins.findIndex((p) => p.name === port);
            if (pi < 0) continue;
            const innerIdx = innerMap.get(ic.id)!;
            extraJoins.push([slotOf[idx][pi], slotOf[innerIdx][0]]);
            comps[innerIdx].nested = true;
          }
        }
      }
    }
    for (const w of Object.values(circuit.wires)) {
      const a = local.get(w.from.comp);
      const b = local.get(w.to.comp);
      if (a === undefined || b === undefined) continue;
      const pa = pinIndex(comps[a].pins, w.from.pin);
      const pb = pinIndex(comps[b].pins, w.to.pin);
      if (pa < 0 || pb < 0) continue;
      const sa = slotOf[a][pa];
      const sb = slotOf[b][pb];
      pinUF.union(sa, sb);
      attachCount[sa]++;
      attachCount[sb]++;
      if (!prefix) wireSlots.set(w.id, sa);
    }
    for (const group of tunnels.values()) {
      for (let i = 1; i < group.length; i++) extraJoins.push([group[0], group[i]]);
    }
    return local;
  };

  instantiate(top, '', []);
  for (const [a, b] of extraJoins) {
    pinUF.union(a, b);
    attachCount[a]++;
    attachCount[b]++;
  }

  // Pin-nets and their width. A net whose pins disagree is a width error.
  // Width-0 pins (probe, pull resistor, junction) adopt the net's width.
  const netWidth = new Map<number, number>();
  const badNets = new Set<number>();
  slots.forEach((s, i) => {
    if (s.width === 0) return;
    const r = pinUF.find(i);
    const w = netWidth.get(r);
    if (w === undefined) netWidth.set(r, s.width);
    else if (w !== s.width) {
      badNets.add(r);
      netWidth.set(r, Math.max(w, s.width));
    }
  });
  slots.forEach((_s, i) => {
    const r = pinUF.find(i);
    if (!netWidth.has(r)) netWidth.set(r, 1);
  });

  // Bit nodes per pin-net.
  const bitUF = new UnionFind();
  const firstBit = new Map<number, number>();
  for (const [r, w] of netWidth) {
    firstBit.set(r, bitUF.parent.length);
    for (let i = 0; i < w; i++) bitUF.add();
  }
  const nodeOf = (slot: number, bit: number) => firstBit.get(pinUF.find(slot))! + bit;

  // Splitters join individual bits across pin-nets.
  comps.forEach((fc, ci) => {
    if (fc.def.wiring !== 'splitter') return;
    const map = splitterMap(fc.comp.props, fc.pins.length - 1);
    map.forEach((fan, bit) => {
      if (fan < 0) return;
      const fanPin = fan + 1;
      const fanBit = map.slice(0, bit).filter((f) => f === fan).length;
      bitUF.union(nodeOf(slotOf[ci][0], bit), nodeOf(slotOf[ci][fanPin], fanBit));
    });
  });

  // Number the resolved bit-nets densely.
  const netIndex = new Map<number, number>();
  const nets: BitNet[] = [];
  const netFor = (node: number) => {
    const r = bitUF.find(node);
    let i = netIndex.get(r);
    if (i === undefined) {
      i = nets.length;
      netIndex.set(r, i);
      nets.push({ drivers: [], readers: [] });
    }
    return i;
  };

  comps.forEach((fc, ci) => {
    fc.bitNets = fc.pins.map((_p, pi) => {
      const root = pinUF.find(slotOf[ci][pi]);
      const w = netWidth.get(root)!;
      // A pin narrower than a (mismatched) net only sees its own bits.
      const own = fc.pins[pi].width || w;
      const count = Math.min(own, w);
      const first = firstBit.get(root)!;
      const nets = new Array<number>(count);
      for (let b = 0; b < count; b++) nets[b] = netFor(first + b);
      return nets;
    });
    fc.connected = fc.pins.map((_, pi) => attachCount[slotOf[ci][pi]] > 0);
    const drivesAsPin = fc.def.type !== 'pin' || !fc.nested;
    // Wiring parts and subcircuit boxes only join nets; the box's insides do the work.
    const passive = (!!fc.def.wiring && fc.def.wiring !== 'probe') || !!fc.def.subcircuit;
    fc.pins.forEach((p, pi) => {
      if (passive) return;
      fc.bitNets[pi].forEach((n, bit) => {
        if ((p.dir === 'out' || p.dir === 'io') && drivesAsPin) nets[n].drivers.push({ comp: ci, pin: pi, bit });
        if (p.dir === 'in' || p.dir === 'io') {
          // Parts are visited in order, so a part that already reads this net through another pin is the last reader added.
          const readers = nets[n].readers;
          if (readers[readers.length - 1] !== ci) readers.push(ci);
        }
      });
    });
    if (fc.def.wiring === 'pull') {
      const level = fc.comp.props.pull === 'down' ? 0 : 1;
      for (const n of fc.bitNets[0]) nets[n].pull = level;
    }
  });

  const widthErrors = new Set<string>();
  const wireNets = new Map<string, number[]>();
  for (const [wid, slot] of wireSlots) {
    if (badNets.has(pinUF.find(slot))) widthErrors.add(wid);
    const s = slots[slot];
    wireNets.set(wid, comps[s.comp].bitNets[s.pin]);
  }
  return { comps, nets, widthErrors, wireNets };
}

/** The port name a Pin component exposes on its subcircuit's outline (its label, or its id when unlabelled). */
export const portName = (pin: Component) => pin.label.trim() || pin.id;

/**
 * Port names for every Pin in a circuit, made unique: a repeated label keeps
 * its text but gains the part id ("X·c7"), so two pins can never share a
 * connection by accident.
 */
export function portNames(c: Circuit): Map<string, string> {
  const pins = Object.values(c.components)
    .filter((x) => x.type === 'pin')
    .sort(byNumericId);
  const seen = new Set<string>();
  const out = new Map<string, string>();
  for (const p of pins) {
    let name = portName(p);
    if (seen.has(name)) name = `${name}·${p.id}`;
    seen.add(name);
    out.set(p.id, name);
  }
  return out;
}

/** Labels used by more than one Pin in a circuit (shown as a warning). */
export function duplicatePortLabels(c: Circuit): string[] {
  const count = new Map<string, number>();
  for (const x of Object.values(c.components)) if (x.type === 'pin') count.set(portName(x), (count.get(portName(x)) ?? 0) + 1);
  return [...count].filter(([, n]) => n > 1).map(([l]) => l);
}

/**
 * For a splitter with `fans` fan-out ends: which fan each combined bit goes to
 * (-1 = not connected). Default: bits shared out evenly, low bits to fan 0.
 */
export function splitterMap(props: Record<string, unknown>, fans: number): number[] {
  const width = Number(props.width ?? 2);
  const spec = typeof props.map === 'string' ? props.map.trim() : '';
  if (spec) {
    const parts = spec.split(/[\s,]+/).map(Number);
    if (parts.length === width && parts.every((n) => Number.isInteger(n) && n >= -1 && n < fans)) return parts;
  }
  return Array.from({ length: width }, (_, b) => Math.min(fans - 1, Math.floor((b * fans) / width)));
}
