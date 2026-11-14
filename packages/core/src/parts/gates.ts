import { type Bits, and, floating, not, or, unknown, xor, exactlyOne, mask, asInput } from '../bits';
import { BITS, DELAY, int, range, type ComponentDef, type EvalCtx, type PinDef, type PropDef } from '../library';
import type { Props } from '../types';
import { w } from './util';

/**
 * Logic gates. Inputs and outputs are `bits` wide and act bit by bit.
 *
 * Unknowns follow Kleene logic: a known controlling input decides the result
 * (0 for AND, 1 for OR); otherwise an unknown input makes that bit unknown.
 * Unconnected inputs are ignored, so a 4-input gate with two wires acts as a
 * 2-input gate; with nothing connected the output is unknown.
 */

const INPUTS: PropDef = { key: 'inputs', label: 'Inputs', kind: 'int', default: 2, min: 2, max: 16 };
const NEGATE: PropDef = {
  key: 'negate',
  label: 'Inverted inputs',
  kind: 'text',
  default: '',
  hint: 'Input numbers to invert, counted from 1 at the top, e.g. "1 3".',
};
const OUTPUT: PropDef = {
  key: 'output',
  label: 'Output drive',
  kind: 'enum',
  default: '01',
  options: [
    { value: '01', label: 'Push-pull (0 and 1)' },
    { value: '0z', label: 'Open drain (0 or floating)' },
    { value: 'z1', label: 'Open source (floating or 1)' },
  ],
  hint: 'Open drain with a pull-up resistor makes a wired-AND bus.',
};
const MULTI: PropDef = {
  key: 'multi',
  label: 'With 3+ inputs',
  kind: 'enum',
  default: 'odd',
  options: [
    { value: 'odd', label: '1 when an odd number are 1' },
    { value: 'one', label: '1 when exactly one is 1' },
  ],
};

const NO_INPUTS_NEGATED: Set<number> = new Set();

/** Zero-based indices of the inputs a gate inverts. The set must not be modified. */
export function negatedInputs(p: Props): Set<number> {
  if (!p.negate) return NO_INPUTS_NEGATED;
  return new Set(
    String(p.negate ?? '')
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1)
      .map((n) => n - 1),
  );
}

/** Apply the output drive mode: open drain turns 1s into z, open source turns 0s into z. */
export function drive(v: Bits, mode: unknown): Bits {
  if (mode === '0z') return { ...v, v: 0, z: (v.z | (v.v & ~v.x & ~v.e)) >>> 0 };
  if (mode === 'z1') return { ...v, z: (v.z | (~v.v & ~v.x & ~v.e & mask(v.w))) >>> 0 };
  return v;
}

const IN_NAMES: string[] = [];
const inName = (i: number) => (IN_NAMES[i] ??= `in${i}`);

function connectedInputs(ctx: EvalCtx, n: number): Bits[] {
  const neg = negatedInputs(ctx.props);
  const vals: Bits[] = [];
  for (let i = 0; i < n; i++) {
    const pin = inName(i);
    if (!ctx.connected(pin)) continue;
    const v = ctx.get(pin);
    vals.push(neg.has(i) ? not(v) : v);
  }
  return vals;
}

const gateSize = (p: Props) => {
  const n = int(p, 'inputs', 2);
  return { w: n <= 3 ? 60 : 80, h: 20 * n };
};

function gatePins(p: Props): PinDef[] {
  const n = int(p, 'inputs', 2);
  const width = w(p);
  const { w: W, h } = gateSize(p);
  return [
    ...range(n).map((i): PinDef => ({ name: `in${i}`, dir: 'in', x: 0, y: 10 + 20 * i, side: 'l', width })),
    { name: 'out', dir: 'out', x: W, y: h / 2, side: 'r', width },
  ];
}

function gate(type: string, name: string, description: string, fn: (vs: Bits[], width: number, p: Props) => Bits, extra: PropDef[] = [], keywords: string[] = []): ComponentDef {
  return {
    type,
    name,
    category: 'Gates',
    description,
    keywords,
    shape: type,
    props: [INPUTS, BITS(1), ...extra, NEGATE, OUTPUT, DELAY],
    size: gateSize,
    pins: gatePins,
    eval: (ctx) => {
      const width = w(ctx.props);
      const vals = connectedInputs(ctx, int(ctx.props, 'inputs', 2));
      const v = vals.length ? fn(vals, width, ctx.props) : unknown(width);
      return { out: { out: drive(v, ctx.props.output) } };
    },
  };
}

const xorOf = (vs: Bits[], width: number, p: Props) => (p.multi === 'one' && vs.length > 2 ? exactlyOne(vs, width) : xor(vs, width));

