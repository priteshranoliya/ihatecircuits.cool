import { type Bits, bits, concat, floating, fromMasks, fromStates, mask, slice, unknown, type BitState } from '../bits';
import { BITS, DELAY, int, layoutFrom, range, type ComponentDef, type PinDef } from '../library';
import { splitterMap } from '../netlist';
import { hexValue, level, w } from './util';

/**
 * Wiring parts: ports, probes, splitters, tunnels, pull resistors, sources,
 * transistors and width converters.
 */

/** Pin: an input or output port. Inside a subcircuit, pins become the box's connections. */
const pin: ComponentDef = {
  type: 'pin',
  name: 'Pin',
  category: 'Wiring',
  description: 'A labelled input or output port. Input pins are set by clicking their bits; pins inside a circuit become its connections when it is used as a subcircuit.',
  keywords: ['port', 'input', 'output', 'terminal', 'bus input'],
  shape: 'pin',
  props: [
    {
      key: 'io',
      label: 'Direction',
      kind: 'enum',
      default: 'in',
      options: [
        { value: 'in', label: 'Input' },
        { value: 'out', label: 'Output' },
      ],
    },
    BITS(1),
    {
      key: 'behavior',
      label: 'Input behaviour',
      kind: 'enum',
      default: 'simple',
      options: [
        { value: 'simple', label: 'Simple (0 or 1)' },
        { value: 'tristate', label: 'Tri-state (0, 1 or floating)' },
      ],
      when: { key: 'io', is: ['in'] },
    },
    {
      key: 'radix',
      label: 'Show as',
      kind: 'enum',
      default: 'bin',
      options: [
        { value: 'bin', label: 'Binary' },
        { value: 'hex', label: 'Hex' },
        { value: 'dec', label: 'Unsigned decimal' },
        { value: 'signed', label: 'Signed decimal' },
      ],
    },
    { key: 'value', label: 'Value', kind: 'text', default: '0', runtime: true, hint: 'Bits from most to least significant; z means floating.' },
  ],
  ...layoutFrom((p) => {
    const width = w(p);
    const cells = Math.min(width, 8);
    const rows = Math.ceil(width / 8);
    const W = Math.max(30, Math.ceil((cells * 9 + 12) / 10) * 10);
    const H = Math.max(20, rows * 20);
    const out = p.io !== 'out';
    const pins: PinDef[] = [{ name: 'p', dir: out ? 'out' : 'in', x: out ? W : 0, y: 10, side: out ? 'r' : 'l', width }];
    return { w: W, h: H, pins };
  }),
  eval: ({ props }): { out: Record<string, Bits> } => {
    if (props.io === 'out') return { out: {} };
    return { out: { p: parsePinValue(String(props.value ?? '0'), w(props), props.behavior === 'tristate') } };
  },
};

/** "0101" or "zz01" (MSB first) → Bits. Missing high bits are 0. */
export function parsePinValue(s: string, width: number, allowZ: boolean): Bits {
  const chars = s.replace(/[^01zZ]/g, '').slice(-width).padStart(width, '0').split('').reverse();
  return fromStates(chars.map((c): BitState => (c === '1' ? 1 : (c === 'z' || c === 'Z') && allowZ ? 'z' : 0)));
}

export function formatPinValue(b: Bits): string {
  return Array.from({ length: b.w }, (_, i) => {
    const m = 1 << i;
    return b.z & m ? 'z' : b.v & m ? '1' : '0';
  })
    .reverse()
    .join('');
}

const probe: ComponentDef = {
  type: 'probe',
  name: 'Probe',
  category: 'Wiring',
  description: 'Shows the value on a wire of any width, without affecting it.',
  keywords: ['monitor', 'display value', 'watch'],
  shape: 'probe',
  wiring: 'probe',
  props: [
    {
      key: 'radix',
      label: 'Show as',
      kind: 'enum',
      default: 'bin',
      options: [
        { value: 'bin', label: 'Binary' },
        { value: 'hex', label: 'Hex' },
        { value: 'dec', label: 'Unsigned decimal' },
        { value: 'signed', label: 'Signed decimal' },
      ],
    },
  ],
  size: () => ({ w: 60, h: 20 }),
  pins: () => [{ name: 'p', dir: 'in', x: 0, y: 10, side: 'l', width: 0 }],
  eval: () => ({ out: {} }),
};

