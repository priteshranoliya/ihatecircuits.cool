import { type Bits, bits, floating, fromStates, isKnown, mask, parseBitString, toUnsigned, unknown } from '../bits';
import { BITS, DELAY, POWER_ON, TRIGGER_ANY, TRIGGER_EDGE, chip, int, layoutFrom, range, type ComponentDef, type EvalCtx, type EvalResult, type PinSpec, type PropDef } from '../library';
import type { Props } from '../types';
import { fires, hexValue, level, merge, w, type Trigger } from './util';

/**
 * Memory parts: flip-flops, latches, registers, counters, shift registers,
 * a pseudo-random generator, RAM and ROM.
 *
 * Shared rules.
 * - Power-on contents are 0 (deterministic), or the `init` prop of a D flip-flop, D latch or
 *   register (bits over 0, 1 and x). Resetting the simulation restores them, except ROM
 *   contents which are part of the design.
 * - A clocked part keeps the clock level it saw last. A clock that is unknown
 *   on one side of an edge might or might not have fired, so each stored bit
 *   becomes the merge of "kept" and "updated": bits that agree stay known.
 * - Asynchronous clear beats asynchronous set, which beats any clocked action.
 *   An unknown async input merges the forced value with the normal result.
 * - Optional control inputs read their natural idle value when unconnected:
 *   enables 1, clear/set/load 0.
 */

type Lv = 0 | 1 | 'x';
type Fire = boolean | 'x';

const sc = (v: Lv): Bits => (v === 'x' ? unknown(1) : bits(1, v));
const lv = (ctx: EvalCtx, pin: string): Lv => level(ctx.get(pin));
const inv = (v: Lv): Lv => (v === 'x' ? 'x' : v ? 0 : 1);

/** Evaluate `f` for every 0/1 completion of the unknown entries and join the results. */
function branch<T>(vals: readonly Lv[], f: (v: (0 | 1)[]) => T, join: (a: T, b: T) => T): T {
  const go = (i: number, acc: (0 | 1)[]): T => {
    if (i === vals.length) return f(acc);
    const v = vals[i];
    if (v === 'x') return join(go(i + 1, [...acc, 0]), go(i + 1, [...acc, 1]));
    return go(i + 1, [...acc, v]);
  };
  return go(0, []);
}
const joinL = (a: Lv, b: Lv): Lv => (a === b ? a : 'x');

/** Fire decision combined with an enable: unknown enable on a firing clock is unknown. */
function gate(fire: Fire, en: Lv): Fire {
  if (fire === false || en === 0) return false;
  if (en === 1) return fire;
  return 'x';
}

/**
 * Clock decision. `idle` is true until the clock has been seen with a known
 * level: at power-on every wire is still unknown while the first evaluation
 * runs, and treating that as an unknown clock would poison the stored value
 * for good. An idle part changes nothing.
 */
function clockOf(ctx: EvalCtx, prev: Lv | null): { now: Lv; fire: Fire; idle: boolean } {
  const now = lv(ctx, 'clk');
  const idle = prev === null && now === 'x';
  return { now, idle, fire: idle ? false : fires(ctx.props.trigger as Trigger, prev ?? now, now) };
}

const commitL = (old: Lv, next: Lv, fire: Fire): Lv => (fire === true ? next : fire === false ? old : joinL(old, next));
const commitB = (old: Bits, next: Bits, fire: Fire): Bits => (fire === true ? next : fire === false ? old : merge(old, next));

/** Async set then clear on a single bit; clear wins. */
function asyncL(v: Lv, set: Lv, clr: Lv): Lv {
  if (set === 1) v = 1;
  else if (set === 'x') v = v === 1 ? 1 : 'x';
  if (clr === 1) v = 0;
  else if (clr === 'x') v = v === 0 ? 0 : 'x';
  return v;
}
const asyncB = (v: Bits, clr: Lv, zero: Bits): Bits => (clr === 1 ? zero : clr === 'x' ? merge(v, zero) : v);

const CLK: PinSpec = ['clk', '', 1, { clock: true }];
const CLR: PinSpec = ['clr', 'CLR', 1, { floatAs: 0 }];
const EN: PinSpec = ['en', 'EN', 1, { floatAs: 1 }];

