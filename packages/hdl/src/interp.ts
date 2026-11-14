import { type Cell, type Design, type Module, type Net, type NetId, findModule } from './design';
import type { CycleSample, Stimulus, TracePort, TraceResult } from './trace';

/**
 * Reference interpreter for the IR: four-state (0 1 x z), cycle based, written from the cell
 * definitions in design.ts and from nothing else. It is the semantic reference for every back end.
 *
 * Values are strings, most significant bit first, over '0' '1' 'x' 'z'.
 *
 * Evaluation. Combinational values are computed to a fixed point. Then every edge-triggered element
 * looks at its clock: where it saw a known level before and sees the opposite known level now, it fires.
 * All elements that fire in one pass sample their inputs before any of them changes (nonblocking
 * semantics), then the combinational values are recomputed and the clocks are looked at again, so a
 * clock derived from a register output fires in the pass after the register changed.
 *
 * Choices where design.ts is silent, made so that behaviour stays hardware-like and the reference is
 * total. A back end may be more defined than these (they are x) but never less.
 *   - A latch with an unknown enable gives the bitwise merge of its held value and `d`.
 *   - A memory write port with an unknown enable and a known address merges the word with the data.
 *   - A clock that is unknown now or was unknown before does not fire.
 *   - A net's drivers are resolved per bit: z yields, equal values agree, different values are x;
 *     `wand`/`wor` combine driven values by AND/OR, `pull0`/`pull1` turn an all-z bit into 0/1, and
 *     `supply0`/`supply1` are constants.
 */

type V = string;

const X = (w: number): V => 'x'.repeat(w);
const Z = (w: number): V => 'z'.repeat(w);
const zeros = (w: number): V => '0'.repeat(w);
const ones = (w: number): V => '1'.repeat(w);
const readX = (s: V): V => (s.includes('z') ? s.replace(/z/g, 'x') : s);
const isKnown = (s: V): boolean => !/[xz]/.test(s);
const big = (s: V): bigint => BigInt('0b' + s);
const fromBig = (n: bigint, w: number): V => BigInt.asUintN(w, n).toString(2).padStart(w, '0');
const signed = (s: V): bigint => BigInt.asIntN(s.length, big(s));

function mapBits(a: V, f: (c: string) => string): V {
  let r = '';
  for (const c of a) r += f(c);
  return r;
}
function zipBits(a: V, b: V, f: (p: string, q: string) => string): V {
  let r = '';
  for (let i = 0; i < a.length; i++) r += f(a[i]!, b[i]!);
  return r;
}

const bNot = (c: string) => (c === '0' ? '1' : c === '1' ? '0' : 'x');
const bAnd = (p: string, q: string) => (p === '0' || q === '0' ? '0' : p === '1' && q === '1' ? '1' : 'x');
const bOr = (p: string, q: string) => (p === '1' || q === '1' ? '1' : p === '0' && q === '0' ? '0' : 'x');
const bXor = (p: string, q: string) => (p === 'x' || q === 'x' ? 'x' : p === q ? '0' : '1');

const merge = (a: V, b: V): V => zipBits(a, b, (p, q) => (p === q && (p === '0' || p === '1') ? p : 'x'));

function reduceBits(a: V, f: (p: string, q: string) => string): string {
  let r = a[0]!;
  for (let i = 1; i < a.length; i++) r = f(r, a[i]!);
  return r;
}

/** Arithmetic on two operands that are both fully known; any unknown bit makes the result unknown. */
function arith(a: V, b: V, f: (x: V, y: V) => V | undefined): V {
  const w = a.length;
  if (!isKnown(a) || !isKnown(b)) return X(w);
  return f(a, b) ?? X(w);
}

function divide(kind: 'divu' | 'remu' | 'divs' | 'rems', a: V, b: V): V {
  const w = a.length;
  return arith(a, b, (x, y) => {
    if (big(y) === 0n) return undefined;
    if (kind === 'divu') return fromBig(big(x) / big(y), w);
    if (kind === 'remu') return fromBig(big(x) % big(y), w);
    // BigInt division truncates toward zero and its remainder takes the sign of the dividend.
    if (kind === 'divs') return fromBig(signed(x) / signed(y), w);
    return fromBig(signed(x) % signed(y), w);
  });
}

