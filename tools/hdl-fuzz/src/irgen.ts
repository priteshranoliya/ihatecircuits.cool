import type { Cell, Design, MemoryCell, Net, NetId } from '@ihatecircuits/hdl/design';
import type { Stimulus } from '@ihatecircuits/hdl/trace';
import { ModuleBuilder } from './irbuild';
import { createRng, type Rng } from './prng';

/**
 * A seeded generator of random IR designs that use every cell kind.
 *
 * Valid by construction.
 *   - A net has one driver, except a net whose several drivers are tri-state buffers (plus at most one other),
 *     which carries a resolution kind.
 *   - Cells read only nets that already exist, so the combinational part is acyclic. Loops are made only
 *     through a flip-flop or a memory write port, by driving a "forward" net after the cell that reads it.
 *
 * Kept out of the way of behaviour the reference simulator and a circuit cannot agree on.
 *   - Anything that decides *when* something happens (an asynchronous reset, a latch enable, a memory write
 *     enable and address, a tri-state enable) is "known": built only from input ports, constants and supply
 *     nets, never from a register, memory, division or floating net, so it is never x.
 *   - An asynchronous reset or a latch enable is also "clean": an input bit, a constant, or wiring and
 *     inversion of those. A gate that sees two inputs change at once may glitch, and a glitch on an
 *     asynchronous control input loads a flip-flop or opens a latch for an instant, which a zero-delay
 *     simulator never shows. A latch's data is "stable": it depends on no input, so it cannot change while
 *     the enable does.
 *   - Clocks are the module's own `clk` input. There are no derived clocks, and no logic reads the clock as data.
 *   - Literals have no x or z bits (a circuit has no way to make one). Unknown values come from floating
 *     nets, registers before their first clock, unwritten memory words and division by zero.
 */

export interface IrGenOptions {
  /** 1..10: scales module count, cells per module and widths. Default 3. */
  size?: number;
}

export interface IrCase {
  seed: number;
  size: number;
  design: Design;
  clock: string;
  stimulus: Stimulus;
}

interface Flags {
  /** Never unknown for known inputs. */
  known: boolean;
  /** An input bit, a constant, or wiring and inversion of those: it changes on one path, so it cannot glitch. */
  clean: boolean;
  /** Depends on no input port, so it only changes at a clock edge. */
  stable: boolean;
}

interface Pooled extends Flags {
  id: NetId;
  width: number;
}

type Need = 'any' | keyof Flags;

interface Port {
  name: string;
  width: number;
  /** What the caller must connect: 'any' net, a 'known' one, or a 'clean' one. */
  need: 'any' | 'known' | 'clean';
}

const NONE: Flags = { known: false, clean: false, stable: false };
const ALL: Flags = { known: true, clean: true, stable: true };
const meet = (...ps: Flags[]): Flags => ({ known: ps.every((p) => p.known), clean: false, stable: ps.every((p) => p.stable) });

interface Built {
  name: string;
  inputs: Port[];
  outputs: { name: string; width: number }[];
}

const bits = (rng: Rng, w: number): string => Array.from({ length: w }, () => (rng.bool() ? '1' : '0')).join('');

class ModGen {
  readonly m: ModuleBuilder;
  readonly pool: Pooled[] = [];
  private pending: { net: NetId; width: number }[] = [];
  private memories = 0;
  private instances = 0;

  constructor(
    readonly rng: Rng,
    name: string,
    private readonly callees: Built[],
    private readonly maxWidth: number,
    private readonly cellBudget: number,
  ) {
    this.m = new ModuleBuilder(name);
  }

  // ---------------------------------------------------------------- nets

  private add(id: NetId, flags: Flags) {
    this.pool.push({ id, width: this.m.width(id), known: flags.known, clean: flags.clean, stable: flags.stable });
    return id;
  }

  private fresh(width: number, flags: Flags, opts: { kind?: Net['kind'] } = {}): NetId {
    return this.add(this.m.net(width, opts), flags);
  }

