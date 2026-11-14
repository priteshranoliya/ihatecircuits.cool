import { compile } from '../src';
import { type Cell, type Design, type MemoryCell, type Module, type Net, type NetId, findModule } from '../src/design';
import type { CycleSample, TracePort, TraceRunner } from '../src/trace';

/**
 * Four-state reference evaluator for the word-level IR (design.ts). A test helper: clarity over speed.
 *
 * Values are MSB-first strings over 0/1/x/z. Each module instance owns its nets, registers and
 * memories. Combinational cells are evaluated in place, in creation order, until no net changes
 * (starting from x, so a feedback loop such as an SR latch keeps its state between settles).
 * Level-sensitive state (latch, adff reset) and clock edges are only acted on at a settled point, so
 * transient values while the logic converges never reach a register.
 *
 * Choices where design.ts is silent
 * - An input port that was never set reads x. An unconnected callee input reads z.
 * - tribuf reads `a` raw: a z on `a` stays z, so buses can pass through a buffer.
 * - A clock keeps its last known level while it is unknown; only a transition between two known
 *   levels is an edge (0 -> x -> 1 counts as an edge, x -> 1 on a clock never known does not).
 * - Edges: the first wave after a set()/tick samples every D, enable and address from the nets as
 *   they were before the inputs changed (nonblocking semantics, also for gated clocks). Waves caused by
 *   register outputs (ripple clocks) sample the settled values after the previous wave.
 * - adff with an unknown arst commits the merged value to its state (the reset may have happened).
 * - Memory: an unknown en at an edge with a valid address makes that whole word x; an invalid or
 *   unknown address writes nothing whatever en is. Write ports apply in port order, later wins.
 * - A latch in transparent state with unknown d simply follows d (x).
 */

type Level = '0' | '1';

const WAVE_LIMIT = 64;
const LEVEL_LIMIT = 64;

const allOf = (c: string, n: number) => c.repeat(n);
const allX = (n: number) => allOf('x', n);
const isKnown = (s: string) => !/[xz]/.test(s);
const readZ = (s: string) => s.replace(/z/g, 'x');
const toBig = (s: string) => BigInt(`0b${s}`);
const fromBig = (n: bigint, w: number) => BigInt.asUintN(w, n).toString(2).padStart(w, '0');

const zip = (a: string, b: string, f: (p: string, q: string) => string) => {
  let r = '';
  for (let i = 0; i < a.length; i++) r += f(a[i]!, b[i]!);
  return r;
};

const and1 = (p: string, q: string) => (p === '0' || q === '0' ? '0' : p === '1' && q === '1' ? '1' : 'x');
const or1 = (p: string, q: string) => (p === '1' || q === '1' ? '1' : p === '0' && q === '0' ? '0' : 'x');
const xor1 = (p: string, q: string) => (p === 'x' || q === 'x' ? 'x' : p === q ? '0' : '1');
const not1 = (p: string) => (p === '0' ? '1' : p === '1' ? '0' : 'x');
const notv = (s: string) => zip(s, s, (p) => not1(p));
const same = (a: string, b: string) => zip(a, b, (p, q) => (p === q ? p : 'x'));

function eqv(a: string, b: string): string {
  let unknown = false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p === 'x' || q === 'x') unknown = true;
    else if (p !== q) return '0';
  }
  return unknown ? 'x' : '1';
}

function shift(kind: 'shl' | 'shr' | 'sshr', a: string, amount: string): string {
  const w = a.length;
  if (!isKnown(amount)) return allX(w);
  const amt = toBig(amount);
  const n = amt >= BigInt(w) ? w : Number(amt);
  if (kind === 'shl') return a.slice(n) + allOf('0', n);
  if (kind === 'shr') return allOf('0', n) + a.slice(0, w - n);
  return allOf(a[0]!, n) + a.slice(0, w - n);
}

function arith(kind: string, a: string, b: string): string {
  const w = a.length;
  if (!isKnown(a) || !isKnown(b)) return allX(w);
  const x = toBig(a);
  const y = toBig(b);
  switch (kind) {
    case 'add':
      return fromBig(x + y, w);
    case 'sub':
      return fromBig(x - y, w);
    case 'mul':
      return fromBig(x * y, w);
  }
  if (y === 0n) return allX(w);
  const sx = BigInt.asIntN(w, x);
  const sy = BigInt.asIntN(w, y);
  switch (kind) {
    case 'divu':
      return fromBig(x / y, w);
    case 'remu':
      return fromBig(x % y, w);
    case 'divs':
      return fromBig(sx / sy, w);
    default:
      return fromBig(sx % sy, w);
  }
}