// ---------------------------------------------------------------- single-bit flip-flops and latches

interface FFState {
  q: Lv;
  clk: Lv | null;
}
const ffInit = (p: Props): FFState => ({ q: level(parseBitString(String(p.init ?? ''), 1)), clk: null });

function flipFlop(spec: {
  type: string;
  name: string;
  title: string;
  description: string;
  keywords: string[];
  inputs: [name: string, label: string][];
  trigger: PropDef;
  next: (q: Lv, d: Lv[]) => Lv;
  /** Offer a power-on value (the D flip-flop does; the others power on at 0). */
  powerOn?: boolean;
}): ComponentDef {
  return {
    type: spec.type,
    name: spec.name,
    category: 'Memory',
    description: spec.description,
    keywords: spec.keywords,
    sequential: true,
    props: [spec.trigger, DELAY, ...(spec.powerOn ? [POWER_ON] : [])],
    title: () => spec.title,
    ...layoutFrom(() =>
      chip([...spec.inputs.map(([n, l]): PinSpec => [n, l]), CLK], [['q', 'Q'], ['qn', 'Q̅']], 60, {
        top: [['set', 'SET', 1, { floatAs: 0 }]],
        bottom: [CLR],
      }),
    ),
    init: ffInit,
    eval: (ctx) => {
      const st = ctx.state as FFState;
      const { now, fire, idle } = clockOf(ctx, st.clk);
      if (idle) return { out: { q: sc(st.q), qn: sc(inv(st.q)) }, state: st };
      let q = commitL(st.q, spec.next(st.q, spec.inputs.map(([n]) => lv(ctx, n))), fire);
      q = asyncL(q, lv(ctx, 'set'), lv(ctx, 'clr'));
      return { out: { q: sc(q), qn: sc(inv(q)) }, state: { q, clk: now } satisfies FFState };
    },
  };
}

/** Set/reset rule shared by the SR flip-flop and latch. S=R=1 is forbidden and gives x. */
const srNext = (q: Lv, s: Lv, r: Lv): Lv => branch([q, s, r], ([q, s, r]): Lv => (s && r ? 'x' : s ? 1 : r ? 0 : q), joinL);

const dff = flipFlop({
  type: 'dff',
  name: 'D flip-flop',
  title: 'D',
  description: 'Stores the D input when the clock fires, or while the clock level is active if a level trigger is chosen. Optional SET and CLR act immediately; CLR wins.',
  keywords: ['d type', 'register bit', 'edge', 'one bit memory'],
  inputs: [['d', 'D']],
  trigger: TRIGGER_ANY,
  next: (_q, [d]) => d,
  powerOn: true,
});

const tff = flipFlop({
  type: 'tff',
  name: 'T flip-flop',
  title: 'T',
  description: 'Flips its stored bit on each clock edge while T is 1. Edge triggered only. Optional SET and CLR act immediately; CLR wins.',
  keywords: ['toggle', 'divide by two', 'edge'],
  inputs: [['t', 'T']],
  trigger: TRIGGER_EDGE,
  next: (q, [t]) => branch([q, t], ([q, t]): Lv => (t ? (q ? 0 : 1) : q), joinL),
});

const jkff = flipFlop({
  type: 'jkff',
  name: 'JK flip-flop',
  title: 'JK',
  description: 'On a clock edge: J=1 sets, K=1 clears, both flip, neither holds. Edge triggered only. Optional SET and CLR act immediately; CLR wins.',
  keywords: ['jk', 'edge', 'toggle'],
  inputs: [
    ['j', 'J'],
    ['k', 'K'],
  ],
  trigger: TRIGGER_EDGE,
  next: (q, [j, k]) => branch([q, j, k], ([q, j, k]): Lv => (j && k ? (q ? 0 : 1) : j ? 1 : k ? 0 : q), joinL),
});

const srff = flipFlop({
  type: 'srff',
  name: 'SR flip-flop',
  title: 'SR',
  description: 'On a clock trigger: S=1 sets, R=1 clears, neither holds. S=R=1 is a forbidden input and makes the stored bit unknown (x). Optional SET and CLR act immediately; CLR wins.',
  keywords: ['set reset', 'sr'],
  inputs: [
    ['s', 'S'],
    ['r', 'R'],
  ],
  trigger: TRIGGER_ANY,
  next: (q, [s, r]) => srNext(q, s, r),
});

