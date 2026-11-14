import { type Bits, bitAt, bits, floating, fromStates, mask, unknown, type BitState } from '../bits';
import { BITS, DELAY, chip, layoutFrom, range, type ComponentDef, type EvalCtx, type PinSpec, type PropDef } from '../library';
import type { Props } from '../types';
import { indexBits, merge, w } from './util';

/**
 * Plexers: parts that route or select data.
 *
 * Unknown selects are handled with partial knowledge: every choice still
 * consistent with the known select bits is a candidate, and an output bit keeps
 * a value only when every candidate agrees on it. Disabled outputs either drive
 * 0 or let go of the wire (z), per the part's property.
 */

const sel = (p: Props) => w(p, 'sel', 1);
const SEL: PropDef = { key: 'sel', label: 'Select bits', kind: 'int', default: 1, min: 1, max: 5, hint: 'The part has 2^n data lines for n select bits.' };
const ENABLE: PropDef = { key: 'enable', label: 'Enable pin', kind: 'bool', default: false, hint: 'Adds an EN input. Left unconnected it counts as 1 (always enabled).' };
const idleProp = (key: string, label: string, hint: string): PropDef => ({
  key,
  label,
  kind: 'enum',
  default: 'zero',
  options: [
    { value: 'zero', label: 'Drive 0' },
    { value: 'float', label: 'Float (high impedance)' },
  ],
  hint,
});
const EN_PIN: PinSpec = ['en', 'EN', 1, { floatAs: 1 }];

/** The value a switched-off output takes: 0, or z when the part is set to float. */
const idle = (p: Props, key: string, width: number): Bits => (p[key] === 'float' ? floating(width) : bits(width, 0));

/** Every select value in 0..n-1 that agrees with the known bits of `s`. */
function candidates(s: Bits, n: number): number[] {
  const known = ~s.x & mask(s.w);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (((i ^ s.v) & known) === 0) out.push(i);
  return out;
}

type Enabled = 'on' | 'off' | 'unknown';
function enabledState(ctx: EvalCtx): Enabled {
  if (!ctx.props.enable) return 'on';
  const en = ctx.get('en');
  if (en.x & 1) return 'unknown';
  return en.v & 1 ? 'on' : 'off';
}

const mergeAll = (vs: Bits[]): Bits => vs.reduce((a, b) => merge(a, b));

// ---------------------------------------------------------------- multiplexer

const mux: ComponentDef = {
  type: 'mux',
  name: 'Multiplexer',
  category: 'Plexers',
  description: 'Copies one of its data inputs to the output, chosen by the select number. If the select is partly unknown, output bits that every possible choice agrees on stay known.',
  keywords: ['selector', 'mux', 'data selector', 'choose', 'switch'],
  title: () => 'MUX',
  props: [
    BITS(1),
    SEL,
    ENABLE,
    idleProp('disabled', 'When disabled', 'What the output does while EN is 0.'),
    DELAY,
  ],
  ...layoutFrom((p) => {
    const bottom: PinSpec[] = [['s', 'S', sel(p)]];
    if (p.enable) bottom.push(EN_PIN);
    return chip(
      range(1 << sel(p)).map((i): PinSpec => [`d${i}`, String(i), w(p)]),
      [['y', '', w(p)]],
      40,
      { bottom },
    );
  }),
  eval: (ctx) => {
    const width = w(ctx.props);
    const n = 1 << sel(ctx.props);
    const en = enabledState(ctx);
    if (en === 'unknown') return { out: { y: unknown(width) } };
    if (en === 'off') return { out: { y: idle(ctx.props, 'disabled', width) } };
    const picks = candidates(ctx.get('s'), n).map((i) => ctx.get(`d${i}`));
    return { out: { y: mergeAll(picks) } };
  },
};

// ---------------------------------------------------------------- demultiplexer

const demux: ComponentDef = {
  type: 'demux',
  name: 'Demultiplexer',
  category: 'Plexers',
  description: 'Sends its data input to the one output chosen by the select number; every other output is 0 or floating.',
  keywords: ['demux', 'distributor', 'route', 'steer'],
  title: () => 'DMX',
  props: [BITS(1), SEL, ENABLE, idleProp('unselected', 'Unselected outputs', 'Value on outputs that are not chosen (or all outputs while EN is 0).'), DELAY],
  ...layoutFrom((p) => {
    const bottom: PinSpec[] = [['s', 'S', sel(p)]];
    if (p.enable) bottom.push(EN_PIN);
    return chip([['d', '', w(p)]], range(1 << sel(p)).map((i): PinSpec => [`y${i}`, String(i), w(p)]), 40, { bottom });
  }),
  eval: (ctx) => {
    const width = w(ctx.props);
    const n = 1 << sel(ctx.props);
    const en = enabledState(ctx);
    const out: Record<string, Bits> = {};
    if (en === 'unknown') {
      for (const i of range(n)) out[`y${i}`] = unknown(width);
      return { out };
    }
    const off = idle(ctx.props, 'unselected', width);
    const data = ctx.get('d');
    // An output that might be selected is either the data or the idle value.
    const maybe = en === 'on' ? new Set(candidates(ctx.get('s'), n)) : new Set<number>();
    const certain = maybe.size === 1;
    for (const i of range(n)) out[`y${i}`] = !maybe.has(i) ? off : certain ? data : merge(data, off);
    return { out };
  },
};

// ---------------------------------------------------------------- decoder

