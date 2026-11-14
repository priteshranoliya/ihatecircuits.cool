import { type Bits, floating, fromStates, isKnown, sameBits, unknown, asInput, type BitState } from './bits';
import type { ComponentDef, EvalCtx } from './library';
import { buildNetlist, type FlatComp, type Netlist, type SubcircuitLookup } from './netlist';
import type { Circuit, Props } from './types';

/** Per-bit net state codes. */
const S0 = 0,
  S1 = 1,
  SX = 2,
  SZ = 3,
  SE = 4;

/** Events due at one instant, in the order they were scheduled. */
interface Bucket {
  comp: number[];
  pin: number[];
  value: Bits[];
}

/**
 * Event queue ordered by (time, schedule order). Every event's time is `now + delay` with
 * delay >= 1, so events pile up in a few distinct instants; each instant keeps its events in
 * arrival order, which is exactly the order a (time, sequence number) heap would give.
 */
class Queue {
  private readonly buckets = new Map<number, Bucket>();
  /** Min-heap of the distinct instants that have events. */
  private readonly times: number[] = [];
  private readonly spare: Bucket[] = [];
  size = 0;

  /** The earliest instant with an event. Only valid while `size > 0`. */
  get next(): number {
    return this.times[0];
  }

  clear() {
    for (const b of this.buckets.values()) this.release(b);
    this.buckets.clear();
    this.times.length = 0;
    this.size = 0;
  }

  push(t: number, comp: number, pin: number, value: Bits) {
    let b = this.buckets.get(t);
    if (!b) {
      b = this.spare.pop() ?? { comp: [], pin: [], value: [] };
      this.buckets.set(t, b);
      this.addTime(t);
    }
    b.comp.push(comp);
    b.pin.push(pin);
    b.value.push(value);
    this.size++;
  }

  /** Remove and return every event at the earliest instant. Hand the bucket back with `release`. */
  take(): Bucket {
    const t = this.popTime();
    const b = this.buckets.get(t)!;
    this.buckets.delete(t);
    this.size -= b.comp.length;
    return b;
  }

  release(b: Bucket) {
    b.comp.length = 0;
    b.pin.length = 0;
    b.value.length = 0;
    this.spare.push(b);
  }

  private addTime(t: number) {
    const h = this.times;
    h.push(t);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p] <= t) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = t;
  }

  private popTime(): number {
    const h = this.times;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= h.length) break;
        const r = l + 1;
        const m = r < h.length && h[r] < h[l] ? r : l;
        if (h[m] >= last) break;
        h[i] = h[m];
        i = m;
      }
      h[i] = last;
    }
    return top;
  }
}

export interface SimOptions {
  /** Propagation steps (gate delays) without settling before a circuit is declared oscillating. */
  maxSteps?: number;
}

export interface SettleResult {
  stable: boolean;
  /** Simulated propagation time this settle took, in gate delays. */
  steps: number;
}

/** One output change, recorded when `trace` is enabled. */
export interface TraceEvent {
  t: number;
  id: string;
  pin: string;
  value: Bits;
}

const DEFAULT_MAX_STEPS = 1000;

/**
 * Event-driven, deterministic simulator over a flattened bit-level netlist.
 *
 * Every component has a propagation delay (default 1). When an input changes
 * at time t, the component is evaluated and its new outputs take effect at
 * t + delay. Events at the same time are applied together, and components are
 * evaluated in a fixed order against the values at that instant, so results
 * never depend on creation order. Wires, splitters and tunnels have no delay.
 */