function shift(kind: 'shl' | 'shr' | 'sshr', a: V, amount: V): V {
  const w = a.length;
  if (!isKnown(amount)) return X(w);
  const n = big(amount);
  const fill = kind === 'sshr' ? a[0]! : '0';
  if (n >= BigInt(w)) return fill.repeat(w);
  const k = Number(n);
  if (kind === 'shl') return a.slice(k) + '0'.repeat(k);
  return fill.repeat(k) + a.slice(0, w - k);
}

function equal(a: V, b: V): string {
  let unknown = false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p === 'x' || q === 'x') unknown = true;
    else if (p !== q) return '0';
  }
  return unknown ? 'x' : '1';
}

function less(kind: 'ltu' | 'lts', a: V, b: V): V {
  if (!isKnown(a) || !isKnown(b)) return 'x';
  return (kind === 'ltu' ? big(a) < big(b) : signed(a) < signed(b)) ? '1' : '0';
}

/** Resolve the drivers of one net bit by bit. */
function resolveNet(kind: Net['kind'], width: number, drivers: V[]): V {
  if (kind === 'supply0') return zeros(width);
  if (kind === 'supply1') return ones(width);
  let out = '';
  for (let i = 0; i < width; i++) {
    let bit = 'z';
    const driven = drivers.map((d) => d[i]!).filter((c) => c !== 'z');
    if (driven.length > 0) {
      if (kind === 'wand') bit = driven.reduce(bAnd);
      else if (kind === 'wor') bit = driven.reduce(bOr);
      else bit = driven.every((c) => c === driven[0] && c !== 'x') ? driven[0]! : 'x';
    }
    if (bit === 'z') bit = kind === 'pull0' ? '0' : kind === 'pull1' ? '1' : 'z';
    out += bit;
  }
  return out;
}

const initialWord = (width: number, text: string | undefined): V => {
  if (text === undefined) return X(width);
  const t = text.slice(-width).padStart(width, '0');
  return t;
};

type Level = '0' | '1';
const edgeLevels = (edge: 'pos' | 'neg'): [Level, Level] => (edge === 'pos' ? ['0', '1'] : ['1', '0']);
const isLevel = (c: string): c is Level => c === '0' || c === '1';

interface Inst {
  mod: Module;
  val: V[];
  kids: Map<number, Inst>;
  /** Stored state by cell index: dff/adff/latch hold q, a memory holds `words` and its read registers. */
  q: Map<number, V>;
  mem: Map<number, { words: V[]; rd: V[] }>;
  /** Clock level each edge-triggered cell saw at the end of the previous pass (undefined before the first). */
  prev: Map<string, string>;
  /** Value of each input port, set by the parent (or the caller for the top). */
  inputs: Map<string, V>;
}

export interface InterpOptions {
  /** Power-on value of registers, latches and memory words. Default 'x', as a Verilog reg. '0' is for tests that want a clean start. */
  powerOn?: 'x' | '0';
  top?: string;
}

export class Interp {
  private readonly root: Inst;
  private readonly powerOn: 'x' | '0';

  constructor(
    private readonly design: Design,
    opts: InterpOptions = {},
  ) {
    this.powerOn = opts.powerOn ?? 'x';
    const top = findModule(design, opts.top ?? design.top);
    if (!top) throw new Error(`no module ${opts.top ?? design.top}`);
    this.root = this.instantiate(top);
    for (const p of top.ports) if (p.dir === 'in') this.root.inputs.set(p.name, zeros(p.width));
    this.settle();
  }

  get topModule(): Module {
    return this.root.mod;
  }

  private start(width: number): V {
    return this.powerOn === '0' ? zeros(width) : X(width);
  }

  private instantiate(mod: Module): Inst {
    const inst: Inst = { mod, val: mod.nets.map((n) => X(n.width)), kids: new Map(), q: new Map(), mem: new Map(), prev: new Map(), inputs: new Map() };
    mod.cells.forEach((c, i) => {
      const w = (n: NetId) => mod.nets[n]!.width;
      if (c.kind === 'dff' || c.kind === 'adff' || c.kind === 'latch') inst.q.set(i, this.start(w(c.q)));
      else if (c.kind === 'memory') {
        const words = Array.from({ length: c.depth }, (_, a) => (c.init?.[a] !== undefined ? initialWord(c.width, c.init[a]) : this.start(c.width)));
        inst.mem.set(i, { words, rd: c.readPorts.map(() => this.start(c.width)), });
      } else if (c.kind === 'instance') {
        const callee = findModule(this.design, c.module);
        if (!callee) throw new Error(`instance ${c.name} of unknown module ${c.module}`);
        inst.kids.set(i, this.instantiate(callee));
      }
    });
    return inst;
  }