  /** A width that is usually small. */
  private width(): number {
    const r = this.rng.next();
    if (r < 0.15) return 1;
    if (r < 0.7) return this.rng.int(2, Math.min(8, this.maxWidth));
    if (r < 0.92) return this.rng.int(4, Math.min(12, this.maxWidth));
    return this.rng.int(1, this.maxWidth);
  }

  private pick(need: Need = 'any', width?: number): Pooled | undefined {
    const ok = this.pool.filter((p) => (need === 'any' || p[need]) && (width === undefined || p.width === width));
    return ok.length ? this.rng.pick(ok) : undefined;
  }

  /** Any net meeting `need`, made exactly `width` bits wide by slicing or zero-extending (sometimes with another net's bits). */
  private fit(need: Need, width: number, prefer?: Pooled): Pooled {
    let base = prefer ?? this.pick(need, width) ?? this.pick(need);
    if (!base) base = this.constant(this.rng.int(1, this.maxWidth));
    if (base.width === width) return base;
    if (base.width > width) {
      const lsb = this.rng.bool(0.7) ? 0 : this.rng.int(0, base.width - width);
      this.m.add({ kind: 'slice', a: base.id, lsb, out: this.fresh(width, base) });
      return this.pool[this.pool.length - 1]!;
    }
    const extra = width - base.width;
    const other = this.rng.bool(0.3) ? this.pick(need) : undefined;
    const filler = other && other.width >= extra ? other : undefined;
    let piece: NetId;
    let flags: Flags = base;
    if (filler) {
      piece = filler.id;
      if (filler.width !== extra) {
        piece = this.m.net(extra);
        this.m.add({ kind: 'slice', a: filler.id, lsb: 0, out: piece });
      }
      flags = { known: base.known && filler.known, clean: base.clean && filler.clean, stable: base.stable && filler.stable };
    } else {
      piece = this.m.net(extra);
      this.m.add({ kind: 'const', out: piece, bits: '0'.repeat(extra) });
    }
    const out = this.fresh(width, flags);
    this.m.add({ kind: 'concat', parts: [piece, base.id], out });
    return this.pool[this.pool.length - 1]!;
  }

  private constant(width: number): Pooled {
    const id = this.fresh(width, ALL);
    this.m.add({ kind: 'const', out: id, bits: bits(this.rng, width) });
    return this.pool[this.pool.length - 1]!;
  }

  // ---------------------------------------------------------------- cells

  private bitwise() {
    const kind = this.rng.pick(['and', 'or', 'xor', 'xnor'] as const);
    const a = this.pick() ?? this.constant(this.width());
    const b = this.fit('any', a.width);
    this.m.add({ kind, a: a.id, b: b.id, out: this.fresh(a.width, meet(a, b)) });
  }

  private not() {
    const a = this.pick() ?? this.constant(this.width());
    this.m.add({ kind: 'not', a: a.id, out: this.fresh(a.width, a) });
  }

  private arith() {
    const kind = this.rng.pick(['add', 'sub', 'mul', 'divu', 'remu', 'divs', 'rems'] as const);
    const cap = kind === 'add' || kind === 'sub' ? this.maxWidth : Math.min(this.maxWidth, this.rng.bool(0.1) ? 16 : 8);
    const a = this.pick() ?? this.constant(this.width());
    const w = Math.min(a.width, cap);
    const x = this.fit('any', w, a.width === w ? a : undefined);
    const y = this.fit('any', w);
    const flags = meet(x, y);
    this.m.add({ kind, a: x.id, b: y.id, out: this.fresh(w, { ...flags, known: flags.known && (kind === 'add' || kind === 'sub' || kind === 'mul') }) });
  }

  private shift() {
    const kind = this.rng.pick(['shl', 'shr', 'sshr'] as const);
    const a = this.pick() ?? this.constant(this.width());
    const amount = this.fit('any', this.rng.int(1, Math.min(6, this.maxWidth)));
    this.m.add({ kind, a: a.id, amount: amount.id, out: this.fresh(a.width, { ...meet(a, amount), known: false }) });
  }