const splitter: ComponentDef = {
  type: 'splitter',
  name: 'Splitter',
  category: 'Wiring',
  description: 'Joins single wires into a bus or breaks a bus into smaller groups. Works in both directions, instantly.',
  keywords: ['bus', 'merge', 'combine', 'split', 'bundle', 'fan out'],
  shape: 'splitter',
  wiring: 'splitter',
  props: [
    { key: 'width', label: 'Bus width', kind: 'int', default: 4, min: 2, max: 32 },
    { key: 'fans', label: 'Branches', kind: 'int', default: 4, min: 2, max: 32 },
    {
      key: 'map',
      label: 'Bit assignment',
      kind: 'text',
      default: '',
      hint: 'Optional: for each bus bit from bit 0, the branch it goes to (−1 for none), e.g. "0 0 1 1". Empty spreads bits evenly.',
    },
  ],
  ...layoutFrom((p) => {
    const fans = Math.min(int(p, 'fans', 4), int(p, 'width', 4));
    const map = splitterMap(p, fans);
    const counts = range(fans).map((f) => map.filter((m) => m === f).length);
    const h = 20 * fans;
    return {
      w: 20,
      h,
      pins: [
        { name: 'c', dir: 'io', x: 0, y: 0, side: 'l', width: int(p, 'width', 4) },
        ...counts.map((n, f): PinDef => ({ name: `f${f}`, label: bitRange(map, f), dir: 'io', x: 20, y: 20 * f + 10, side: 'r', width: Math.max(1, n) })),
      ],
    };
  }),
  eval: () => ({ out: {} }),
};