export class Simulator {
  readonly netlist: Netlist;
  readonly comps: FlatComp[];
  private readonly netVal: Uint8Array;
  /** Driven value of each output/io pin: outs[comp][pin] (undefined for input pins). */
  private outs: (Bits | undefined)[][];
  private scheduled: (Bits | undefined)[][];
  private states: unknown[];
  private props: Props[];
  /** Components to evaluate at the next step: a flag per component plus the list of flagged ones. */
  private dirtyFlag: Uint8Array;
  private dirtyList: number[] = [];
  private queue = new Queue();
  private readonly byId = new Map<string, number>();
  private readonly pinIdx: Map<string, number>[];
  private readonly drivers: NetDrivers;
  /** First slot of each component's pins in `simple`. */
  private readonly pinBase: Int32Array;
  /** Per pin, once looked at: 1 if bit k of the pin is the only driver of its k-th bit-net (and none is pulled), else 2. */
  private readonly simple: Uint8Array;
  private readonly maxSteps: number;
  private scratch: Scratch;
  private evalCtx = this.makeContext();
  /** Simulated time in gate delays. */
  time = 0;
  /** Clock ticks since start/reset. */
  tick = 0;
  oscillating = false;
  /** Components still changing when oscillation was declared. */
  hot = new Set<string>();
  lastSettle: SettleResult = { stable: true, steps: 0 };
  /** When set, every output change is appended here (for glitch analysis in tests). */
  trace: TraceEvent[] | null = null;
  /** When set, called with (time, net) whenever a bit-net's resolved value changes. */
  onNetChange: ((time: number, net: number) => void) | null = null;

  constructor(circuit: Circuit, opts: SimOptions & { lookup?: SubcircuitLookup; prev?: Simulator } = {}) {
    this.netlist = buildNetlist(circuit, opts.lookup);
    this.comps = this.netlist.comps;
    // A circuit without feedback settles within the sum of all delays, so the
    // oscillation limit must exceed that for large circuits.
    const totalDelay = this.comps.reduce((sum, c) => sum + Math.max(1, Number(c.comp.props.delay ?? c.def.delay ?? 1)), 0);
    this.maxSteps = opts.maxSteps ?? Math.max(DEFAULT_MAX_STEPS, totalDelay + 10);
    this.netVal = new Uint8Array(this.netlist.nets.length).fill(SZ);
    this.drivers = netDrivers(this.netlist);
    this.pinBase = new Int32Array(this.comps.length + 1);
    this.comps.forEach((c, i) => (this.pinBase[i + 1] = this.pinBase[i] + c.pins.length));
    this.simple = new Uint8Array(this.pinBase[this.comps.length]);
    this.scratch = newScratch(this.comps.length);
    this.dirtyFlag = new Uint8Array(this.comps.length);
    this.pinIdx = this.comps.map((c) => new Map(c.pins.map((p, i) => [p.name, i])));
    this.comps.forEach((c, i) => this.byId.set(c.id, i));
    const prev = opts.prev;
    this.props = this.comps.map((c) => c.comp.props);
    this.states = this.comps.map((c) => {
      const o = prev?.indexOf(c.id);
      if (o !== undefined && prev!.comps[o].comp.type === c.comp.type && sameConfig(prev!.comps[o].comp.props, c.comp.props, c.def)) return prev!.states[o];
      return c.def.init?.(c.comp.props);
    });
    this.outs = this.comps.map((c) => {
      const o = prev?.indexOf(c.id);
      return c.pins.map((p) => {
        if (p.dir === 'in') return undefined;
        const old = o !== undefined ? prev!.outs[o]?.[prev!.pinIdx[o].get(p.name) ?? -1] : undefined;
        if (old && old.w === p.width && prev!.comps[o!].comp.type === c.comp.type) return old;
        return p.dir === 'io' ? floating(p.width) : unknown(p.width);
      });
    });
    this.scheduled = this.outs.map((o) => [...o]);
    if (prev) {
      this.time = prev.time;
      this.tick = prev.tick;
    }
    for (let n = 0; n < this.netVal.length; n++) this.resolveNet(n);
    for (let i = 0; i < this.comps.length; i++) this.markDirty(i);
    this.settle();
  }

  private indexOf(id: string) {
    return this.byId.get(id);
  }

  private isSimple(ci: number, pi: number): boolean {
    const slot = this.pinBase[ci] + pi;
    let known = this.simple[slot];
    if (!known) {
      const d = this.drivers;
      const nets = this.comps[ci].bitNets[pi];
      known = nets.length > 0 && nets.every((n, bit) => d.count[n] === 1 && d.pull[n] < 0 && d.comp[n] === ci && d.pin[n] === pi && d.bit[n] === bit) ? 1 : 2;
      this.simple[slot] = known;
    }
    return known === 1;
  }