/** `armed` turns true once the control inputs have been seen known, so the all-unknown power-on settling is ignored. */
interface LatchState {
  q: Lv;
  armed: boolean;
}

const dlatch: ComponentDef = {
  type: 'dlatch',
  name: 'D latch',
  category: 'Memory',
  description: 'Follows D while EN is 1 (transparent) and holds the last value while EN is 0. If EN is unknown, the bit stays known only when D already equals it.',
  keywords: ['transparent', 'level sensitive', 'gated'],
  sequential: true,
  props: [DELAY, POWER_ON],
  title: () => 'D latch',
  ...layoutFrom(() => chip([['d', 'D'], EN], [['q', 'Q'], ['qn', 'Q̅']])),
  init: (p): LatchState => ({ q: level(parseBitString(String(p.init ?? ''), 1)), armed: false }),
  eval: (ctx) => {
    const st = ctx.state as LatchState;
    const en = lv(ctx, 'en');
    if (!st.armed && en === 'x') return { out: { q: sc(st.q), qn: sc(inv(st.q)) }, state: st };
    const q = commitL(st.q, lv(ctx, 'd'), en === 1 ? true : en === 0 ? false : 'x');
    return { out: { q: sc(q), qn: sc(inv(q)) }, state: { q, armed: true } };
  },
};

const srlatch: ComponentDef = {
  type: 'srlatch',
  name: 'SR latch',
  category: 'Memory',
  description: 'Level-sensitive set/reset. S=1 sets, R=1 clears. With S=R=1 both outputs are 0 (as in a NOR latch) and the stored bit becomes unknown, so it settles unpredictably once released.',
  keywords: ['nor latch', 'set reset', 'level'],
  sequential: true,
  props: [DELAY],
  title: () => 'SR latch',
  ...layoutFrom(() => chip([['s', 'S'], ['r', 'R']], [['q', 'Q'], ['qn', 'Q̅']])),
  init: (): LatchState => ({ q: 0, armed: false }),
  eval: (ctx) => {
    const st = ctx.state as LatchState;
    const s = lv(ctx, 's');
    const r = lv(ctx, 'r');
    if (!st.armed && (s === 'x' || r === 'x')) return { out: { q: sc(st.q), qn: sc(inv(st.q)) }, state: st };
    const q = srNext(st.q, s, r);
    const both = s === 1 && r === 1;
    return { out: { q: both ? bits(1, 0) : sc(q), qn: both ? bits(1, 0) : sc(inv(q)) }, state: { q, armed: true } };
  },
};

// ---------------------------------------------------------------- register

interface WordState {
  q: Bits;
  clk: Lv | null;
}

const register: ComponentDef = {
  type: 'register',
  name: 'Register',
  category: 'Memory',
  description: 'Holds a multi-bit value. Loads D when the clock fires and EN is 1. CLR resets it to 0 immediately.',
  keywords: ['latch', 'storage', 'word'],
  sequential: true,
  props: [BITS(8), TRIGGER_ANY, DELAY, POWER_ON],
  title: (p) => `REG ${w(p)}`,
  ...layoutFrom((p) => chip([['d', 'D', w(p)], EN, CLK], [['q', 'Q', w(p)]], 60, { bottom: [CLR] })),
  init: (p): WordState => ({ q: parseBitString(String(p.init ?? ''), w(p)), clk: null }),
  eval: (ctx) => {
    const st = ctx.state as WordState;
    const bw = w(ctx.props);
    const { now, fire, idle } = clockOf(ctx, st.clk);
    if (idle) return { out: { q: st.q }, state: st };
    let q = commitB(st.q, ctx.get('d'), gate(fire, lv(ctx, 'en')));
    q = asyncB(q, lv(ctx, 'clr'), bits(bw, 0));
    return { out: { q }, state: { q, clk: now } satisfies WordState };
  },
};

// ---------------------------------------------------------------- counter

