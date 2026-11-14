import type { Bits } from './bits';
import type { Component, PropValue, Props } from './types';

/**
 * Component library contract.
 *
 * A component definition is pure data plus a pure `eval` function. Layout is
 * in a local, unrotated frame on a 10px grid: pins sit on the bounding box
 * edge and their tips are always on grid points.
 */

export type Side = 'l' | 'r' | 't' | 'b';

export interface PinDef {
  name: string;
  /** Short text drawn inside the body next to the pin. */
  label?: string;
  /** 'io' pins both read the net and drive it (z when not driving), e.g. a RAM data bus. */
  dir: 'in' | 'out' | 'io';
  x: number;
  y: number;
  side: Side;
  /** Bit width, 1..32. */
  width: number;
  /** Value an unconnected control input reads instead of floating (e.g. enable = 1, clear = 0). */
  floatAs?: 0 | 1;
  /** Drawn with the clock triangle. */
  clock?: boolean;
  /** Drawn with an inversion bubble (active-low). */
  bubble?: boolean;
}

export interface PropOption {
  value: string;
  label: string;
}

export interface PropDef {
  key: string;
  label: string;
  kind: 'int' | 'bool' | 'enum' | 'text' | 'hex' | 'memory';
  default: PropValue;
  min?: number;
  max?: number;
  options?: PropOption[];
  /** Runtime value (switch position) rather than structure: not undoable, does not reset state. */
  runtime?: boolean;
  /** One-line help shown under the field. */
  hint?: string;
  /** Show only when another prop has one of these values. */
  when?: { key: string; is: PropValue[] };
}

export interface EvalCtx {
  /** Input value as a component should read it: floating/conflict bits read as unknown (x). */
  get(pin: string): Bits;
  /** Raw resolved net value, keeping z and e (for pass-through parts like transistors). */
  raw(pin: string): Bits;
  /** Whether anything is attached to the pin. */
  connected(pin: string): boolean;
  props: Props;
  state: unknown;
  /** Clock ticks since start/reset. */
  tick: number;
}

export interface EvalResult {
  /** New value for each output/io pin, by pin name. Omitted pins keep their value. */
  out: Record<string, Bits>;
  state?: unknown;
}

export type Category = 'Gates' | 'Wiring' | 'Inputs' | 'Outputs' | 'Plexers' | 'Arithmetic' | 'Memory' | 'Circuits' | 'Notes';

export const CATEGORIES: Category[] = ['Gates', 'Wiring', 'Inputs', 'Outputs', 'Plexers', 'Arithmetic', 'Memory', 'Circuits', 'Notes'];

export interface ComponentDef {
  type: string;
  name: string;
  category: Category;
  /** One or two plain sentences: what it does, in the user's terms. */
  description: string;
  /** Extra search words for the command palette. */
  keywords?: string[];
  props: PropDef[];
  /** Propagation delay in gate delays (default 1). A `delay` prop overrides it. */
  delay?: number;
  /** Re-evaluated on every clock tick (clock sources). */
  clocked?: boolean;
  /** Has memory or time-dependent behaviour. */
  sequential?: boolean;
  /** Contents survive a simulation reset (ROM, non-volatile RAM). */
  persistent?: boolean;
  /** A user-controlled input: a truth table column. */
  source?: boolean;
  /** An observed output: a truth table result column. */
  sink?: boolean;
  /** Pure wiring handled by the netlist and never evaluated. A probe is a reader that does nothing. */
  wiring?: 'splitter' | 'tunnel' | 'pull' | 'junction' | 'probe';
  /** An instance of another circuit in the project. */
  subcircuit?: boolean;
  /** Title drawn inside chip-style bodies. */
  title?: (props: Props) => string;
  /** Body drawing style; renderers fall back to a labelled chip. */
  shape?: string;
  size(props: Props): { w: number; h: number };
  pins(props: Props): PinDef[];
  init?(props: Props): unknown;
  eval(ctx: EvalCtx): EvalResult;
}

const registry = new Map<string, ComponentDef>();
/** Resolver for project-defined subcircuit types, installed by the project layer. */
let dynamicResolver: ((type: string) => ComponentDef | undefined) | null = null;

export function register(defs: readonly ComponentDef[]) {
  for (const d of defs) {
    if (registry.has(d.type)) throw new Error(`Duplicate component type ${d.type}`);
    registry.set(d.type, d);
  }
}

export function setDynamicResolver(fn: typeof dynamicResolver) {
  dynamicResolver = fn;
  pinCache = new WeakMap();
}

export const LIBRARY: ReadonlyMap<string, ComponentDef> = registry;

export function findDef(type: string): ComponentDef | undefined {
  return registry.get(type) ?? dynamicResolver?.(type);
}

export function getDef(type: string): ComponentDef {
  const def = findDef(type);
  if (!def) throw new Error(`Unknown component type "${type}"`);
  return def;
}

let pinCache = new WeakMap<Props, Map<string, PinDef[]>>();

/** Pins of a component instance, cached on the (immutable) props object. */
export function pinsOf(comp: Pick<Component, 'type' | 'props'>): PinDef[] {
  let m = pinCache.get(comp.props);
  if (!m) pinCache.set(comp.props, (m = new Map()));
  // Subcircuit layouts change when their circuit is edited, so never cache them here.
  if (comp.type.startsWith('sub:')) return getDef(comp.type).pins(comp.props);
  let pins = m.get(comp.type);
  if (!pins) m.set(comp.type, (pins = getDef(comp.type).pins(comp.props)));
  return pins;
}