  private markDirty(ci: number) {
    if (this.dirtyFlag[ci]) return;
    this.dirtyFlag[ci] = 1;
    this.dirtyList.push(ci);
  }

  /** Recompute one bit-net from its drivers. Returns true if its value changed. */
  private resolveNet(n: number): boolean {
    const d = this.drivers;
    const count = d.count[n];
    const pull = d.pull[n];
    let v: number;
    if (count === 0) v = pull < 0 ? SZ : pull;
    else if (count === 1) {
      const code = bitCode(this.outs[d.comp[n]][d.pin[n]]!, d.bit[n]);
      // A conflicted or unknown lone driver reads as x; a floating one falls back to the pull level.
      v = code === SE ? SX : code === SZ && pull >= 0 ? pull : code;
    } else {
      let ones = false;
      let zeros = false;
      let unk = false;
      const list = this.netlist.nets[n].drivers;
      for (let i = 0; i < list.length; i++) {
        const dr = list[i];
        const code = bitCode(this.outs[dr.comp][dr.pin]!, dr.bit);
        if (code === S1) ones = true;
        else if (code === S0) zeros = true;
        else if (code !== SZ) unk = true;
      }
      if (unk) v = SX;
      else if (ones && zeros) v = SE;
      else if (ones) v = S1;
      else if (zeros) v = S0;
      else v = pull < 0 ? SZ : pull;
    }
    if (this.netVal[n] === v) return false;
    this.netVal[n] = v;
    return true;
  }

  /** Current value on a pin's net(s), as the pin sees it. */
  private pinValue(ci: number, pi: number): Bits {
    return netsBits(this.netVal, this.comps[ci].bitNets[pi]);
  }

  /**
   * One context reused for every evaluation. `aim` points it at a component; its methods then read
   * that component's pins from closure variables, which is faster than looking the part up on every call.
   */
  private makeContext(): { ctx: EvalCtx & { props: Props; state: unknown; tick: number }; aim: (ci: number) => void } {
    let idx: Map<string, number>;
    let c: FlatComp;
    let ci = 0;
    const ctx = {
      props: {} as Props,
      state: undefined as unknown,
      tick: 0,
      raw: (name: string) => this.pinValue(ci, need(idx, name)),
      get: (name: string) => {
        const pi = need(idx, name);
        const p = c.pins[pi];
        if (!c.connected[pi] && p.floatAs !== undefined) return floatBits(p.width, p.floatAs);
        return asInput(netsBits(this.netVal, c.bitNets[pi]));
      },
      connected: (name: string) => c.connected[need(idx, name)],
    };
    const aim = (to: number) => {
      ci = to;
      c = this.comps[to];
      idx = this.pinIdx[to];
    };
    return { ctx, aim };
  }

  private evaluate(ci: number) {
    const c = this.comps[ci];
    const def = c.def;
    if ((def.wiring && def.wiring !== 'probe') || def.subcircuit) return;
    const idx = this.pinIdx[ci];
    const ctx = this.evalCtx.ctx;
    this.evalCtx.aim(ci);
    ctx.props = this.props[ci];
    ctx.state = this.states[ci];
    ctx.tick = this.tick;
    const res = def.eval(ctx);
    if (res.state !== undefined) this.states[ci] = res.state;
    const delay = Math.max(1, Number(this.props[ci].delay ?? def.delay ?? 1));
    const due = this.time + delay;
    const out = res.out;
    for (const name in out) {
      const pi = idx.get(name);
      if (pi === undefined || c.pins[pi].dir === 'in') continue;
      const value = out[name];
      const width = c.pins[pi].width;
      const v = value.w === width ? value : fit(value, width);
      const last = this.scheduled[ci][pi];
      if (last && sameBits(last, v)) continue;
      this.scheduled[ci][pi] = v;
      this.queue.push(due, ci, pi, v);
    }
  }