const OVERFLOW_MODES = ['wrap', 'stay', 'continue', 'load'] as const;
type Overflow = (typeof OVERFLOW_MODES)[number];

function counterParams(props: EvalCtx['props']) {
  const bw = w(props);
  const mode = (OVERFLOW_MODES as readonly string[]).includes(props.overflow as string) ? (props.overflow as Overflow) : 'wrap';
  return { bw, mode, full: mask(bw), max: hexValue(props.max ?? 'FFFFFFFF', bw) };
}

const counter: ComponentDef = {
  type: 'counter',
  name: 'Counter',
  category: 'Memory',
  description:
    'Counts clock edges. LD loads D (and wins over counting), otherwise EN=1 counts up or down. CO is 1 when counting up at the maximum or down at 0. The overflow setting chooses what happens next.',
  keywords: ['up down', 'binary counter', 'modulo', 'divider'],
  sequential: true,
  props: [
    BITS(4, 'Bits'),
    { key: 'max', label: 'Maximum (hex)', kind: 'hex', default: 'FFFFFFFF', hint: 'Highest value counted to. Cut down to the bit width, so the default is all ones.' },
    {
      key: 'overflow',
      label: 'At the limit',
      kind: 'enum',
      default: 'wrap',
      options: [
        { value: 'wrap', label: 'Wrap around (max to 0, 0 to max)' },
        { value: 'stay', label: 'Stay at the limit' },
        { value: 'continue', label: 'Keep counting through all bits' },
        { value: 'load', label: 'Load D' },
      ],
      hint: 'Keep counting ignores the maximum and wraps at the full bit width.',
    },
    TRIGGER_EDGE,
    DELAY,
  ],
  title: (p) => `CTR ${w(p)}`,
  ...layoutFrom((p) =>
    chip(
      [['ld', 'LD', 1, { floatAs: 0 }], ['d', 'D', w(p)], EN, ['ud', 'UP', 1, { floatAs: 1 }], CLK],
      [['q', 'Q', w(p)], ['co', 'CO']],
      60,
      { bottom: [CLR] },
    ),
  ),
  init: (p): WordState => ({ q: bits(w(p), 0), clk: null }),
  eval: (ctx) => {
    const st = ctx.state as WordState;
    const { bw, mode, full, max } = counterParams(ctx.props);
    const { now, fire, idle } = clockOf(ctx, st.clk);
    if (idle) return { out: { q: st.q, co: unknown(1) }, state: st };
    const d = ctx.get('d');
    const old = st.q;
    const known = isKnown(old);
    const atTop = (v: number) => (mode === 'continue' ? v === max || v === full : v >= max);

    const step = (up: boolean): Bits => {
      if (!known) return unknown(bw);
      const v = old.v;
      if (up) {
        if (mode === 'continue' || !atTop(v)) return bits(bw, (v + 1) & full);
        return mode === 'wrap' ? bits(bw, 0) : mode === 'stay' ? old : d;
      }
      if (mode === 'continue' || v !== 0) return bits(bw, (v - 1) & full);
      return mode === 'wrap' ? bits(bw, max) : mode === 'stay' ? old : d;
    };
    const next = branch([lv(ctx, 'ld'), lv(ctx, 'en'), lv(ctx, 'ud')], ([ld, en, up]) => (ld ? d : en ? step(!!up) : old), merge);

    let q = commitB(old, next, fire);
    q = asyncB(q, lv(ctx, 'clr'), bits(bw, 0));

    const co: Lv = !isKnown(q)
      ? 'x'
      : branch([lv(ctx, 'en'), lv(ctx, 'ud')], ([en, up]): Lv => (en && (up ? atTop(q.v) : q.v === 0) ? 1 : 0), joinL);
    return { out: { q, co: sc(co) }, state: { q, clk: now } satisfies WordState };
  },
};

// ---------------------------------------------------------------- shift register

interface ShiftState {
  st: Bits[];
  clk: Lv | null;
}