function resolveBits(kind: Net['kind'], w: number, vals: string[]): string {
  if (kind === 'supply0') return allOf('0', w);
  if (kind === 'supply1') return allOf('1', w);
  let out = '';
  for (let i = 0; i < w; i++) {
    const driven = vals.map((v) => v[i]!).filter((b) => b !== 'z');
    let bit: string;
    if (driven.length === 0) bit = 'z';
    else if (kind === 'wand') bit = driven.reduce(and1);
    else if (kind === 'wor') bit = driven.reduce(or1);
    else bit = driven.every((b) => b === driven[0]) ? driven[0]! : 'x';
    if (bit === 'z') bit = kind === 'pull0' ? '0' : kind === 'pull1' ? '1' : 'z';
    out += bit;
  }
  return out;
}

function readWord(m: MemoryCell, words: string[], addr: string): string {
  if (!isKnown(addr)) return allX(m.width);
  const a = toBig(addr);
  return a < BigInt(m.depth) ? words[Number(a)]! : allX(m.width);
}

interface MemState {
  words: string[];
  rdata: string[];
}

interface Fire {
  ci: number;
  kind: 'c' | 'r' | 'w';
  port: number;
}

class Inst {
  readonly nets: string[] = [];
  private readonly width: number[] = [];
  private readonly kind: Net['kind'][] = [];
  private readonly slotNet: number[] = [];
  private readonly slotVal: string[] = [];
  private readonly drivers: number[][] = [];
  private readonly cellSlots: number[][] = [];
  private readonly inSlot = new Map<string, number>();
  private readonly regs: string[] = [];
  private readonly mems = new Map<number, MemState>();
  private readonly prev = new Map<string, Level>();
  private readonly kids = new Map<number, Inst>();
  private fired: Fire[] = [];
  private snap: string[] = [];

  constructor(
    design: Design,
    readonly mod: Module,
  ) {
    for (const n of mod.nets) {
      this.width[n.id] = n.width;
      this.kind[n.id] = n.kind;
      this.drivers[n.id] = [];
    }
    for (const p of mod.ports) if (p.dir === 'in') this.inSlot.set(p.name, this.newSlot(p.net));
    mod.cells.forEach((c, ci) => {
      this.cellSlots[ci] = this.outputsOf(c).map((net) => this.newSlot(net));
      if (c.kind === 'dff' || c.kind === 'adff' || c.kind === 'latch') this.regs[ci] = allX(this.width[c.q]!);
      if (c.kind === 'memory') {
        this.mems.set(ci, {
          words: Array.from({ length: c.depth }, (_, i) => c.init?.[i] ?? allX(c.width)),
          rdata: c.readPorts.map(() => allX(c.width)),
        });
      }
      if (c.kind === 'instance') {
        const callee = findModule(design, c.module);
        if (!callee) throw new Error(`ir4: unknown module ${c.module}`);
        const kid = new Inst(design, callee);
        for (const p of callee.ports) if (p.dir === 'in' && !(p.name in c.inputs)) kid.setInput(p.name, allOf('z', p.width));
        this.kids.set(ci, kid);
      }
    });
    for (const n of mod.nets) this.resolveNet(n.id);
  }

  private outputsOf(c: Cell): NetId[] {
    switch (c.kind) {
      case 'dff':
      case 'adff':
      case 'latch':
        return [c.q];
      case 'memory':
        return c.readPorts.map((p) => p.data);
      case 'instance':
        return Object.values(c.outputs);
      default:
        return [c.out];
    }
  }

  private newSlot(net: NetId): number {
    const s = this.slotNet.length;
    this.slotNet.push(net);
    this.slotVal.push(allX(this.width[net]!));
    this.drivers[net]!.push(s);
    return s;
  }