  /** Run events until nothing changes, or flag oscillation after `maxSteps` gate delays. */
  settle(): SettleResult {
    const start = this.time;
    const sc = this.scratch;
    const epoch = ++sc.settleEpoch;
    sc.touched.length = 0;
    for (;;) {
      if (this.dirtyList.length) {
        const order = this.dirtyList;
        this.dirtyList = [];
        sortAscending(order);
        for (let i = 0; i < order.length; i++) this.dirtyFlag[order[i]] = 0;
        for (let i = 0; i < order.length; i++) this.evaluate(order[i]);
      }
      if (!this.queue.size) break;
      const t = this.queue.next;
      if (t - start > this.maxSteps) {
        this.oscillating = true;
        // Parts that kept switching during the last quarter of the run.
        const cutoff = start + this.maxSteps * 0.75;
        const hot = new Set<string>();
        for (const ci of sc.touched) if (sc.lastChange[ci] >= cutoff) hot.add(this.comps[ci].id);
        this.hot = hot;
        this.queue.clear();
        this.scheduled = this.outs.map((o) => [...o]);
        return (this.lastSettle = { stable: false, steps: this.time - start });
      }
      this.time = t;
      const batch = this.queue.take();
      const trace = this.trace;
      const comp = batch.comp;
      const pin = batch.pin;
      const value = batch.value;
      const n = comp.length;
      const olds = sc.olds;
      // Apply every event due now before resolving any net, so a net sees all of this instant's drivers.
      for (let i = 0; i < n; i++) {
        const ci = comp[i];
        const pi = pin[i];
        const v = value[i];
        const old = this.outs[ci][pi]!;
        if (sameBits(old, v)) {
          comp[i] = -1;
          continue;
        }
        olds[i] = old;
        this.outs[ci][pi] = v;
        if (sc.touchedEpoch[ci] !== epoch) {
          sc.touchedEpoch[ci] = epoch;
          sc.touched.push(ci);
        }
        sc.lastChange[ci] = t;
        if (trace) trace.push({ t, id: this.comps[ci].id, pin: this.comps[ci].pins[pi].name, value: v });
      }
      // Resolve the nets those events touched, in order. A net touched twice resolves to the same value the second time and reports nothing.
      const netVal = this.netVal;
      const nets = this.netlist.nets;
      for (let i = 0; i < n; i++) {
        const ci = comp[i];
        if (ci < 0) continue;
        const pi = pin[i];
        const bitNets = this.comps[ci].bitNets[pi];
        if (this.isSimple(ci, pi)) {
          // Each bit-net is driven by this pin alone, so a net holds its bit's state and only bits that differ from the previous value can change.
          const out = this.outs[ci][pi]!;
          const was = olds[i];
          const diff = ((out.v ^ was.v) | ((out.x | out.e) ^ (was.x | was.e)) | (out.z ^ was.z)) >>> 0;
          for (let k = 0; k < bitNets.length; k++) {
            if (!((diff >>> k) & 1)) continue;
            const net = bitNets[k];
            const code = bitCode(out, k);
            if (netVal[net] === (code === SE ? SX : code)) continue;
            netVal[net] = code === SE ? SX : code;
            this.onNetChange?.(t, net);
            const readers = nets[net].readers;
            for (let r = 0; r < readers.length; r++) this.markDirty(readers[r]);
          }
        } else {
          for (let k = 0; k < bitNets.length; k++) {
            const net = bitNets[k];
            if (this.resolveNet(net)) {
              this.onNetChange?.(t, net);
              const readers = nets[net].readers;
              for (let r = 0; r < readers.length; r++) this.markDirty(readers[r]);
            }
          }
        }
      }
      this.queue.release(batch);
    }
    this.oscillating = false;
    this.hot = new Set();
    return (this.lastSettle = { stable: true, steps: this.time - start });
  }

  /** Advance every clock by one tick and settle. */
  step(): SettleResult {
    this.tick++;
    this.comps.forEach((c, i) => {
      if (c.def.clocked) this.markDirty(i);
    });
    return this.settle();
  }

  /** Change a runtime prop (switch position, button press) of a top-level part. Call settle() after. */
  setRuntime(id: string, key: string, value: unknown) {
    const i = this.indexOf(id);
    if (i === undefined) throw new Error(`No component ${id}`);
    if (this.props[i][key] === value) return;
    this.props[i] = { ...this.props[i], [key]: value as never };
    this.markDirty(i);
  }

