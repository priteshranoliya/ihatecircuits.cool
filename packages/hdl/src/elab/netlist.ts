import type { Cell, Module, Net, NetId, Port } from '../design';
import type { Span } from '../diagnostics';
import * as cv from './cval';
import type { NetKindIR } from './scope';

/**
 * The netlist under construction for one module: nets with aliasing, cells with constant folding and sharing,
 * and the record of who drives what.
 *
 * Nets are at most 32 bits wide (design.ts). A `Word` is a value of up to 64 bits held as one or two nets
 * (chunks, least significant first); wider intermediates arise only from wide literals and concatenations in
 * comparisons and conditions.
 */

export const MAX_WIDTH = 32;
export const MAX_WORD = 64;

export interface Word {
  w: number;
  /** Chunk 0 holds bits 0..31; chunk 1, when `w` > 32, the rest. */
  c: NetId[];
}

export interface Producer {
  net: NetId;
  what: string;
  isPort: boolean;
  tri: boolean;
  span: Span;
}

export const chunkWidth = (w: number, i: number) => (i === 0 ? Math.min(w, MAX_WIDTH) : w - MAX_WIDTH);

export class Netlist {
  private readonly widths: number[] = [];
  private readonly netNames: string[][] = [];
  private readonly parent: number[] = [];
  private readonly driven: boolean[] = [];
  private readonly kinds = new Map<NetId, NetKindIR>();
  readonly cells: Cell[] = [];
  readonly producers: Producer[] = [];
  private readonly cse = new Map<string, NetId>();
  private readonly constNets = new Map<NetId, string>();
  /** Where new producers are reported. */
  span: Span;

  constructor(span: Span) {
    this.span = span;
  }

  // ------------------------------------------------------------ nets

  newNet(width: number, names: string[] = []): NetId {
    const id = this.widths.length;
    this.widths.push(width);
    this.netNames.push(names);
    this.parent.push(id);
    this.driven.push(false);
    return id;
  }

  get netCount(): number {
    return this.widths.length;
  }

  width(n: NetId): number {
    return this.widths[n]!;
  }

  namesOf(n: NetId): string[] {
    return this.netNames[n]!;
  }

  find(n: NetId): NetId {
    while (this.parent[n] !== n) {
      this.parent[n] = this.parent[this.parent[n]!]!;
      n = this.parent[n]!;
    }
    return n;
  }