const shiftreg: ComponentDef = {
  type: 'shiftreg',
  name: 'Shift register',
  category: 'Memory',
  description:
    'A chain of stages. On each clock edge with SH=1 every stage takes its neighbour\'s value and stage 0 takes SI. SO is the last stage. With parallel access, LD loads D0..Dn together; priority is CLR, then LD, then SH.',
  keywords: ['serial', 'parallel load', 'siso', 'piso', 'sipo'],
  sequential: true,
  props: [
    BITS(1, 'Stage width'),
    { key: 'stages', label: 'Stages', kind: 'int', default: 4, min: 1, max: 32 },
    { key: 'parallel', label: 'Parallel load and outputs', kind: 'bool', default: false },
    TRIGGER_EDGE,
    DELAY,
  ],
  title: (p) => `SHIFT ${int(p, 'stages', 4)}`,
  ...layoutFrom((p) => {
    const n = int(p, 'stages', 4);
    const par = !!p.parallel;
    return chip(
      [CLK, ['sh', 'SH', 1, { floatAs: 1 }], ...(par ? [['ld', 'LD', 1, { floatAs: 0 }] as PinSpec] : []), ['si', 'SI', w(p)], ...(par ? range(n).map((i): PinSpec => [`d${i}`, `D${i}`, w(p)]) : [])],
      [['so', 'SO', w(p)], ...(par ? range(n).map((i): PinSpec => [`q${i}`, `Q${i}`, w(p)]) : [])],
      60,
      { bottom: [CLR] },
    );
  }),
  init: (p): ShiftState => ({ st: range(int(p, 'stages', 4)).map(() => bits(w(p), 0)), clk: null }),
  eval: (ctx) => {
    const old = ctx.state as ShiftState;
    const bw = w(ctx.props);
    const n = int(ctx.props, 'stages', 4);
    const par = !!ctx.props.parallel;
    const { now, fire, idle } = clockOf(ctx, old.clk);
    const show = (st: Bits[]): Record<string, Bits> => {
      const o: Record<string, Bits> = { so: st[n - 1] };
      if (par) st.forEach((b, i) => (o[`q${i}`] = b));
      return o;
    };
    if (idle) return { out: show(old.st), state: old };
    const si = ctx.get('si');
    const outcome = (ld: 0 | 1, sh: 0 | 1): Bits[] =>
      ld ? range(n).map((i) => ctx.get(`d${i}`)) : sh ? [si, ...old.st.slice(0, n - 1)] : old.st;
    const join = (a: Bits[], b: Bits[]) => a.map((s, i) => merge(s, b[i]));
    const next = branch([par ? lv(ctx, 'ld') : 0, lv(ctx, 'sh')], ([ld, sh]) => outcome(ld, sh), join);
    const fired = fire === true ? next : fire === false ? old.st : join(old.st, next);
    const clr = lv(ctx, 'clr');
    const zero = range(n).map(() => bits(bw, 0));
    const st = clr === 1 ? zero : clr === 'x' ? join(fired, zero) : fired;
    return { out: show(st), state: { st, clk: now } satisfies ShiftState };
  },
};

// ---------------------------------------------------------------- random generator