  /** Replace a part's internal state (poking a flip-flop, editing RAM). Call settle() after. */
  setState(id: string, state: unknown) {
    const i = this.indexOf(id);
    if (i === undefined) throw new Error(`No component ${id}`);
    this.states[i] = state;
    this.markDirty(i);
  }

  /** Power-on state: stored values cleared, outputs unknown, clocks at tick 0. Inputs keep their positions. */
  reset(): SettleResult {
    this.tick = 0;
    this.time = 0;
    this.queue.clear();
    this.comps.forEach((c, ci) => {
      this.states[ci] = c.def.persistent ? this.states[ci] : c.def.init?.(this.props[ci]);
      this.outs[ci] = c.pins.map((p) => (p.dir === 'in' ? undefined : p.dir === 'io' ? floating(p.width) : unknown(p.width)));
      this.markDirty(ci);
    });
    this.scheduled = this.outs.map((o) => [...o]);
    for (let n = 0; n < this.netVal.length; n++) this.resolveNet(n);
    return this.settle();
  }

  has(id: string) {
    return this.byId.has(id);
  }

  /** Value on the net at a pin of a top-level (or path-addressed) part. */
  value(id: string, pin: string): Bits {
    const ci = this.indexOf(id);
    const pi = ci === undefined ? undefined : this.pinIdx[ci].get(pin);
    if (ci === undefined || pi === undefined) return unknown(1);
    return this.pinValue(ci, pi);
  }

  /** Value a part's input actually reads (unconnected control pins use their default). */
  input(id: string, pin: string): Bits {
    const ci = this.indexOf(id);
    const pi = ci === undefined ? undefined : this.pinIdx[ci].get(pin);
    if (ci === undefined || pi === undefined) return unknown(1);
    const p = this.comps[ci].pins[pi];
    if (!this.comps[ci].connected[pi] && p.floatAs !== undefined) return fromStates(Array(p.width).fill(p.floatAs));
    return this.pinValue(ci, pi);
  }

  connected(id: string, pin: string): boolean {
    const ci = this.indexOf(id);
    const pi = ci === undefined ? undefined : this.pinIdx[ci].get(pin);
    return ci !== undefined && pi !== undefined && this.comps[ci].connected[pi];
  }

  /** Bit-nets of a top-level part's pin (for following a signal over time). */
  netsOf(id: string, pin: string): number[] | null {
    const ci = this.indexOf(id);
    const pi = ci === undefined ? undefined : this.pinIdx[ci].get(pin);
    return ci === undefined || pi === undefined ? null : this.comps[ci].bitNets[pi];
  }

  /** Current value of a list of bit-nets, bit 0 first. */
  netsValue(nets: readonly number[]): Bits {
    return netsBits(this.netVal, nets);
  }

  /** Value carried by a top-level wire. */
  wire(id: string): Bits | null {
    const nets = this.netlist.wireNets.get(id);
    return nets ? netsBits(this.netVal, nets) : null;
  }

  wireWidthError(id: string) {
    return this.netlist.widthErrors.has(id);
  }

  stateOf(id: string): unknown {
    const i = this.indexOf(id);
    return i === undefined ? undefined : this.states[i];
  }

  propsOf(id: string): Props | undefined {
    const i = this.indexOf(id);
    return i === undefined ? undefined : this.props[i];
  }

  /** Independent copy for analysis (truth tables, test vectors). */
  clone(): Simulator {
    const c = Object.create(Simulator.prototype) as Simulator;
    Object.assign(c, this, {
      netVal: this.netVal.slice(),
      outs: this.outs.map((o) => [...o]),
      scheduled: this.scheduled.map((o) => [...o]),
      states: [...this.states],
      props: [...this.props],
      dirtyFlag: this.dirtyFlag.slice(),
      dirtyList: [...this.dirtyList],
      queue: new Queue(),
      scratch: newScratch(this.comps.length),
      hot: new Set(this.hot),
      trace: null,
      onNetChange: null,
    });
    c.evalCtx = c.makeContext();
    return c;
  }
}