/** Fill in defaults, coerce types and clamp ranges so stored props are always valid. */
export function sanitizeProps(type: string, raw: Readonly<Record<string, unknown>> = {}): Props {
  const out: Record<string, PropValue> = {};
  for (const d of getDef(type).props) {
    const v = raw[d.key];
    if (d.kind === 'int') {
      const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : (d.default as number);
      out[d.key] = Math.min(d.max ?? n, Math.max(d.min ?? n, n));
    } else if (d.kind === 'bool') out[d.key] = typeof v === 'boolean' ? v : (d.default as boolean);
    else if (d.kind === 'enum') out[d.key] = d.options!.some((o) => o.value === v) ? (v as string) : (d.default as string);
    else if (d.kind === 'hex') out[d.key] = typeof v === 'string' && /^[0-9a-fA-F]{1,8}$/.test(v) ? v.toUpperCase() : (d.default as string);
    else if (d.kind === 'memory') out[d.key] = typeof v === 'string' ? v.replace(/[^0-9a-fA-F\s]/g, '').slice(0, 1 << 20) : (d.default as string);
    else out[d.key] = typeof v === 'string' ? v.slice(0, 200) : (d.default as string);
  }
  return out;
}

// ---------------------------------------------------------------- layout helpers shared by part files

export const int = (p: Props, key: string, fallback: number): number => (typeof p[key] === 'number' ? (p[key] as number) : fallback);
export const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** [name, label, width, options] */
export type PinSpec = [name: string, label: string, width?: number, opts?: Partial<PinDef>];

/**
 * Rectangular "chip" layout: inputs down the left, outputs down the right,
 * 20px apart, under a title row. Extra pins can go on the top and bottom edges.
 */
export function chip(left: PinSpec[], right: PinSpec[], bodyW = 60, extra: { top?: PinSpec[]; bottom?: PinSpec[] } = {}) {
  const tops = extra.top ?? [];
  const bottoms = extra.bottom ?? [];
  const w = Math.max(bodyW + 20, 20 * Math.max(tops.length, bottoms.length) + 40);
  // Bottom-edge pins get a row of their own so their labels clear the last side pin.
  const h = 20 * Math.max(left.length, right.length, 1) + 20 + (bottoms.length ? 20 : 0);
  const pin = (spec: PinSpec, dir: PinDef['dir'], x: number, y: number, side: Side): PinDef => ({
    name: spec[0],
    label: spec[1],
    dir,
    x,
    y,
    side,
    width: spec[2] ?? 1,
    ...spec[3],
  });
  const pins: PinDef[] = [
    ...left.map((s, i) => pin(s, s[3]?.dir ?? 'in', 0, 30 + 20 * i, 'l')),
    ...right.map((s, i) => pin(s, s[3]?.dir ?? 'out', w, 30 + 20 * i, 'r')),
    ...tops.map((s, i) => pin(s, s[3]?.dir ?? 'in', 30 + 20 * i, 0, 't')),
    ...bottoms.map((s, i) => pin(s, s[3]?.dir ?? 'in', 30 + 20 * i, h, 'b')),
  ];
  return { w, h, pins };
}

/** Memoised size/pins for definitions whose layout depends on props. */
export function layoutFrom(build: (p: Props) => { w: number; h: number; pins: PinDef[] }) {
  const cache = new WeakMap<Props, { w: number; h: number; pins: PinDef[] }>();
  const get = (p: Props) => {
    let l = cache.get(p);
    if (!l) cache.set(p, (l = build(p)));
    return l;
  };
  return { size: (p: Props) => get(p), pins: (p: Props) => get(p).pins };
}

/** Standard "Data bits" prop. */
export const BITS = (def = 1, label = 'Data bits'): PropDef => ({ key: 'bits', label, kind: 'int', default: def, min: 1, max: 32 });
/** Standard propagation-delay prop (in gate delays). */
export const DELAY: PropDef = {
  key: 'delay',
  label: 'Delay',
  kind: 'int',
  default: 1,
  min: 1,
  max: 64,
  hint: 'Propagation delay in gate delays. Unequal delays make glitches visible.',
};

/**
 * Power-on value of a stored bit or word (registers, flip-flops, latches). It is where the part starts and what a
 * reset of the simulation restores; empty means 0.
 */
export const POWER_ON: PropDef = {
  key: 'init',
  label: 'Power-on value',
  kind: 'text',
  default: '',
  hint: 'Bits, most significant first, over 0, 1 and x (unknown). Empty powers on at 0.',
};

export const TRIGGER_EDGE: PropDef = {
  key: 'trigger',
  label: 'Trigger',
  kind: 'enum',
  default: 'rising',
  options: [
    { value: 'rising', label: 'Rising edge' },
    { value: 'falling', label: 'Falling edge' },
  ],
};
export const TRIGGER_ANY: PropDef = {
  ...TRIGGER_EDGE,
  options: [...TRIGGER_EDGE.options!, { value: 'high', label: 'High level' }, { value: 'low', label: 'Low level' }],
};

/** A user-controlled input: becomes a truth-table column. */
export function isSource(c: Pick<Component, 'type' | 'props'>): boolean {
  return c.type === 'pin' ? c.props.io !== 'out' : !!findDef(c.type)?.source;
}

/** An observed output: becomes truth-table result columns. */
export function isSink(c: Pick<Component, 'type' | 'props'>): boolean {
  if (c.type === 'probe') return true;
  return c.type === 'pin' ? c.props.io === 'out' : !!findDef(c.type)?.sink;
}