  private compare() {
    const kind = this.rng.pick(['eq', 'ne', 'ltu', 'lts'] as const);
    const a = this.pick() ?? this.constant(this.width());
    const b = this.fit('any', a.width);
    const flags = meet(a, b);
    this.m.add({ kind, a: a.id, b: b.id, out: this.fresh(1, { ...flags, known: flags.known && (kind === 'eq' || kind === 'ne') }) });
  }

  private reduce() {
    const kind = this.rng.pick(['reduce_and', 'reduce_or', 'reduce_xor'] as const);
    const a = this.pick() ?? this.constant(this.width());
    this.m.add({ kind, a: a.id, out: this.fresh(1, meet(a)) });
  }

  private mux() {
    const sel = this.pick('any', 1) ?? this.fit('any', 1);
    const t = this.pick() ?? this.constant(this.width());
    const f = this.fit('any', t.width);
    this.m.add({ kind: 'mux', sel: sel.id, onTrue: t.id, onFalse: f.id, out: this.fresh(t.width, meet(sel, t, f)) });
  }

  private concat() {
    const n = this.rng.int(2, 3);
    const parts: Pooled[] = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const p = this.pick() ?? this.constant(this.width());
      if (total + p.width > this.maxWidth) break;
      parts.push(p);
      total += p.width;
    }
    if (parts.length < 2) return;
    const flags: Flags = { known: parts.every((p) => p.known), clean: parts.every((p) => p.clean), stable: parts.every((p) => p.stable) };
    this.m.add({ kind: 'concat', parts: parts.map((p) => p.id), out: this.fresh(total, flags) });
  }

  private slice() {
    const a = this.pick() ?? this.constant(this.width());
    if (a.width === 1) return;
    const w = this.rng.int(1, a.width - 1);
    this.m.add({ kind: 'slice', a: a.id, lsb: this.rng.int(0, a.width - w), out: this.fresh(w, a) });
  }

  private constantCell() {
    this.constant(this.width());
  }

  /** A net nothing drives: it reads z. */
  private floating() {
    this.fresh(this.rng.int(1, Math.min(6, this.maxWidth)), { known: false, clean: false, stable: true });
  }

  private supply() {
    const w = this.rng.int(1, Math.min(4, this.maxWidth));
    this.fresh(w, ALL, { kind: this.rng.bool() ? 'supply0' : 'supply1' });
  }

  private clk(): NetId {
    return 0;
  }

  private dff() {
    const d = this.rng.bool(0.3) ? this.forward(this.width()) : (this.pick() ?? this.constant(this.width())).id;
    const w = this.m.width(d);
    this.m.add({ kind: 'dff', clk: this.clk(), edge: this.rng.bool(0.75) ? 'pos' : 'neg', d, q: this.fresh(w, { known: false, clean: false, stable: true }) });
  }

  private adff() {
    const rst = this.fit('clean', 1);
    const w = this.width();
    const d = this.rng.bool(0.3) ? this.forward(w) : this.fit('any', w).id;
    const value = this.rng.bool(0.5) ? '0'.repeat(w) : bits(this.rng, w);
    this.m.add({ kind: 'adff', clk: this.clk(), edge: this.rng.bool(0.75) ? 'pos' : 'neg', arst: rst.id, arstLevel: this.rng.bool() ? 1 : 0, arstValue: value, d, q: this.fresh(w, NONE) });
  }

  private latch() {
    const en = this.fit('clean', 1);
    const d = this.fit('stable', this.width());
    this.m.add({ kind: 'latch', en: en.id, enLevel: this.rng.bool() ? 1 : 0, d: d.id, q: this.fresh(d.width, NONE) });
  }

  /** A net that a later cell will drive: lets a register read a value computed from its own output. */
  private forward(width: number): NetId {
    const id = this.m.net(width);
    this.pending.push({ net: id, width });
    return id;
  }

  private tribufs() {
    const w = this.width();
    const kinds: (Net['kind'] | undefined)[] = [undefined, undefined, undefined, 'pull0', 'pull1', 'wand', 'wor'];
    const kind = this.rng.pick(kinds);
    // Operands first: a driver must not read the net it drives.
    const drivers = Array.from({ length: this.rng.int(1, 3) }, () => ({ en: this.rng.bool(0.15) ? this.constant(1) : this.fit('known', 1), a: this.fit('any', w) }));
    const other = this.rng.bool(0.25) ? this.fit('any', w) : undefined;
    const out = this.fresh(w, { known: false, clean: false, stable: [...drivers.flatMap((d) => [d.en, d.a]), ...(other ? [other] : [])].every((p) => p.stable) }, kind ? { kind } : {});
    for (const d of drivers) this.m.add({ kind: 'tribuf', a: d.a.id, en: d.en.id, out });
    if (other) this.m.add({ kind: 'not', a: other.id, out });
  }

  private memory() {
    const depth = this.rng.pick([2, 3, 4, 5, 8, 12, 16]);
    const k = Math.max(1, Math.ceil(Math.log2(depth)));
    const width = this.rng.int(1, Math.min(8, this.maxWidth));
    const edge: 'pos' | 'neg' = this.rng.bool(0.8) ? 'pos' : 'neg';
    const addrWidth = () => Math.max(1, k + this.rng.pick([-1, 0, 0, 0, 1]));
    const writes = this.rng.pick([0, 1, 1, 1, 2]);
    const reads = this.rng.int(1, 2);
    const cell: MemoryCell = { kind: 'memory', name: `mem${this.memories++}`, width, depth, readPorts: [], writePorts: [] };
    if (this.rng.bool(0.4)) cell.init = Array.from({ length: this.rng.int(1, depth) }, () => bits(this.rng, width));
    const loop = writes > 0 && this.rng.bool(0.3);
    for (let i = 0; i < writes; i++) {
      const addr = this.fit('known', addrWidth());
      const en = this.rng.bool(0.15) ? this.constant(1) : this.fit('known', 1);
      const data = loop && i === 0 ? this.forward(width) : this.fit('any', width).id;
      cell.writePorts.push({ addr: addr.id, data, en: en.id, clk: this.clk(), edge });
    }
    for (let i = 0; i < reads; i++) {
      const sync = this.rng.bool(0.4);
      const addr = this.fit('any', addrWidth());
      const data = this.fresh(width, { known: false, clean: false, stable: sync || addr.stable });
      cell.readPorts.push(sync ? { addr: addr.id, data, clk: this.clk(), edge: this.rng.bool(0.8) ? 'pos' : 'neg' } : { addr: addr.id, data });
    }
    this.m.add(cell);
  }

  private instance() {
    const callee = this.rng.pick(this.callees);
    const inputs: Record<string, NetId> = {};
    for (const p of callee.inputs) {
      if (p.name === 'clk') inputs[p.name] = this.clk();
      else inputs[p.name] = this.fit(p.need, p.width).id;
    }
    const outputs: Record<string, NetId> = {};
    for (const p of callee.outputs) if (this.rng.bool(0.9)) outputs[p.name] = this.fresh(p.width, NONE);
    this.m.add({ kind: 'instance', module: callee.name, name: `u${this.instances++}`, inputs, outputs });
  }

  // ---------------------------------------------------------------- module

  /** Drive every forward net from the pool, which by now holds the registers it reads. */
  private closeLoops() {
    for (const { net, width } of this.pending) {
      const a = this.pick('any', width) ?? this.fit('any', width);
      const b = this.fit('any', width);
      const kind = this.rng.pick(['and', 'or', 'xor', 'add', 'sub', 'not', 'mux'] as const);
      if (kind === 'not') this.m.add({ kind, a: a.id, out: net });
      else if (kind === 'mux') this.m.add({ kind, sel: this.fit('any', 1).id, onTrue: a.id, onFalse: b.id, out: net });
      else this.m.add({ kind, a: a.id, b: b.id, out: net });
      this.pool.push({ id: net, width, ...NONE });
    }
    this.pending = [];
  }

  generate(inputs: Port[], outputCount: number): Built {
    const m = this.m;
    // Net 0 is the clock, so cells can name it without a lookup. It is not in the pool: nothing may depend on it
    // combinationally, or a register sampling that value would race with the clock edge in a Verilog simulator.
    m.input('clk', 1);
    for (const p of inputs) this.add(m.input(p.name, p.width), { known: p.need !== 'any', clean: p.need === 'clean', stable: false });

    const weights: [() => void, number][] = [
      [() => this.bitwise(), 8],
      [() => this.not(), 3],
      [() => this.arith(), 10],
      [() => this.shift(), 6],
      [() => this.compare(), 6],
      [() => this.reduce(), 4],
      [() => this.mux(), 5],
      [() => this.concat(), 3],
      [() => this.slice(), 3],
      [() => this.constantCell(), 2],
      [() => this.floating(), 1],
      [() => this.supply(), 1],
      [() => this.dff(), 6],
      [() => this.adff(), 4],
      [() => this.latch(), 3],
      [() => this.tribufs(), 4],
      [() => this.memory(), 4],
      [() => this.callees.length > 0 && this.instance(), 6],
    ];
    const total = weights.reduce((a, [, w]) => a + w, 0);
    for (let i = 0; i < this.cellBudget; i++) {
      let r = this.rng.next() * total;
      for (const [f, w] of weights) {
        r -= w;
        if (r <= 0) {
          f();
          break;
        }
      }
    }
    this.closeLoops();

    const outs: { name: string; width: number }[] = [];
    const candidates = this.pool;
    const chosen = this.rng.shuffle(candidates).slice(0, outputCount);
    chosen.forEach((p, i) => {
      m.output(`o${i}`, p.id);
      outs.push({ name: `o${i}`, width: p.width });
    });
    if (this.rng.bool(0.2) && chosen.length > 0) {
      m.output(`o${chosen.length}`, chosen[0]!.id);
      outs.push({ name: `o${chosen.length}`, width: chosen[0]!.width });
    }
    return { name: m.name, inputs: [{ name: 'clk', width: 1, need: 'clean' }, ...inputs], outputs: outs };
  }
}