function bitRange(map: number[], fan: number): string {
  const idx = map.map((m, i) => (m === fan ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return '–';
  const contiguous = idx.every((b, k) => k === 0 || b === idx[k - 1] + 1);
  if (idx.length === 1) return String(idx[0]);
  return contiguous ? `${idx.at(-1)}:${idx[0]}` : idx.join(',');
}

const tunnel: ComponentDef = {
  type: 'tunnel',
  name: 'Tunnel',
  category: 'Wiring',
  description: 'Connects to every other tunnel with the same name, as if wired, without drawing the wire.',
  keywords: ['label', 'net name', 'goto', 'connect by name'],
  shape: 'tunnel',
  wiring: 'tunnel',
  props: [{ key: 'name', label: 'Name', kind: 'text', default: 'A' }, BITS(1)],
  size: (p) => ({ w: Math.max(40, Math.ceil((String(p.name ?? '').length * 7 + 24) / 10) * 10), h: 20 }),
  pins: (p) => [{ name: 'p', dir: 'io', x: 0, y: 10, side: 'l', width: w(p) }],
  eval: () => ({ out: {} }),
};

const pull: ComponentDef = {
  type: 'pull',
  name: 'Pull resistor',
  category: 'Wiring',
  description: 'Weakly pulls a wire to 1 or 0 when nothing else drives it. Any active driver wins.',
  keywords: ['pull-up', 'pull-down', 'resistor', 'open drain', 'open collector', 'wired-and'],
  shape: 'pull',
  wiring: 'pull',
  props: [
    {
      key: 'pull',
      label: 'Pulls to',
      kind: 'enum',
      default: 'up',
      options: [
        { value: 'up', label: '1 (pull-up)' },
        { value: 'down', label: '0 (pull-down)' },
      ],
    },
  ],
  size: () => ({ w: 20, h: 40 }),
  pins: () => [{ name: 'p', dir: 'in', x: 10, y: 40, side: 'b', width: 0 }],
  eval: () => ({ out: {} }),
};

const junction: ComponentDef = {
  type: 'junction',
  name: 'Junction',
  category: 'Wiring',
  description: 'A connection dot. Wire several wires to it to branch a signal anywhere on the canvas.',
  keywords: ['node', 'dot', 'branch', 'tee', 'waypoint'],
  shape: 'junction',
  wiring: 'junction',
  props: [],
  size: () => ({ w: 20, h: 20 }),
  pins: () => [{ name: 'p', dir: 'io', x: 10, y: 10, side: 'r', width: 0 }],
  eval: () => ({ out: {} }),
};

const clock: ComponentDef = {
  type: 'clock',
  name: 'Clock',
  category: 'Inputs',
  description: 'A square wave. Each period is low for some ticks, then high for some ticks. Run or step the simulation to advance it.',
  keywords: ['oscillator', 'clk', 'timing', 'square wave'],
  shape: 'clock',
  clocked: true,
  sequential: true,
  props: [
    { key: 'high', label: 'High for (ticks)', kind: 'int', default: 1, min: 1, max: 64 },
    { key: 'low', label: 'Low for (ticks)', kind: 'int', default: 1, min: 1, max: 64 },
    { key: 'phase', label: 'Phase offset (ticks)', kind: 'int', default: 0, min: 0, max: 127 },
  ],
  size: () => ({ w: 40, h: 20 }),
  pins: () => [{ name: 'out', dir: 'out', x: 40, y: 10, side: 'r', width: 1 }],
  eval: ({ props, tick }) => {
    const hi = int(props, 'high', 1);
    const lo = int(props, 'low', 1);
    const pos = (tick + int(props, 'phase', 0)) % (hi + lo);
    return { out: { out: bits(1, pos >= lo ? 1 : 0) } };
  },
};

const constant: ComponentDef = {
  type: 'const',
  name: 'Constant',
  category: 'Inputs',
  description: 'A fixed value of any width.',
  keywords: ['literal', 'fixed', 'tie'],
  shape: 'const',
  props: [BITS(1), { key: 'value', label: 'Value (hex)', kind: 'hex', default: '1' }],
  size: (p) => ({ w: Math.max(30, Math.ceil((Math.ceil(w(p) / 4) * 8 + 16) / 10) * 10), h: 20 }),
  pins: (p) => [{ name: 'out', dir: 'out', x: Math.max(30, Math.ceil((Math.ceil(w(p) / 4) * 8 + 16) / 10) * 10), y: 10, side: 'r', width: w(p) }],
  eval: ({ props }) => ({ out: { out: bits(w(props), hexValue(props.value, w(props))) } }),
};

function rail(type: string, name: string, one: boolean): ComponentDef {
  return {
    type,
    name,
    category: 'Wiring',
    description: one ? 'Ties a wire to logic 1 (the supply rail).' : 'Ties a wire to logic 0 (ground).',
    keywords: one ? ['vcc', 'vdd', 'supply', 'high', 'logic 1'] : ['gnd', 'vss', 'low', 'logic 0'],
    shape: type,
    props: [BITS(1)],
    size: () => ({ w: 20, h: 30 }),
    pins: (p) => [one ? { name: 'out', dir: 'out', x: 10, y: 30, side: 'b', width: w(p) } : { name: 'out', dir: 'out', x: 10, y: 0, side: 't', width: w(p) }],
    eval: ({ props }) => ({ out: { out: bits(w(props), one ? mask(w(props)) : 0) } }),
  };
}

/**
 * Switch-level transistor. An N-type conducts when its gate is 1 and passes
 * only strong 0s; a P-type conducts when its gate is 0 and passes only strong
 * 1s. A level the transistor cannot pass cleanly is left floating, which is
 * why CMOS uses P-types in the pull-up network and N-types in the pull-down.
 */
function transistor(type: string, name: string, n: boolean): ComponentDef {
  return {
    type,
    name,
    category: 'Wiring',
    description: n
      ? 'Conducts from source to drain while its gate is 1. Passes 0s well; a 1 is not passed (it would be degraded), so the drain floats.'
      : 'Conducts from source to drain while its gate is 0. Passes 1s well; a 0 is not passed (it would be degraded), so the drain floats.',
    keywords: ['cmos', 'mosfet', n ? 'nmos' : 'pmos', 'switch level', 'pull-down network', 'pull-up network'],
    shape: type,
    props: [BITS(1), DELAY],
    size: () => ({ w: 40, h: 40 }),
    pins: (p) => [
      { name: 'g', label: 'G', dir: 'in', x: 0, y: 20, side: 'l', width: 1, bubble: !n },
      { name: 's', label: 'S', dir: 'in', x: 30, y: n ? 40 : 0, side: n ? 'b' : 't', width: w(p) },
      { name: 'd', label: 'D', dir: 'out', x: 30, y: n ? 0 : 40, side: n ? 't' : 'b', width: w(p) },
    ],
    eval: (ctx) => {
      const width = w(ctx.props);
      const g = level(ctx.get('g'));
      const s = ctx.raw('s');
      const on = n ? 1 : 0;
      // Bits the transistor can pass: known levels of the right polarity.
      const passable = (n ? ~s.v & ~s.x & ~s.z & ~s.e : s.v) & mask(width);
      if (g === 'x') return { out: { d: fromStates(range(width).map((i): BitState => (passable & (1 << i) ? 'x' : s.x & (1 << i) || s.e & (1 << i) ? 'x' : 'z'))) } };
      if (g !== on) return { out: { d: floating(width) } };
      return {
        out: {
          d: fromStates(
            range(width).map((i): BitState => {
              const m = 1 << i;
              if (s.e & m || s.x & m) return 'x';
              if (passable & m) return n ? 0 : 1;
              return 'z';
            }),
          ),
        },
      };
    },
  };
}

/** Transmission gate: an N- and a P-transistor in parallel, so both levels pass cleanly. */
const tgate: ComponentDef = {
  type: 'tgate',
  name: 'Transmission gate',
  category: 'Wiring',
  description: 'A bidirectional-style switch built from an N- and a P-transistor. Passes its input when N is 1 and P is 0; floats when N is 0 and P is 1.',
  keywords: ['pass gate', 'analog switch', 'cmos', 'switch level'],
  shape: 'tgate',
  props: [BITS(1), DELAY],
  size: () => ({ w: 40, h: 40 }),
  pins: (p) => [
    { name: 's', label: 'S', dir: 'in', x: 0, y: 20, side: 'l', width: w(p) },
    { name: 'n', label: 'N', dir: 'in', x: 20, y: 0, side: 't', width: 1 },
    { name: 'p', label: 'P', dir: 'in', x: 20, y: 40, side: 'b', width: 1, bubble: true },
    { name: 'd', label: 'D', dir: 'out', x: 40, y: 20, side: 'r', width: w(p) },
  ],
  eval: (ctx) => {
    const width = w(ctx.props);
    const n = level(ctx.get('n'));
    const p = level(ctx.get('p'));
    const s = ctx.raw('s');
    if (n === 1 && p === 0) return { out: { d: s } };
    if (n === 0 && p === 1) return { out: { d: floating(width) } };
    // Only one half conducts (degraded level) or the control is unknown.
    return { out: { d: fromStates(range(width).map((i): BitState => (s.z & (1 << i) ? 'z' : 'x'))) } };
  },
};

const extender: ComponentDef = {
  type: 'extender',
  name: 'Bit extender',
  category: 'Wiring',
  description: 'Changes a value’s width. Narrowing keeps the low bits; widening fills the new high bits with 0, 1, a copy of the sign bit, or an input.',
  keywords: ['sign extend', 'zero extend', 'truncate', 'widen', 'width'],
  props: [
    { key: 'inBits', label: 'Input bits', kind: 'int', default: 4, min: 1, max: 32 },
    { key: 'outBits', label: 'Output bits', kind: 'int', default: 8, min: 1, max: 32 },
    {
      key: 'fill',
      label: 'Fill with',
      kind: 'enum',
      default: 'zero',
      options: [
        { value: 'zero', label: 'Zeros' },
        { value: 'one', label: 'Ones' },
        { value: 'sign', label: 'Sign bit (two’s complement)' },
        { value: 'input', label: 'Fill input' },
      ],
    },
    DELAY,
  ],
  title: (p) => (p.fill === 'sign' ? 'SEXT' : 'EXT'),
  ...layoutFrom((p) => ({
    w: 60,
    h: 40,
    pins: [
      { name: 'in', label: String(p.inBits), dir: 'in', x: 0, y: 20, side: 'l', width: int(p, 'inBits', 4) },
      { name: 'out', label: String(p.outBits), dir: 'out', x: 60, y: 20, side: 'r', width: int(p, 'outBits', 8) },
      ...(p.fill === 'input' ? [{ name: 'fill', dir: 'in', x: 30, y: 0, side: 't', width: 1 } as PinDef] : []),
    ],
  })),
  eval: (ctx) => {
    const wi = int(ctx.props, 'inBits', 4);
    const wo = int(ctx.props, 'outBits', 8);
    const v = ctx.get('in');
    if (wo <= wi) return { out: { out: slice(v, 0, wo) } };
    let fillBit: Bits;
    const mode = ctx.props.fill;
    if (mode === 'one') fillBit = bits(1, 1);
    else if (mode === 'sign') fillBit = slice(v, wi - 1, 1);
    else if (mode === 'input') fillBit = ctx.get('fill');
    else fillBit = bits(1, 0);
    const extra = wo - wi;
    const run = mask(extra);
    const fill = fromMasks(extra, fillBit.v ? run : 0, fillBit.x ? run : 0, fillBit.z ? run : 0, fillBit.e ? run : 0);
    return { out: { out: concat([v, fill]) } };
  },
};

const noconnect: ComponentDef = {
  type: 'noconnect',
  name: 'Not connected',
  category: 'Wiring',
  description: 'Marks an output as deliberately unused. Drives nothing.',
  keywords: ['nc', 'unused', 'terminator'],
  shape: 'noconnect',
  props: [],
  size: () => ({ w: 20, h: 20 }),
  pins: () => [{ name: 'p', dir: 'in', x: 0, y: 10, side: 'l', width: 0 }],
  eval: () => ({ out: {} }),
};

export const WIRING: ComponentDef[] = [pin, probe, splitter, tunnel, junction, pull, rail('power', 'Power', true), rail('ground', 'Ground', false), transistor('nmos', 'N-type transistor', true), transistor('pmos', 'P-type transistor', false), tgate, extender, noconnect];
export const SOURCES: ComponentDef[] = [clock, constant];
export { unknown };