  private resolveNet(id: NetId): boolean {
    const ds = this.drivers[id]!;
    const kind = this.kind[id];
    const nv =
      ds.length === 1 && (kind === undefined || kind === 'wire')
        ? this.slotVal[ds[0]!]!
        : resolveBits(
            kind,
            this.width[id]!,
            ds.map((s) => this.slotVal[s]!),
          );
    if (nv === this.nets[id]) return false;
    this.nets[id] = nv;
    return true;
  }

  private setSlot(s: number, v: string): boolean {
    if (this.slotVal[s] === v) return false;
    this.slotVal[s] = v;
    return this.resolveNet(this.slotNet[s]!);
  }

  setInput(name: string, v: string): boolean {
    return this.setSlot(this.inSlot.get(name)!, v);
  }

  portValue(name: string): string {
    return this.nets[this.mod.ports.find((p) => p.name === name)!.net]!;
  }

  private rd(id: NetId): string {
    return readZ(this.nets[id]!);
  }

  takeSnap(): void {
    this.snap = this.nets.slice();
    for (const k of this.kids.values()) k.takeSnap();
  }

  pass(): boolean {
    let changed = false;
    for (let ci = 0; ci < this.mod.cells.length; ci++) if (this.evalCell(ci)) changed = true;
    return changed;
  }

  fixpoint(): void {
    const bound = 64 + 4 * this.mod.cells.length * (1 + this.kids.size);
    for (let i = 0; i < bound; i++) if (!this.pass()) return;
  }

  private evalCell(ci: number): boolean {
    const c = this.mod.cells[ci]!;
    const slots = this.cellSlots[ci]!;
    switch (c.kind) {
      case 'dff':
        return this.setSlot(slots[0]!, this.regs[ci]!);
      case 'adff':
        return this.setSlot(slots[0]!, this.adffAt(c, this.regs[ci]!, this.rd(c.arst)));
      case 'latch':
        return this.setSlot(slots[0]!, this.latchOut(c, this.regs[ci]!));
      case 'memory': {
        const st = this.mems.get(ci)!;
        let changed = false;
        c.readPorts.forEach((p, i) => {
          const v = p.clk === undefined ? readWord(c, st.words, this.rd(p.addr)) : st.rdata[i]!;
          if (this.setSlot(slots[i]!, v)) changed = true;
        });
        return changed;
      }
      case 'instance': {
        const kid = this.kids.get(ci)!;
        let changed = false;
        for (const [name, net] of Object.entries(c.inputs)) if (kid.setInput(name, this.nets[net]!)) changed = true;
        if (kid.pass()) changed = true;
        Object.keys(c.outputs).forEach((name, i) => {
          if (this.setSlot(slots[i]!, kid.portValue(name))) changed = true;
        });
        return changed;
      }
      default:
        return this.setSlot(slots[0]!, this.comb(c));
    }
  }

  private comb(c: Exclude<Cell, { kind: 'dff' | 'adff' | 'latch' | 'memory' | 'instance' }>): string {
    const w = this.width[c.out]!;
    switch (c.kind) {
      case 'const':
        return c.bits;
      case 'not':
        return notv(this.rd(c.a));
      case 'and':
        return zip(this.rd(c.a), this.rd(c.b), and1);
      case 'or':
        return zip(this.rd(c.a), this.rd(c.b), or1);
      case 'xor':
        return zip(this.rd(c.a), this.rd(c.b), xor1);
      case 'xnor':
        return notv(zip(this.rd(c.a), this.rd(c.b), xor1));
      case 'add':
      case 'sub':
      case 'mul':
      case 'divu':
      case 'remu':
      case 'divs':
      case 'rems':
        return arith(c.kind, this.rd(c.a), this.rd(c.b));
      case 'shl':
      case 'shr':
      case 'sshr':
        return shift(c.kind, this.rd(c.a), this.rd(c.amount));
      case 'eq':
        return eqv(this.rd(c.a), this.rd(c.b));
      case 'ne':
        return not1(eqv(this.rd(c.a), this.rd(c.b)));
      case 'ltu':
      case 'lts': {
        const a = this.rd(c.a);
        const b = this.rd(c.b);
        if (!isKnown(a) || !isKnown(b)) return 'x';
        const n = a.length;
        const [p, q] = c.kind === 'ltu' ? [toBig(a), toBig(b)] : [BigInt.asIntN(n, toBig(a)), BigInt.asIntN(n, toBig(b))];
        return p < q ? '1' : '0';
      }
      case 'reduce_and': {
        const a = this.rd(c.a);
        return a.includes('0') ? '0' : a.includes('x') ? 'x' : '1';
      }
      case 'reduce_or': {
        const a = this.rd(c.a);
        return a.includes('1') ? '1' : a.includes('x') ? 'x' : '0';
      }
      case 'reduce_xor': {
        const a = this.rd(c.a);
        return a.includes('x') ? 'x' : String([...a].filter((b) => b === '1').length % 2);
      }
      case 'mux': {
        const sel = this.rd(c.sel);
        const f = this.rd(c.onFalse);
        const t = this.rd(c.onTrue);
        return sel === '1' ? t : sel === '0' ? f : same(f, t);
      }
      case 'concat':
        return c.parts.map((p) => this.rd(p)).join('');
      case 'slice': {
        const a = this.rd(c.a);
        return a.slice(a.length - c.lsb - w, a.length - c.lsb);
      }
      case 'tribuf': {
        const en = this.rd(c.en);
        const a = this.nets[c.a]!;
        return en === '1' ? a : en === '0' ? allOf('z', w) : [...a].map((b) => (b === 'z' ? 'z' : 'x')).join('');
      }
    }
  }