interface RandState {
  s: number | null;
  clk: Lv | null;
}
const DEFAULT_SEED = 0x2545f491;
const seedOf = (p: EvalCtx['props']) => (int(p, 'seed', 0) >>> 0 || DEFAULT_SEED) >>> 0;
/** xorshift32 (Marsaglia, shifts 13/17/5). The state is never 0, so it never sticks. */
export function xorshift32(x: number): number {
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

const random: ComponentDef = {
  type: 'random',
  name: 'Random generator',
  category: 'Memory',
  description:
    'A repeatable pseudo-random number source (xorshift32). Each clock edge with EN=1 advances it. The same seed always gives the same sequence; CLR returns to the seed. A seed of 0 means a fixed built-in seed.',
  keywords: ['rng', 'lfsr', 'noise', 'pseudo random'],
  sequential: true,
  props: [
    BITS(8, 'Output bits'),
    { key: 'seed', label: 'Seed', kind: 'int', default: 0, min: 0, max: 4294967295, hint: '0 uses a fixed default seed. The sequence never depends on the time.' },
    TRIGGER_EDGE,
    DELAY,
  ],
  title: () => 'RNG',
  ...layoutFrom((p) => chip([EN, CLK], [['out', 'Q', w(p)]], 60, { bottom: [CLR] })),
  init: (p): RandState => ({ s: seedOf(p), clk: null }),
  eval: (ctx) => {
    const st = ctx.state as RandState;
    const bw = w(ctx.props);
    const { now, fire, idle } = clockOf(ctx, st.clk);
    if (idle) return { out: { out: st.s === null ? unknown(bw) : bits(bw, st.s & mask(bw)) }, state: st };
    const f = gate(fire, lv(ctx, 'en'));
    let s = st.s;
    if (f === true && s !== null) s = xorshift32(s);
    else if (f === 'x') s = null;
    const clr = lv(ctx, 'clr');
    const seed = seedOf(ctx.props);
    if (clr === 1) s = seed;
    else if (clr === 'x' && s !== seed) s = null;
    return { out: { out: s === null ? unknown(bw) : bits(bw, s & mask(bw)) }, state: { s, clk: now } satisfies RandState };
  },
};

// ---------------------------------------------------------------- RAM

/** RAM contents are sparse: only non-zero words (and words with unknown bits) are stored. */
export interface RamState {
  words: Readonly<Record<number, number>>;
  /** Per-word mask of bits whose value is unknown (x), from writes of unknown data. */
  unk: Readonly<Record<number, number>>;
  clk: Lv | null;
  /** Output register for clocked reads. */
  last: Bits;
}

const readWord = (st: RamState, a: number): Bits => {
  const v = st.words[a] ?? 0;
  const u = st.unk[a] ?? 0;
  const dw = st.last.w;
  return u ? fromStates(Array.from({ length: dw }, (_, i) => ((u >>> i) & 1 ? 'x' : (v >>> i) & 1 ? 1 : 0))) : bits(dw, v);
};

function storeWord(st: RamState, a: number, b: Bits): RamState {
  const words = { ...st.words };
  const unk = { ...st.unk };
  const u = (b.x | b.z | b.e) >>> 0;
  if (b.v) words[a] = b.v;
  else delete words[a];
  if (u) unk[a] = u;
  else delete unk[a];
  return { ...st, words, unk };
}

/** Known words as address to value (unknown bits read as 0). A copy, safe to edit. */
export function ramContents(state: RamState): Record<number, number> {
  return { ...state.words };
}

/** A new state with one word replaced (clearing any unknown bits in it). Value is cut to the data width. */
export function ramSetWord(state: RamState, addr: number, value: number): RamState {
  return storeWord(state, addr, bits(state.last.w, value));
}

const ramInit = (p: EvalCtx['props']): RamState => ({ words: {}, unk: {}, clk: null, last: bits(w(p, 'dataBits', 8), 0) });

const ram: ComponentDef = {
  type: 'ram',
  name: 'RAM',
  category: 'Memory',
  description:
    'Read/write memory. A write happens on the clock edge when WE=1. Reads follow the address immediately, or update on the clock edge if asynchronous read is off (a clocked read after a write shows the new word). OE=0 floats the output. CLR empties the memory at once. An unknown address reads as x and a write to it is ignored.',
  keywords: ['memory', 'random access', 'sram', 'storage', 'bus'],
  sequential: true,
  props: [
    { key: 'addrBits', label: 'Address bits', kind: 'int', default: 8, min: 1, max: 16 },
    { key: 'dataBits', label: 'Data bits', kind: 'int', default: 8, min: 1, max: 32 },
    {
      key: 'bus',
      label: 'Data connection',
      kind: 'enum',
      default: 'separate',
      options: [
        { value: 'separate', label: 'Separate in and out' },
        { value: 'single', label: 'One shared bus' },
      ],
      hint: 'A shared bus drives the stored word only while OE=1 and WE=0, and floats otherwise.',
    },
    { key: 'asyncRead', label: 'Asynchronous read', kind: 'bool', default: true, hint: 'Off: the output only changes on the clock edge.' },
    TRIGGER_EDGE,
    DELAY,
  ],
  title: (p) => `RAM ${1 << int(p, 'addrBits', 8)}×${int(p, 'dataBits', 8)}`,
  ...layoutFrom((p) => {
    const aw = int(p, 'addrBits', 8);
    const dw = int(p, 'dataBits', 8);
    const single = p.bus === 'single';
    return chip(
      [['a', 'A', aw], ...(single ? [] : [['din', 'D', dw] as PinSpec]), ['we', 'WE', 1, { floatAs: 0 }], ['oe', 'OE', 1, { floatAs: 1 }], CLK],
      [single ? ['d', 'D', dw, { dir: 'io' }] : ['dout', 'Q', dw]],
      70,
      { bottom: [CLR] },
    );
  }),
  init: ramInit,
  eval: (ctx): EvalResult => {
    let st = ctx.state as RamState;
    const dw = int(ctx.props, 'dataBits', 8);
    const single = ctx.props.bus === 'single';
    const addr = toUnsigned(ctx.get('a'));
    const { now, fire, idle } = clockOf(ctx, st.clk);
    const we = lv(ctx, 'we');
    const oe = lv(ctx, 'oe');
    const write = gate(fire, we);
    const din = ctx.get(single ? 'd' : 'din');
    if (write !== false && addr !== null) {
      const old = readWord(st, addr);
      st = storeWord(st, addr, write === true ? din : merge(old, din));
    }
    if (fire !== false) {
      const seen = addr === null ? unknown(dw) : readWord(st, addr);
      st = { ...st, last: fire === true ? seen : merge(st.last, seen) };
    }
    if (lv(ctx, 'clr') === 1) st = { words: {}, unk: {}, clk: st.clk, last: bits(dw, 0) };
    st = { ...st, clk: idle ? null : now };

    const shown = ctx.props.asyncRead ? (addr === null ? unknown(dw) : readWord(st, addr)) : st.last;
    if (single) {
      const drive = oe === 1 && we === 0 ? shown : oe === 0 || we === 1 ? floating(dw) : unknown(dw);
      return { out: { d: drive }, state: st };
    }
    return { out: { dout: oe === 1 ? shown : oe === 0 ? floating(dw) : unknown(dw) }, state: st };
  },
};

// ---------------------------------------------------------------- ROM

let romCache: { text: string; bits: number; words: number[] } | null = null;

/** Whitespace-separated hex words, address 0 first, each cut to `dataBits`. Bad tokens read as 0. */
export function parseRomContents(text: string, dataBits: number): number[] {
  if (romCache && romCache.text === text && romCache.bits === dataBits) return romCache.words;
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => hexValue(t, dataBits));
  romCache = { text, bits: dataBits, words };
  return words;
}