const decoder: ComponentDef = {
  type: 'decoder',
  name: 'Decoder',
  category: 'Plexers',
  description: 'Turns a binary number into a single active line: output n is 1 when the select equals n, and the others are 0 or floating.',
  keywords: ['one-hot', 'address decode', '3-to-8', '2-to-4', 'demux'],
  title: () => 'DEC',
  props: [SEL, ENABLE, idleProp('unselected', 'Unselected outputs', 'Value on outputs that are not chosen (or all outputs while EN is 0).'), DELAY],
  ...layoutFrom((p) => {
    const bottom: PinSpec[] = [['s', 'S', sel(p)]];
    if (p.enable) bottom.push(EN_PIN);
    return chip([], range(1 << sel(p)).map((i): PinSpec => [`y${i}`, String(i)]), 40, { bottom });
  }),
  eval: (ctx) => {
    const n = 1 << sel(ctx.props);
    const en = enabledState(ctx);
    const out: Record<string, Bits> = {};
    if (en === 'unknown') {
      for (const i of range(n)) out[`y${i}`] = unknown(1);
      return { out };
    }
    const off = idle(ctx.props, 'unselected', 1);
    const maybe = en === 'on' ? new Set(candidates(ctx.get('s'), n)) : new Set<number>();
    const certain = maybe.size === 1;
    for (const i of range(n)) out[`y${i}`] = !maybe.has(i) ? off : certain ? bits(1, 1) : merge(bits(1, 1), off);
    return { out };
  },
};

// ---------------------------------------------------------------- priority encoder

const encoder: ComponentDef = {
  type: 'encoder',
  name: 'Priority encoder',
  category: 'Plexers',
  description:
    'Reports the number of the highest input that is 1. "V" says some input was 1; "EO" (enable out) is 1 when enabled and nothing was active, so encoders can be chained. Output is 0 (or floating) when nothing is active.',
  keywords: ['priority', 'encode', 'highest', 'arbiter', 'one-hot to binary'],
  title: () => 'ENC',
  props: [
    SEL,
    ENABLE,
    idleProp('disabled', 'When idle', 'Value of the number output when disabled or when no input is 1.'),
    DELAY,
  ],
  ...layoutFrom((p) => {
    const bottom: PinSpec[] = p.enable ? [EN_PIN] : [];
    return chip(
      range(1 << sel(p)).map((i): PinSpec => [`i${i}`, String(i)]),
      [
        ['y', 'Y', sel(p)],
        ['v', 'V'],
        ['eo', 'EO'],
      ],
      40,
      { bottom },
    );
  }),
  eval: (ctx) => {
    const sb = sel(ctx.props);
    const n = 1 << sb;
    const idleY = idle(ctx.props, 'disabled', sb);
    const en = enabledState(ctx);
    if (en === 'unknown') return { out: { y: unknown(sb), v: unknown(1), eo: unknown(1) } };
    if (en === 'off') return { out: { y: idleY, v: bits(1, 0), eo: bits(1, 0) } };
    // Highest input that is a definite 1, and any unknown inputs ranked above it.
    let top = -1;
    const maybes: number[] = [];
    for (let i = n - 1; i >= 0 && top < 0; i--) {
      const s = bitAt(ctx.get(`i${i}`), 0);
      if (s === 1) top = i;
      else if (s !== 0) maybes.push(i);
    }
    const resultY = (k: number) => (k < 0 ? idleY : bits(sb, k));
    const y = mergeAll([top, ...maybes].map(resultY));
    if (maybes.length === 0) return { out: { y, v: bits(1, top >= 0 ? 1 : 0), eo: bits(1, top >= 0 ? 0 : 1) } };
    // Some unknown input outranks every known 1 (or there is none): V and EO depend on it.
    if (top >= 0) return { out: { y, v: bits(1, 1), eo: bits(1, 0) } };
    return { out: { y, v: unknown(1), eo: unknown(1) } };
  },
};

// ---------------------------------------------------------------- bit selector

const groups = (p: Props) => Math.ceil(w(p) / Math.max(1, w(p, 'outBits')));

const bitselect: ComponentDef = {
  type: 'bitselect',
  name: 'Bit selector',
  category: 'Plexers',
  description: 'Picks one group of bits out of a wide value. Group k is the k-th slice of the output width, counting from the lowest bit. Bits past the top read 0, and a select beyond the last group gives 0.',
  keywords: ['extract', 'slice', 'index', 'nibble', 'byte lane', 'bit picker'],
  title: () => 'SEL',
  props: [BITS(8), { key: 'outBits', label: 'Output bits', kind: 'int', default: 1, min: 1, max: 32, hint: 'Width of each group; the select number picks which group.' }, DELAY],
  ...layoutFrom((p) => chip([['d', 'D', w(p)]], [['y', '', w(p, 'outBits')]], 40, { bottom: [['s', 'S', indexBits(groups(p))]] })),
  eval: (ctx) => {
    const width = w(ctx.props);
    const ob = w(ctx.props, 'outBits');
    const g = groups(ctx.props);
    const data = ctx.get('d');
    const pick = (k: number): Bits =>
      fromStates(range(ob).map((i): BitState => (k < g && k * ob + i < width ? bitAt(data, k * ob + i) : 0)));
    const choices = candidates(ctx.get('s'), 1 << indexBits(g)).map(pick);
    return { out: { y: mergeAll(choices) } };
  },
};

export const PLEXERS: ComponentDef[] = [mux, demux, decoder, encoder, bitselect];