  private adffAt(c: Extract<Cell, { kind: 'adff' }>, base: string, arst: string): string {
    if (arst === String(c.arstLevel)) return c.arstValue;
    if (arst === 'x') return zip(c.arstValue, base, (r, b) => (r === b ? r : 'x'));
    return base;
  }

  private latchOut(c: Extract<Cell, { kind: 'latch' }>, q: string): string {
    const en = this.rd(c.en);
    const d = this.rd(c.d);
    if (en === String(c.enLevel)) return d;
    if (en === 'x') return same(q, d);
    return q;
  }

  commitLevels(): boolean {
    let changed = false;
    this.mod.cells.forEach((c, ci) => {
      let nq: string | undefined;
      if (c.kind === 'latch') nq = this.latchOut(c, this.regs[ci]!);
      else if (c.kind === 'adff') nq = this.adffAt(c, this.regs[ci]!, this.rd(c.arst));
      if (nq !== undefined && nq !== this.regs[ci]) {
        this.regs[ci] = nq;
        changed = true;
      }
    });
    for (const k of this.kids.values()) if (k.commitLevels()) changed = true;
    return changed;
  }

  levelFix(): void {
    for (let i = 0; i < LEVEL_LIMIT; i++) {
      this.fixpoint();
      if (!this.commitLevels()) return;
    }
  }

  private edgeOf(key: string, clk: NetId, edge: 'pos' | 'neg'): boolean {
    const cur = this.rd(clk);
    if (cur !== '0' && cur !== '1') return false;
    const before = this.prev.get(key);
    this.prev.set(key, cur);
    return before !== undefined && before !== cur && (cur === '1') === (edge === 'pos');
  }

  detect(): boolean {
    this.fired = [];
    this.mod.cells.forEach((c, ci) => {
      if ((c.kind === 'dff' || c.kind === 'adff') && this.edgeOf(`${ci}`, c.clk, c.edge)) this.fired.push({ ci, kind: 'c', port: 0 });
      if (c.kind === 'memory') {
        c.readPorts.forEach((p, i) => {
          if (p.clk !== undefined && this.edgeOf(`${ci}r${i}`, p.clk, p.edge ?? 'pos')) this.fired.push({ ci, kind: 'r', port: i });
        });
        c.writePorts.forEach((p, i) => {
          if (this.edgeOf(`${ci}w${i}`, p.clk, p.edge)) this.fired.push({ ci, kind: 'w', port: i });
        });
      }
    });
    let any = this.fired.length > 0;
    for (const k of this.kids.values()) if (k.detect()) any = true;
    return any;
  }