  /** Make two names denote one net. Two sources ending up on it are reported once, by `checkDrivers`. */
  union(a: NetId, b: NetId) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const root = Math.min(ra, rb);
    const other = Math.max(ra, rb);
    this.parent[other] = root;
    this.driven[root] = this.driven[ra]! || this.driven[rb]!;
    const ka = this.kinds.get(ra);
    const kb = this.kinds.get(rb);
    const k = ka && ka !== 'wire' ? ka : kb;
    if (k) this.kinds.set(root, k);
  }

  setKind(n: NetId, k: NetKindIR) {
    this.kinds.set(this.find(n), k);
  }

  kindOf(n: NetId): NetKindIR {
    return this.kinds.get(this.find(n)) ?? 'wire';
  }

  markDriven(n: NetId, what: string, isPort = false, tri = false) {
    this.driven[this.find(n)] = true;
    this.producers.push({ net: n, what, isPort, tri, span: this.span });
  }

  isDriven(n: NetId): boolean {
    return this.driven[this.find(n)]!;
  }

  emit(cell: Cell, outs: NetId[], what?: string) {
    this.cells.push(cell);
    outs.forEach((o) => this.markDriven(o, what ?? this.describeProducer(cell, o), false, cell.kind === 'tribuf'));
  }

  private describeProducer(cell: Cell, out: NetId): string {
    switch (cell.kind) {
      case 'dff':
      case 'adff':
      case 'latch':
        return `the reg '${this.netNames[out]![0] ?? '?'}'`;
      case 'instance':
        return `the output '${Object.entries(cell.outputs).find(([, n]) => n === out)?.[0] ?? '?'}' of instance '${cell.name}'`;
      case 'const':
        return 'a constant';
      case 'tribuf':
        return 'a tri-state driver';
      case 'memory':
        return `a read of the memory '${cell.name}'`;
      default:
        return 'an assign expression';
    }
  }

  // ------------------------------------------------------------ cells with folding and sharing

  private pure(key: string, width: number, make: (out: NetId) => Cell): NetId {
    const hit = this.cse.get(key);
    if (hit !== undefined) return hit;
    const out = this.newNet(width);
    this.emit(make(out), [out]);
    this.cse.set(key, out);
    return out;
  }

  constBits(n: NetId): string | undefined {
    return this.constNets.get(n);
  }

  private val(n: NetId): cv.CVal | undefined {
    const b = this.constNets.get(n);
    return b === undefined ? undefined : cv.fromBits(b, false);
  }

  constant(bits: string): NetId {
    const hit = this.cse.get(`const:${bits}`);
    if (hit !== undefined) return hit;
    const out = this.pure(`const:${bits}`, bits.length, (o) => ({ kind: 'const', out: o, bits }));
    this.constNets.set(out, bits);
    return out;
  }

  /** A constant net that is not shared, for a bit pattern that gets its own resolution kind. */
  freshConst(bits: string): NetId {
    const out = this.newNet(bits.length);
    this.emit({ kind: 'const', out, bits }, [out]);
    this.constNets.set(out, bits);
    return out;
  }

  constVal(v: cv.CVal): NetId {
    return this.constant(cv.toBits(v));
  }

  private fold(v: cv.CVal): NetId {
    return this.constVal(v);
  }

  not(a: NetId): NetId {
    const x = this.val(a);
    if (x) return this.fold(cv.not(x));
    return this.pure(`not:${a}`, this.width(a), (out) => ({ kind: 'not', a, out }));
  }

  bitwise(kind: 'and' | 'or' | 'xor' | 'xnor', a: NetId, b: NetId): NetId {
    const x = this.val(a);
    const y = this.val(b);
    if (x && y) return this.fold({ and: cv.and, or: cv.or, xor: cv.xor, xnor: cv.xnor }[kind](x, y));
    const w = this.width(a);
    const zero = (v?: cv.CVal) => v !== undefined && cv.known(v) && cv.bigA(v) === 0n;
    const ones = (v?: cv.CVal) => v !== undefined && cv.known(v) && cv.bigA(v) === (1n << BigInt(w)) - 1n;
    if (kind === 'and' && (zero(x) || zero(y))) return this.constant('0'.repeat(w));
    if (kind === 'or' && (ones(x) || ones(y))) return this.constant('1'.repeat(w));
    return this.pure(`${kind}:${a}:${b}`, w, (out) => ({ kind, a, b, out }));
  }

  arith(kind: 'add' | 'sub' | 'mul' | 'divu' | 'remu' | 'divs' | 'rems', a: NetId, b: NetId): NetId {
    const x = this.val(a);
    const y = this.val(b);
    if (x && y) {
      switch (kind) {
        case 'add':
          return this.fold(cv.add(x, y));
        case 'sub':
          return this.fold(cv.sub(x, y));
        case 'mul':
          return this.fold(cv.mul(x, y));
        default: {
          const signed = kind === 'divs' || kind === 'rems';
          return this.fold(cv.divide(cv.withSign(x, signed), cv.withSign(y, signed), kind === 'remu' || kind === 'rems'));
        }
      }
    }
    return this.pure(`${kind}:${a}:${b}`, this.width(a), (out) => ({ kind, a, b, out }));
  }

  shift(kind: 'shl' | 'shr' | 'sshr', a: NetId, amount: NetId): NetId {
    const x = this.val(a);
    const y = this.val(amount);
    if (x && y) return this.fold(kind === 'shl' ? cv.shiftLeft(x, y) : cv.shiftRight(cv.withSign(x, kind === 'sshr'), y, kind === 'sshr'));
    return this.pure(`${kind}:${a}:${amount}`, this.width(a), (out) => ({ kind, a, amount, out }));
  }

  compare(kind: 'eq' | 'ne', a: NetId, b: NetId): NetId {
    const x = this.val(a);
    const y = this.val(b);
    if (x && y) return this.fold(kind === 'eq' ? cv.eq(x, y) : cv.ne(x, y));
    return this.pure(`${kind}:${a}:${b}`, 1, (out) => ({ kind, a, b, out }));
  }

  less(kind: 'ltu' | 'lts', a: NetId, b: NetId): NetId {
    const x = this.val(a);
    const y = this.val(b);
    if (x && y) return this.fold(cv.lessThan(x, y, kind === 'lts'));
    return this.pure(`${kind}:${a}:${b}`, 1, (out) => ({ kind, a, b, out }));
  }

  reduce(kind: 'reduce_and' | 'reduce_or' | 'reduce_xor', a: NetId): NetId {
    const x = this.val(a);
    if (x) return this.fold(kind === 'reduce_and' ? cv.reduceAnd(x) : kind === 'reduce_or' ? cv.reduceOr(x) : cv.reduceXor(x));
    if (this.width(a) === 1) return a;
    return this.pure(`${kind}:${a}`, 1, (out) => ({ kind, a, out }));
  }

  mux(sel: NetId, onFalse: NetId, onTrue: NetId): NetId {
    if (onFalse === onTrue) return onTrue;
    const s = this.val(sel);
    if (s && cv.known(s)) return cv.bigA(s) === 1n ? onTrue : onFalse;
    return this.pure(`mux:${sel}:${onFalse}:${onTrue}`, this.width(onTrue), (out) => ({ kind: 'mux', sel, onFalse, onTrue, out }));
  }

  concat(parts: NetId[]): NetId {
    if (parts.length === 1) return parts[0]!;
    const vals = parts.map((p) => this.constNets.get(p));
    if (vals.every((v) => v !== undefined)) return this.constant(vals.join(''));
    const width = parts.reduce((s, p) => s + this.width(p), 0);
    return this.pure(`concat:${parts.join(',')}`, width, (out) => ({ kind: 'concat', parts, out }));
  }

  slice(a: NetId, lsb: number, width: number): NetId {
    if (lsb === 0 && width === this.width(a)) return a;
    const c = this.constNets.get(a);
    if (c !== undefined) return this.constant(c.slice(c.length - lsb - width, c.length - lsb));
    return this.pure(`slice:${a}:${lsb}:${width}`, width, (out) => ({ kind: 'slice', a, lsb, out }));
  }

  zeroExtend(a: NetId, width: number): NetId {
    const w = this.width(a);
    return width === w ? a : this.concat([this.constant('0'.repeat(width - w)), a]);
  }

  signExtend(a: NetId, width: number): NetId {
    const w = this.width(a);
    if (width === w) return a;
    const sign = this.slice(a, w - 1, 1);
    return this.concat([...Array.from({ length: width - w }, () => sign), a]);
  }

  /** Zero-extend or truncate. */
  resize(a: NetId, to: number): NetId {
    const w = this.width(a);
    return to === w ? a : to < w ? this.slice(a, 0, to) : this.zeroExtend(a, to);
  }

  /** Take a cell out again, with the record that its outputs were driven. */
  removeCell(c: Cell) {
    this.cells.splice(this.cells.indexOf(c), 1);
    const outs = new Set(cellOuts(c));
    for (let i = this.producers.length - 1; i >= 0; i--) if (outs.has(this.producers[i]!.net)) this.producers.splice(i, 1);
  }

  tribuf(a: NetId, en: NetId, out: NetId) {
    this.emit({ kind: 'tribuf', a, en, out }, [out]);
  }

  // ------------------------------------------------------------ words

  wordOf(n: NetId): Word {
    return { w: this.width(n), c: [n] };
  }

  /** Cut `[lo, hi)` out of a word and return it as nets (most significant first). */
  private pieces(a: Word, lo: number, hi: number): NetId[] {
    const out: NetId[] = [];
    for (let i = a.c.length - 1; i >= 0; i--) {
      const base = i * MAX_WIDTH;
      const from = Math.max(lo, base);
      const to = Math.min(hi, base + chunkWidth(a.w, i));
      if (from < to) out.push(this.slice(a.c[i]!, from - base, to - from));
    }
    return out;
  }

  wslice(a: Word, lsb: number, n: number): Word {
    return this.pack(this.pieces(a, lsb, lsb + n), n);
  }

  /** Pieces (most significant first) re-cut into chunks. */
  private pack(msbFirst: NetId[], w: number): Word {
    if (w > MAX_WORD) throw new Error(`word of ${w} bits`);
    if (w <= MAX_WIDTH) return { w, c: [this.concat(msbFirst)] };
    const lsbFirst = [...msbFirst].reverse();
    const lo: NetId[] = [];
    const hi: NetId[] = [];
    let got = 0;
    for (const p of lsbFirst) {
      const pw = this.width(p);
      if (got + pw <= MAX_WIDTH) {
        lo.push(p);
      } else if (got >= MAX_WIDTH) hi.push(p);
      else {
        const k = MAX_WIDTH - got;
        lo.push(this.slice(p, 0, k));
        hi.push(this.slice(p, k, pw - k));
      }
      got += pw;
    }
    return { w, c: [this.concat(lo.reverse()), this.concat(hi.reverse())] };
  }

  wconcat(parts: Word[]): Word {
    const w = parts.reduce((s, p) => s + p.w, 0);
    if (w > MAX_WORD) throw new Error(`word of ${w} bits`);
    const pieces: NetId[] = [];
    for (const p of parts) for (let i = p.c.length - 1; i >= 0; i--) pieces.push(p.c[i]!);
    return this.pack(pieces, w);
  }

  wconst(bits: string): Word {
    const w = bits.length;
    if (w <= MAX_WIDTH) return { w, c: [this.constant(bits)] };
    return { w, c: [this.constant(bits.slice(w - MAX_WIDTH)), this.constant(bits.slice(0, w - MAX_WIDTH))] };
  }

  wzeroExtend(a: Word, w: number): Word {
    return w === a.w ? a : this.wconcat([this.wconst('0'.repeat(w - a.w)), a]);
  }

  wsignExtend(a: Word, w: number): Word {
    if (w === a.w) return a;
    const sign = this.wslice(a, a.w - 1, 1);
    return this.wconcat([...Array.from({ length: w - a.w }, () => sign), a]);
  }

  wresize(a: Word, w: number, signed: boolean): Word {
    return w === a.w ? a : w < a.w ? this.wslice(a, 0, w) : signed ? this.wsignExtend(a, w) : this.wzeroExtend(a, w);
  }

  wnot(a: Word): Word {
    return { w: a.w, c: a.c.map((n) => this.not(n)) };
  }

  wbitwise(kind: 'and' | 'or' | 'xor' | 'xnor', a: Word, b: Word): Word {
    return { w: a.w, c: a.c.map((n, i) => this.bitwise(kind, n, b.c[i]!)) };
  }

  wmux(sel: NetId, f: Word, t: Word): Word {
    return { w: t.w, c: t.c.map((n, i) => this.mux(sel, f.c[i]!, n)) };
  }

  /** Carry out of a 32-bit `a + b` whose sum is `sum`. */
  private carryOut(a: NetId, b: NetId, sum: NetId): NetId {
    const top = (n: NetId) => this.slice(n, MAX_WIDTH - 1, 1);
    const [ta, tb, ts] = [top(a), top(b), top(sum)];
    return this.bitwise('or', this.bitwise('and', ta, tb), this.bitwise('and', this.bitwise('xor', ta, tb), this.not(ts)));
  }

  wadd(a: Word, b: Word): Word {
    const lo = this.arith('add', a.c[0]!, b.c[0]!);
    if (a.c.length === 1) return { w: a.w, c: [lo] };
    const hw = a.w - MAX_WIDTH;
    const carry = this.zeroExtend(this.carryOut(a.c[0]!, b.c[0]!, lo), hw);
    return { w: a.w, c: [lo, this.arith('add', this.arith('add', a.c[1]!, b.c[1]!), carry)] };
  }

  wsub(a: Word, b: Word): Word {
    const lo = this.arith('sub', a.c[0]!, b.c[0]!);
    if (a.c.length === 1) return { w: a.w, c: [lo] };
    const hw = a.w - MAX_WIDTH;
    const borrow = this.zeroExtend(this.less('ltu', a.c[0]!, b.c[0]!), hw);
    return { w: a.w, c: [lo, this.arith('sub', this.arith('sub', a.c[1]!, b.c[1]!), borrow)] };
  }

  /** `a == b` (or `!=`) as one net. */
  wcompare(kind: 'eq' | 'ne', a: Word, b: Word): NetId {
    const parts = a.c.map((n, i) => this.compare(kind, n, b.c[i]!));
    return parts.length === 1 ? parts[0]! : this.bitwise(kind === 'eq' ? 'and' : 'or', parts[0]!, parts[1]!);
  }

  wless(a: Word, b: Word, signed: boolean): NetId {
    if (a.c.length === 1) return this.less(signed ? 'lts' : 'ltu', a.c[0]!, b.c[0]!);
    const hiLess = this.less(signed ? 'lts' : 'ltu', a.c[1]!, b.c[1]!);
    const hiEq = this.compare('eq', a.c[1]!, b.c[1]!);
    return this.bitwise('or', hiLess, this.bitwise('and', hiEq, this.less('ltu', a.c[0]!, b.c[0]!)));
  }

  wreduce(kind: 'reduce_and' | 'reduce_or' | 'reduce_xor', a: Word): NetId {
    const parts = a.c.map((n) => this.reduce(kind, n));
    if (parts.length === 1) return parts[0]!;
    return this.bitwise(kind === 'reduce_and' ? 'and' : kind === 'reduce_or' ? 'or' : 'xor', parts[0]!, parts[1]!);
  }

  /** The word as a constant bit string, when every chunk is a constant. */
  wconstBits(a: Word): string | undefined {
    const parts = a.c.map((n) => this.constNets.get(n));
    return parts.every((p) => p !== undefined) ? [...parts].reverse().join('') : undefined;
  }

  // ------------------------------------------------------------ checks and output

  /** Every net (after aliasing) can have one driver, or several tri-state drivers and at most one other. Returns the offenders. */
  conflicts(): { root: NetId; list: Producer[]; names: string[] }[] {
    const byNet = new Map<NetId, Producer[]>();
    for (const p of this.producers) {
      const root = this.find(p.net);
      const list = byNet.get(root);
      if (list) list.push(p);
      else byNet.set(root, [p]);
    }
    const out: { root: NetId; list: Producer[]; names: string[] }[] = [];
    for (const [root, list] of byNet) {
      if (list.length < 2) continue;
      if (list.filter((p) => !p.tri).length < 2) continue;
      const names: string[] = [];
      this.widths.forEach((_, n) => {
        if (this.find(n) !== root) return;
        for (const name of this.netNames[n]!) if (!names.includes(name)) names.push(name);
      });
      out.push({ root, list, names });
    }
    return out;
  }

  /** The cell driving each net (after aliasing). */
  producerCells(): Map<NetId, Cell> {
    const byRoot = new Map<NetId, Cell>();
    for (const c of this.cells) for (const o of cellOuts(c)) byRoot.set(this.find(o), c);
    return byRoot;
  }

  /** Renumber the nets so each alias class is one net, ordered by its lowest original id. */
  finish(name: string, ports: { name: string; dir: 'in' | 'out'; width: number; net: NetId }[]): Module {
    const roots = [...new Set(this.widths.map((_, i) => this.find(i)))].sort((a, b) => a - b);
    const index = new Map(roots.map((r, i) => [r, i]));
    const re = (n: NetId): NetId => index.get(this.find(n))!;
    const nets: Net[] = roots.map((r, i) => ({ id: i, width: this.widths[r]!, names: [] as string[] }));
    this.widths.forEach((_, n) => {
      const target = nets[re(n)]!;
      for (const nm of this.netNames[n]!) if (!target.names.includes(nm)) target.names.push(nm);
    });
    roots.forEach((r, i) => {
      const k = this.kinds.get(r);
      if (k && k !== 'wire') nets[i]!.kind = k;
    });
    const outPorts: Port[] = ports.map((p) => ({ name: p.name, dir: p.dir, width: p.width, net: re(p.net) }));
    return { name, ports: outPorts, nets, cells: this.cells.map((c) => mapCell(c, re)) };
  }
}