  /** Set an input of the top module (a binary string, or a number) and settle. */
  set(port: string, value: string | number | bigint): this {
    const p = this.root.mod.ports.find((x) => x.name === port && x.dir === 'in');
    if (!p) throw new Error(`no input ${port}`);
    this.root.inputs.set(port, typeof value === 'string' ? value : fromBig(BigInt(value), p.width));
    this.settle();
    return this;
  }

  /** Value of a port of the top module. */
  value(port: string): V {
    const p = this.root.mod.ports.find((x) => x.name === port);
    if (!p) throw new Error(`no port ${port}`);
    return this.root.val[p.net]!;
  }

  /** Combinational fixed point, then clock edges, until nothing fires. */
  settle(): void {
    for (let pass = 0; ; pass++) {
      if (pass > 64) throw new Error('the design did not settle: clock edges keep firing');
      this.comb(this.root);
      if (!this.fire()) return;
    }
  }

  private comb(root: Inst): void {
    const limit = 8 + 4 * this.cellCount(root);
    for (let round = 0; ; round++) {
      if (round > limit) throw new Error('the design did not settle: a combinational loop does not converge');
      if (!this.round(root)) return;
    }
  }

  private cellCount(i: Inst): number {
    let n = i.mod.cells.length + i.mod.nets.length;
    for (const k of i.kids.values()) n += this.cellCount(k);
    return n;
  }

  /** One evaluation of every cell and net; true if any net value changed. */
  private round(inst: Inst): boolean {
    const { mod, val } = inst;
    const drivers: V[][] = mod.nets.map(() => []);
    for (const p of mod.ports) if (p.dir === 'in') drivers[p.net]!.push(inst.inputs.get(p.name) ?? Z(p.width));
    let changed = false;
    mod.cells.forEach((c, i) => {
      if (c.kind === 'instance') {
        const kid = inst.kids.get(i)!;
        const callee = kid.mod;
        for (const port of callee.ports) {
          if (port.dir !== 'in') continue;
          const net = c.inputs[port.name];
          kid.inputs.set(port.name, net === undefined ? Z(port.width) : val[net]!);
        }
        if (this.round(kid)) changed = true;
        for (const [name, net] of Object.entries(c.outputs)) {
          const port = callee.ports.find((x) => x.name === name && x.dir === 'out');
          if (port) drivers[net]!.push(kid.val[port.net]!);
        }
        return;
      }
      for (const [net, v] of this.evalCell(inst, c, i)) drivers[net]!.push(v);
    });
    mod.nets.forEach((n, id) => {
      const v = resolveNet(n.kind, n.width, drivers[id]!);
      if (v !== val[id]) {
        val[id] = v;
        changed = true;
      }
    });
    return changed;
  }