function unary(type: string, name: string, description: string, fn: (v: Bits) => Bits, keywords: string[] = []): ComponentDef {
  return {
    type,
    name,
    category: 'Gates',
    description,
    keywords,
    shape: type,
    props: [BITS(1), OUTPUT, DELAY],
    size: () => ({ w: 50, h: 20 }),
    pins: (p) => [
      { name: 'in0', dir: 'in', x: 0, y: 10, side: 'l', width: w(p) },
      { name: 'out', dir: 'out', x: 50, y: 10, side: 'r', width: w(p) },
    ],
    eval: (ctx) => ({ out: { out: drive(ctx.connected('in0') ? fn(ctx.get('in0')) : unknown(w(ctx.props)), ctx.props.output) } }),
  };
}

/** Tri-state buffer / inverter: passes (or inverts) its input while EN is 1; floats while EN is 0. */
function controlled(type: string, name: string, description: string, invert: boolean): ComponentDef {
  return {
    type,
    name,
    category: 'Gates',
    description,
    keywords: ['tri-state', 'three-state', 'bus', 'enable', 'high impedance'],
    shape: type,
    props: [
      BITS(1),
      {
        key: 'enable',
        label: 'Enable is',
        kind: 'enum',
        default: 'high',
        options: [
          { value: 'high', label: 'Active high' },
          { value: 'low', label: 'Active low' },
        ],
      },
      DELAY,
    ],
    size: () => ({ w: 50, h: 20 }),
    pins: (p) => [
      { name: 'in0', dir: 'in', x: 0, y: 10, side: 'l', width: w(p) },
      { name: 'en', label: 'EN', dir: 'in', x: 20, y: 20, side: 'b', width: 1, bubble: p.enable === 'low' },
      { name: 'out', dir: 'out', x: 50, y: 10, side: 'r', width: w(p) },
    ],
    eval: (ctx) => {
      const width = w(ctx.props);
      const en = asInput(ctx.raw('en'));
      const active = ctx.props.enable === 'low' ? 0 : 1;
      if (en.x & 1) return { out: { out: unknown(width) } };
      if ((en.v & 1) !== active) return { out: { out: floating(width) } };
      const v = ctx.get('in0');
      return { out: { out: invert ? not(v) : v } };
    },
  };
}

function parity(type: string, name: string, odd: boolean): ComponentDef {
  return {
    // Drawn as a box with the IEEE parity qualifier: 2k+1 (odd) or 2k (even).
    ...parityGate(odd),
    title: () => (odd ? '2k+1' : '2k'),
  };
  function parityGate(o: boolean) {
    return gate(
      type,
      name,
      o ? 'Outputs 1 when an odd number of inputs are 1.' : 'Outputs 1 when an even number of inputs are 1.',
      (vs, width) => (o ? xor(vs, width) : not(xor(vs, width))),
      [],
      ['parity', 'checksum'],
    );
  }
}

export const GATES: ComponentDef[] = [
  gate('and', 'AND', 'Output is 1 only when every input is 1.', and, [], ['conjunction', 'product']),
  gate('or', 'OR', 'Output is 1 when at least one input is 1.', or, [], ['disjunction', 'sum']),
  unary('not', 'NOT', 'Inverts each bit of its input.', not, ['inverter', 'complement']),
  unary('buffer', 'Buffer', 'Passes its input through unchanged, after a delay.', (v) => v, ['repeater', 'delay']),
  gate('nand', 'NAND', 'Inverted AND: 0 only when every input is 1. Any logic can be built from NAND alone.', (vs, wd) => not(and(vs, wd)), [], ['universal']),
  gate('nor', 'NOR', 'Inverted OR: 1 only when every input is 0. Any logic can be built from NOR alone.', (vs, wd) => not(or(vs, wd)), [], ['universal']),
  gate('xor', 'XOR', 'Exclusive OR. With two inputs: 1 when they differ.', xorOf, [MULTI], ['exclusive', 'difference']),
  gate('xnor', 'XNOR', 'Inverted XOR. With two inputs: 1 when they are equal.', (vs, wd, p) => not(xorOf(vs, wd, p)), [MULTI], ['equivalence', 'equality']),
  parity('oddparity', 'Odd parity', true),
  parity('evenparity', 'Even parity', false),
  controlled('tribuf', 'Tri-state buffer', 'Passes its input while enabled; otherwise lets go of the wire (high impedance) so another part can drive it.', false),
  controlled('triinv', 'Tri-state inverter', 'Inverts its input while enabled; otherwise lets go of the wire (high impedance).', true),
];

/** Exposed for tests. */
export const _gateInternals = { drive, xorOf };
export { mask };