const rom: ComponentDef = {
  type: 'rom',
  name: 'ROM',
  category: 'Memory',
  description: 'Read-only memory holding fixed contents. Words not listed read as 0. An unknown address reads as x; OE=0 floats the output. Contents survive a simulation reset.',
  keywords: ['lookup table', 'read only', 'program', 'firmware'],
  persistent: true,
  props: [
    { key: 'addrBits', label: 'Address bits', kind: 'int', default: 4, min: 1, max: 16 },
    { key: 'dataBits', label: 'Data bits', kind: 'int', default: 8, min: 1, max: 32 },
    { key: 'contents', label: 'Contents (hex words)', kind: 'memory', default: '', hint: 'Words separated by spaces or new lines, address 0 first. Missing words are 0.' },
    DELAY,
  ],
  title: (p) => `ROM ${1 << int(p, 'addrBits', 4)}×${int(p, 'dataBits', 8)}`,
  ...layoutFrom((p) => chip([['a', 'A', int(p, 'addrBits', 4)], ['oe', 'OE', 1, { floatAs: 1 }]], [['d', 'D', int(p, 'dataBits', 8)]], 60)),
  eval: (ctx) => {
    const dw = int(ctx.props, 'dataBits', 8);
    const oe = lv(ctx, 'oe');
    if (oe === 0) return { out: { d: floating(dw) } };
    if (oe === 'x') return { out: { d: unknown(dw) } };
    const a = toUnsigned(ctx.get('a'));
    if (a === null) return { out: { d: unknown(dw) } };
    return { out: { d: bits(dw, parseRomContents(String(ctx.props.contents ?? ''), dw)[a] ?? 0) } };
  },
};

export const MEMORY: ComponentDef[] = [dff, tff, jkff, srff, dlatch, srlatch, register, counter, shiftreg, random, ram, rom];