  /** Output values of a cell: [net, value] pairs. */
  private evalCell(inst: Inst, c: Exclude<Cell, { kind: 'instance' }>, index: number): [NetId, V][] {
    const { mod, val } = inst;
    const w = (n: NetId) => mod.nets[n]!.width;
    const v = (n: NetId) => readX(val[n]!);
    switch (c.kind) {
      case 'const':
        return [[c.out, c.bits]];
      case 'not':
        return [[c.out, mapBits(v(c.a), bNot)]];
      case 'and':
        return [[c.out, zipBits(v(c.a), v(c.b), bAnd)]];
      case 'or':
        return [[c.out, zipBits(v(c.a), v(c.b), bOr)]];
      case 'xor':
        return [[c.out, zipBits(v(c.a), v(c.b), bXor)]];
      case 'xnor':
        return [[c.out, mapBits(zipBits(v(c.a), v(c.b), bXor), bNot)]];
      case 'add':
        return [[c.out, arith(v(c.a), v(c.b), (a, b) => fromBig(big(a) + big(b), w(c.out)))]];
      case 'sub':
        return [[c.out, arith(v(c.a), v(c.b), (a, b) => fromBig(big(a) - big(b), w(c.out)))]];
      case 'mul':
        return [[c.out, arith(v(c.a), v(c.b), (a, b) => fromBig(big(a) * big(b), w(c.out)))]];
      case 'divu':
      case 'remu':
      case 'divs':
      case 'rems':
        return [[c.out, divide(c.kind, v(c.a), v(c.b))]];
      case 'shl':
      case 'shr':
      case 'sshr':
        return [[c.out, shift(c.kind, v(c.a), v(c.amount))]];
      case 'eq': {
        return [[c.out, equal(v(c.a), v(c.b))]];
      }
      case 'ne':
        return [[c.out, bNot(equal(v(c.a), v(c.b)))]];
      case 'ltu':
      case 'lts':
        return [[c.out, less(c.kind, v(c.a), v(c.b))]];
      case 'reduce_and':
        return [[c.out, reduceBits(v(c.a), bAnd)]];
      case 'reduce_or':
        return [[c.out, reduceBits(v(c.a), bOr)]];
      case 'reduce_xor':
        return [[c.out, reduceBits(v(c.a), bXor)]];
      case 'mux': {
        const s = v(c.sel);
        const t = v(c.onTrue);
        const f = v(c.onFalse);
        return [[c.out, s === '1' ? t : s === '0' ? f : merge(t, f)]];
      }
      case 'concat':
        return [[c.out, c.parts.map(v).join('')]];
      case 'slice': {
        const a = v(c.a);
        const hi = a.length - c.lsb;
        return [[c.out, a.slice(hi - w(c.out), hi)]];
      }
      case 'tribuf': {
        const en = v(c.en);
        const a = val[c.a]!;
        if (en === '1') return [[c.out, readX(a)]];
        if (en === '0') return [[c.out, Z(w(c.out))]];
        return [[c.out, mapBits(a, (b) => (b === 'z' ? 'z' : 'x'))]];
      }
      case 'dff': {
        return [[c.q, inst.q.get(index)!]];
      }
      case 'adff': {
        const q = inst.q.get(index)!;
        return [[c.q, this.asyncValue(c, q, v(c.arst))]];
      }
      case 'latch': {
        const en = v(c.en);
        const held = inst.q.get(index)!;
        const d = v(c.d);
        const on = String(c.enLevel);
        const q = en === on ? d : en === (c.enLevel === 1 ? '0' : '1') ? held : merge(held, d);
        inst.q.set(index, q);
        return [[c.q, q]];
      }
      case 'memory': {
        const m = inst.mem.get(index)!;
        const out: [NetId, V][] = [];
        c.readPorts.forEach((p, k) => {
          out.push([p.data, p.clk === undefined ? this.readWord(c, m.words, v(p.addr)) : m.rd[k]!]);
        });
        return out;
      }
    }
  }

  private readWord(c: Extract<Cell, { kind: 'memory' }>, words: V[], addr: V): V {
    if (!isKnown(addr)) return X(c.width);
    const a = big(addr);
    return a < BigInt(c.depth) ? words[Number(a)]! : X(c.width);
  }

  private asyncValue(c: Extract<Cell, { kind: 'adff' }>, q: V, arst: V): V {
    const active = String(c.arstLevel);
    if (arst === active) return c.arstValue;
    if (isLevel(arst)) return q;
    return merge(c.arstValue, q);
  }