  commit(useSnap: boolean): void {
    const src = useSnap ? this.snap : this.nets;
    const get = (id: NetId) => readZ(src[id]!);
    for (const f of this.fired) {
      const c = this.mod.cells[f.ci]!;
      if (c.kind === 'dff') this.regs[f.ci] = get(c.d);
      else if (c.kind === 'adff') this.regs[f.ci] = this.adffAt(c, get(c.d), get(c.arst));
      else if (c.kind === 'memory' && f.kind === 'r') {
        const st = this.mems.get(f.ci)!;
        st.rdata[f.port] = readWord(c, st.words, get(c.readPorts[f.port]!.addr));
      }
    }
    for (const f of this.fired) {
      const c = this.mod.cells[f.ci]!;
      if (c.kind !== 'memory' || f.kind !== 'w') continue;
      const p = c.writePorts[f.port]!;
      const addr = get(p.addr);
      if (!isKnown(addr) || toBig(addr) >= BigInt(c.depth)) continue;
      const en = get(p.en);
      const words = this.mems.get(f.ci)!.words;
      if (en === '1') words[Number(toBig(addr))] = get(p.data);
      else if (en === 'x') words[Number(toBig(addr))] = allX(c.width);
    }
    this.fired = [];
    for (const k of this.kids.values()) k.commit(useSnap);
  }
}

export class Ir4Sim {
  private readonly root: Inst;
  private readonly ports = new Map<string, Module['ports'][number]>();

  constructor(design: Design) {
    const top = findModule(design, design.top);
    if (!top) throw new Error(`ir4: no top module ${design.top}`);
    this.root = new Inst(design, top);
    for (const p of top.ports) this.ports.set(p.name, p);
    this.settle(false);
  }

  set(port: string, bits: string): this {
    return this.setMany({ [port]: bits });
  }

  /** Applies several inputs as one change, so an edge samples the values from before all of them. */
  setMany(values: Record<string, string>): this {
    const parsed = Object.entries(values).map(([port, bits]) => {
      const p = this.ports.get(port);
      if (!p || p.dir !== 'in') throw new Error(`ir4: no input port ${port}`);
      const v = bits.toLowerCase();
      if (v.length !== p.width || !/^[01xz]+$/.test(v)) throw new Error(`ir4: bad value '${bits}' for ${port}[${p.width}]`);
      return [port, v] as const;
    });
    this.root.takeSnap();
    for (const [port, v] of parsed) this.root.setInput(port, v);
    this.settle(true);
    return this;
  }

  get(port: string): string {
    const p = this.ports.get(port);
    if (!p) throw new Error(`ir4: no port ${port}`);
    return this.root.portValue(port);
  }

  tick(clk: string, edge: 'pos' | 'neg' = 'pos'): this {
    const drive = (v: string) => this.set(clk, v);
    if (edge === 'pos') {
      if (this.get(clk) !== '0') drive('0');
      drive('1');
      drive('0');
    } else {
      if (this.get(clk) !== '1') drive('1');
      drive('0');
    }
    return this;
  }

  private settle(useSnap: boolean): void {
    for (let wave = 0; wave < WAVE_LIMIT; wave++) {
      this.root.levelFix();
      if (!this.root.detect()) return;
      this.root.commit(useSnap && wave === 0);
    }
    this.root.levelFix();
  }
}

export function ir4Runner(opts: { top?: string } = {}): TraceRunner {
  return (req) => {
    const res = compile(req.source, { top: opts.top ?? req.top });
    if (!res.design) {
      const errors = res.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.span.line}:${d.span.col} ${d.message}`);
      return { ok: false, error: errors.join('\n') || 'compile failed' };
    }
    try {
      const top = findModule(res.design, res.design.top)!;
      const ports: TracePort[] = top.ports.map((p) => ({ name: p.name, width: p.width, dir: p.dir }));
      const outs = ports.filter((p) => p.dir === 'out');
      const sim = new Ir4Sim(res.design);
      sim.setMany(Object.fromEntries(ports.filter((p) => p.dir === 'in').map((p) => [p.name, allOf('0', p.width)])));
      const sample = () => Object.fromEntries(outs.map((p) => [p.name, sim.get(p.name)]));
      const cycles: CycleSample[] = [];
      for (const stim of req.stimulus) {
        sim.setMany(stim);
        const pre = sample();
        if (req.clock !== undefined) sim.set(req.clock, '1');
        const post = sample();
        if (req.clock !== undefined) sim.set(req.clock, '0');
        cycles.push({ pre, post });
      }
      return { ok: true, ports, cycles };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