function stimulus(rng: Rng, inputs: Port[], cycles: number): Stimulus {
  return Array.from({ length: cycles }, () =>
    Object.fromEntries(
      inputs.map((p) => {
        const r = rng.next();
        const v = r < 0.1 ? '0'.repeat(p.width) : r < 0.2 ? '1'.repeat(p.width) : bits(rng, p.width);
        return [p.name, v];
      }),
    ),
  );
}

export function generateIrCase(seed: number, opts: IrGenOptions = {}): IrCase {
  const size = Math.max(1, Math.min(10, opts.size ?? 3));
  const rng = createRng(seed);
  const moduleCount = rng.int(1, Math.min(4, 1 + Math.ceil(size / 2)));
  const maxWidth = rng.bool(0.12) ? 32 : rng.bool(0.3) ? 16 : 8;
  const built: Built[] = [];
  const modules = [];
  for (let i = 0; i < moduleCount; i++) {
    const top = i === moduleCount - 1;
    const inputs: Port[] = Array.from({ length: rng.int(2, 4) }, (_, k) => ({ name: `i${k}`, width: rng.int(1, Math.min(8, maxWidth)), need: top ? ('clean' as const) : rng.pick(['any', 'any', 'known', 'clean'] as const) }));
    const g = new ModGen(rng, top ? 'top' : `m${i}`, built, maxWidth, rng.int(4, 6 + size * 3));
    built.push(g.generate(inputs, rng.int(2, 4)));
    modules.push(g.m.build());
  }
  const topInputs = built[built.length - 1]!.inputs.filter((p) => p.name !== 'clk');
  const design: Design = { modules, top: 'top' };
  return { seed, size, design, clock: 'clk', stimulus: stimulus(rng, topInputs, rng.int(8, 14)) };
}

export type { Cell };