  /** Look at every clock; elements that see their edge sample their inputs, then all commit together. Returns whether any fired. */
  private fire(): boolean {
    const commits: (() => void)[] = [];
    const seen: (() => void)[] = [];
    let any = false;
    const visit = (inst: Inst) => {
      const { mod, val } = inst;
      const v = (n: NetId) => readX(val[n]!);
      const edgeOf = (key: string, clk: NetId, edge: 'pos' | 'neg'): boolean => {
        const now = readX(val[clk]!);
        const before = inst.prev.get(key);
        seen.push(() => inst.prev.set(key, now));
        if (before === undefined) return false;
        const [from, to] = edgeLevels(edge);
        return before === from && now === to;
      };
      mod.cells.forEach((c, i) => {
        if (c.kind === 'dff') {
          if (edgeOf(`c${i}`, c.clk, c.edge)) {
            const d = v(c.d);
            any = true;
            commits.push(() => inst.q.set(i, d));
          }
        } else if (c.kind === 'adff') {
          const fired = edgeOf(`c${i}`, c.clk, c.edge);
          if (fired) {
            const arst = v(c.arst);
            const d = v(c.d);
            const active = String(c.arstLevel);
            const next = arst === active ? c.arstValue : isLevel(arst) ? d : merge(c.arstValue, d);
            any = true;
            commits.push(() => inst.q.set(i, next));
          }
        } else if (c.kind === 'memory') {
          const m = inst.mem.get(i)!;
          const reads: [number, V][] = [];
          c.readPorts.forEach((p, k) => {
            if (p.clk !== undefined && edgeOf(`r${i}.${k}`, p.clk, p.edge ?? 'pos')) reads.push([k, this.readWord(c, m.words, v(p.addr))]);
          });
          const writes: [number, V][] = [];
          c.writePorts.forEach((p, k) => {
            if (!edgeOf(`w${i}.${k}`, p.clk, p.edge)) return;
            const en = v(p.en);
            const addr = v(p.addr);
            if (en === '0' || !isKnown(addr) || big(addr) >= BigInt(c.depth)) return;
            const a = Number(big(addr));
            writes.push([a, en === '1' ? v(p.data) : merge(m.words[a]!, v(p.data))]);
          });
          if (reads.length || writes.length) {
            any = true;
            commits.push(() => {
              for (const [k, d] of reads) m.rd[k] = d;
              for (const [a, d] of writes) m.words[a] = d;
            });
          }
        } else if (c.kind === 'instance') {
          visit(inst.kids.get(i)!);
        }
      });
    };
    visit(this.root);
    for (const f of commits) f();
    for (const f of seen) f();
    return any;
  }
}

export interface DesignTraceRequest {
  design: Design;
  /** Name of the clock input port, if the design has one. It is excluded from `stimulus`. */
  clock?: string;
  stimulus: Stimulus;
  top?: string;
}

/**
 * Run a design under the cycle-trace protocol of trace.ts with the reference interpreter. The
 * interpreter is exact, so a trace from it is the standard the other back ends are compared with.
 */
export function runDesign(req: DesignTraceRequest): TraceResult {
  const top = findModule(req.design, req.top ?? req.design.top);
  if (!top) return { ok: false, error: `no module ${req.top ?? req.design.top}` };
  const ports: TracePort[] = top.ports.map((p) => ({ name: p.name, width: p.width, dir: p.dir }));
  const inputs = ports.filter((p) => p.dir === 'in');
  const outputs = ports.filter((p) => p.dir === 'out');
  if (req.clock !== undefined && !inputs.some((p) => p.name === req.clock)) return { ok: false, error: `The clock '${req.clock}' is not an input of '${top.name}'.` };
  for (let k = 0; k < req.stimulus.length; k++) {
    for (const [name, value] of Object.entries(req.stimulus[k]!)) {
      const p = inputs.find((x) => x.name === name && x.name !== req.clock);
      if (!p) return { ok: false, error: `Cycle ${k}: '${name}' is not a non-clock input of '${top.name}'.` };
      if (!new RegExp(`^[01]{${p.width}}$`).test(value)) return { ok: false, error: `Cycle ${k}: '${name}' needs ${p.width} binary digits, got '${value}'.` };
    }
  }
  try {
    const sim = new Interp(req.design, { top: top.name });
    const sample = () => Object.fromEntries(outputs.map((p) => [p.name, sim.value(p.name)]));
    const cycles: CycleSample[] = [];
    for (const cycle of req.stimulus) {
      for (const [name, value] of Object.entries(cycle)) sim.set(name, value);
      const pre = sample();
      let post = pre;
      if (req.clock !== undefined) {
        sim.set(req.clock, '1');
        post = sample();
        sim.set(req.clock, '0');
      }
      cycles.push({ pre, post });
    }
    return { ok: true, ports, cycles };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A two-state view of the interpreter for tests that only want numbers: registers start at 0,
 * `get` returns an unsigned value (any unknown bit reads as 0), `tick` pulses a clock.
 */
export class IrSim {
  private readonly it: Interp;

  constructor(design: Design, top?: Module) {
    this.it = new Interp(design, { powerOn: '0', top: top?.name });
  }

  set(port: string, value: number | bigint): this {
    this.it.set(port, value);
    return this;
  }

  get(port: string): bigint {
    return BigInt('0b' + this.it.value(port).replace(/[xz]/g, '0'));
  }

  /** One rising edge on `clk`. */
  tick(clk: string): this {
    this.it.set(clk, 0);
    this.it.set(clk, 1);
    this.it.set(clk, 0);
    return this;
  }
}