export function cellOuts(c: Cell): NetId[] {
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

export function mapCell(c: Cell, re: (n: NetId) => NetId): Cell {
  switch (c.kind) {
    case 'const':
      return { ...c, out: re(c.out) };
    case 'not':
    case 'slice':
    case 'reduce_and':
    case 'reduce_or':
    case 'reduce_xor':
      return { ...c, a: re(c.a), out: re(c.out) };
    case 'and':
    case 'or':
    case 'xor':
    case 'xnor':
    case 'add':
    case 'sub':
    case 'mul':
    case 'divu':
    case 'remu':
    case 'divs':
    case 'rems':
    case 'eq':
    case 'ne':
    case 'ltu':
    case 'lts':
      return { ...c, a: re(c.a), b: re(c.b), out: re(c.out) };
    case 'shl':
    case 'shr':
    case 'sshr':
      return { ...c, a: re(c.a), amount: re(c.amount), out: re(c.out) };
    case 'mux':
      return { ...c, sel: re(c.sel), onFalse: re(c.onFalse), onTrue: re(c.onTrue), out: re(c.out) };
    case 'concat':
      return { ...c, parts: c.parts.map(re), out: re(c.out) };
    case 'dff':
      return { ...c, clk: re(c.clk), d: re(c.d), q: re(c.q) };
    case 'adff':
      return { ...c, clk: re(c.clk), arst: re(c.arst), d: re(c.d), q: re(c.q) };
    case 'latch':
      return { ...c, en: re(c.en), d: re(c.d), q: re(c.q) };
    case 'tribuf':
      return { ...c, a: re(c.a), en: re(c.en), out: re(c.out) };
    case 'memory':
      return {
        ...c,
        readPorts: c.readPorts.map((p) => ({ ...p, addr: re(p.addr), data: re(p.data), ...(p.clk !== undefined ? { clk: re(p.clk) } : {}) })),
        writePorts: c.writePorts.map((p) => ({ ...p, addr: re(p.addr), data: re(p.data), en: re(p.en), clk: re(p.clk) })),
      };
    case 'instance':
      return {
        ...c,
        inputs: Object.fromEntries(Object.entries(c.inputs).map(([k, v]) => [k, re(v)])),
        outputs: Object.fromEntries(Object.entries(c.outputs).map(([k, v]) => [k, re(v)])),
      };
  }
}