/** Sort component indices ascending, in place. Lists usually arrive sorted already, so check first. */
function sortAscending(list: number[]) {
  for (let i = 1; i < list.length; i++) {
    if (list[i - 1] > list[i]) {
      const sorted = Int32Array.from(list).sort();
      for (let k = 0; k < sorted.length; k++) list[k] = sorted[k];
      return;
    }
  }
}

/** Reusable per-simulator working memory for `settle`, so a settle allocates nothing per event. */
interface Scratch {
  settleEpoch: number;
  /** Components whose output changed during the current settle, in order of first change. */
  touched: number[];
  touchedEpoch: Uint32Array;
  /** Time of each component's latest output change. */
  lastChange: Float64Array;
  /** The value each event in the current batch replaced. */
  olds: Bits[];
}

function newScratch(comps: number): Scratch {
  return { settleEpoch: 0, touched: [], touchedEpoch: new Uint32Array(comps), lastChange: new Float64Array(comps), olds: [] };
}

/** Driver tables flattened into typed arrays; the first driver of each net is stored inline. */
interface NetDrivers {
  count: Int32Array;
  comp: Int32Array;
  pin: Int32Array;
  bit: Int32Array;
  /** Pull level (0 or 1), or -1 when the net has no pull resistor. */
  pull: Int8Array;
}

function netDrivers(nl: Netlist): NetDrivers {
  const n = nl.nets.length;
  const t: NetDrivers = { count: new Int32Array(n), comp: new Int32Array(n), pin: new Int32Array(n), bit: new Int32Array(n), pull: new Int8Array(n).fill(-1) };
  nl.nets.forEach((net, i) => {
    t.count[i] = net.drivers.length;
    if (net.drivers.length) {
      t.comp[i] = net.drivers[0].comp;
      t.pin[i] = net.drivers[0].pin;
      t.bit[i] = net.drivers[0].bit;
    }
    if (net.pull !== undefined) t.pull[i] = net.pull;
  });
  return t;
}

const floatCache = new Map<number, Bits>();

/** What an unconnected control pin of `width` bits reads instead of floating. */
function floatBits(width: number, level: 0 | 1): Bits {
  const key = width * 2 + level;
  let b = floatCache.get(key);
  if (!b) {
    b = fromStates(Array(width).fill(level));
    floatCache.set(key, b);
  }
  return b;
}

/** The state code of one bit of a value. */
function bitCode(b: Bits, i: number): number {
  const m = 1 << i;
  if (b.e & m) return SE;
  if (b.x & m) return SX;
  if (b.z & m) return SZ;
  return b.v & m ? S1 : S0;
}

/** The value of a list of bit-nets, bit 0 first. */
function netsBits(netVal: Uint8Array, nets: readonly number[]): Bits {
  let v = 0;
  let x = 0;
  let z = 0;
  let e = 0;
  for (let i = 0; i < nets.length; i++) {
    const code = netVal[nets[i]];
    const m = 1 << i;
    if (code === S1) v |= m;
    else if (code === SX) x |= m;
    else if (code === SZ) z |= m;
    else if (code === SE) e |= m;
  }
  return { w: nets.length, v: v >>> 0, x: x >>> 0, z: z >>> 0, e: e >>> 0 };
}

function need(idx: Map<string, number>, name: string): number {
  const i = idx.get(name);
  if (i === undefined) throw new Error(`Unknown pin "${name}"`);
  return i;
}

function bitState(b: Bits, i: number): BitState {
  const m = 1 << i;
  if (b.e & m) return 'e';
  if (b.x & m) return 'x';
  if (b.z & m) return 'z';
  return b.v & m ? 1 : 0;
}

/** Truncate or zero-extend a value to a pin's width (defensive; components should match widths). */
function fit(b: Bits, w: number): Bits {
  const states = Array.from({ length: w }, (_, i) => (i < b.w ? bitState(b, i) : 0));
  return fromStates(states as BitState[]);
}

function sameConfig(a: Props, b: Props, def: ComponentDef): boolean {
  return a === b || def.props.every((p) => p.runtime || a[p.key] === b[p.key]);
}

export { isKnown };
