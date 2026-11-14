import { bitAt, type BitState } from './bits';
import { findDef, isSink, isSource } from './library';
import { Simulator } from './sim';
import type { Circuit, Component } from './types';

/** Truth tables, minimisation (Quine–McCluskey) and Karnaugh-map data. */

export const MAX_TABLE_INPUTS = 12;

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byLabel = (a: Component, b: Component) => natural.compare(a.label || a.id, b.label || b.id) || natural.compare(a.id, b.id);

export const displayName = (c: Component) => c.label.trim() || `${findDef(c.type)?.name ?? c.type} ${c.id}`;

/** One bit column of a truth table. */
export interface Column {
  id: string;
  /** Pin carrying the bit, and which bit of it. */
  pin: string;
  bit: number;
  name: string;
}

export type Cell = 0 | 1 | 'x';

export interface TruthTable {
  inputs: Column[];
  outputs: Column[];
  /** Row r's inputs spell r in binary, first input column = most significant bit. */
  rows: { inputs: (0 | 1)[]; outputs: Cell[]; oscillates: boolean }[];
  /** Outputs can depend on stored state: the table describes the current state only. */
  hasMemory: boolean;
}

export type TableError = { error: 'no-inputs' | 'no-outputs' | 'too-many-inputs'; count?: number };

/** Width of a source/sink part's observed pin. */
function ioPins(c: Component, sim: Simulator): { pin: string; width: number }[] {
  const def = findDef(c.type);
  if (!def) return [];
  if (c.type === 'pin') return [{ pin: 'p', width: Number(c.props.bits ?? 1) }];
  if (c.type === 'dip') return [{ pin: 'out', width: Number(c.props.count ?? 4) }];
  if (c.type === 'slider') return [{ pin: 'out', width: Number(c.props.bits ?? 4) }];
  // A probe takes the width of whatever it is attached to.
  if (c.type === 'probe') return [{ pin: 'p', width: sim.netsOf(c.id, 'p')?.length ?? 1 }];
  if (c.type === 'switch' || c.type === 'button') return [{ pin: 'out', width: 1 }];
  if (c.type === 'led') return [{ pin: 'in', width: 1 }];
  const pins = def.pins(c.props);
  return pins.filter((p) => p.dir === 'in').map((p) => ({ pin: p.name, width: p.width || 1 }));
}

/** Expand a part into bit columns, most significant bit first (so the table reads like the number). */
function columns(c: Component, sim: Simulator): Column[] {
  const name = displayName(c);
  return ioPins(c, sim).flatMap(({ pin, width }, _i, all) =>
    Array.from({ length: width }, (_, k) => {
      const bit = width - 1 - k;
      const base = all.length > 1 ? `${name}.${pin}` : name;
      return { id: c.id, pin, bit, name: width > 1 ? `${base}${bit}` : base };
    }),
  );
}

export function tableIO(circuit: Circuit) {
  const comps = Object.values(circuit.components);
  return {
    inputs: comps.filter((c) => isSource(c)).sort(byLabel),
    outputs: comps.filter((c) => isSink(c)).sort(byLabel),
  };
}

/** Set one input part to a bit pattern taken from the row number. */
function applyInput(sim: Simulator, c: Component, cols: Column[], row: number, n: number, offset: number) {
  let value = 0;
  cols.forEach((col, k) => {
    if ((row >> (n - 1 - (offset + k))) & 1) value |= 1 << col.bit;
  });
  if (c.type === 'switch' || c.type === 'button') sim.setRuntime(c.id, 'on', value === 1);
  else if (c.type === 'dip' || c.type === 'slider') sim.setRuntime(c.id, 'value', value);
  else if (c.type === 'pin') sim.setRuntime(c.id, 'value', value.toString(2));
}

/**
 * Enumerate every combination of the input parts (switches, buttons, input
 * pins, DIP switches) and record every output bit (LEDs, output pins,
 * displays). Each row starts from a copy of `base`, so the live circuit is
 * never disturbed.
 */
export function truthTable(circuit: Circuit, base: Simulator): TruthTable | TableError {
  const io = tableIO(circuit);
  const inCols = io.inputs.map((c) => ({ c, cols: columns(c, base) }));
  const inputs = inCols.flatMap((x) => x.cols);
  const outputs = io.outputs.flatMap((c) => columns(c, base));
  if (inputs.length === 0) return { error: 'no-inputs' };
  if (outputs.length === 0) return { error: 'no-outputs' };
  if (inputs.length > MAX_TABLE_INPUTS) return { error: 'too-many-inputs', count: inputs.length };

  const n = inputs.length;
  const rows: TruthTable['rows'] = [];
  for (let r = 0; r < 1 << n; r++) {
    const sim = base.clone();
    let offset = 0;
    for (const { c, cols } of inCols) {
      applyInput(sim, c, cols, r, n, offset);
      offset += cols.length;
    }
    const res = sim.settle();
    rows.push({
      inputs: inputs.map((_, k) => ((r >> (n - 1 - k)) & 1) as 0 | 1),
      outputs: outputs.map((o): Cell => {
        if (!res.stable) return 'x';
        const s: BitState = bitAt(sim.input(o.id, o.pin), o.bit);
        return s === 0 || s === 1 ? s : 'x';
      }),
      oscillates: !res.stable,
    });
  }
  return { inputs, outputs, rows, hasMemory: hasMemory(circuit) };
}

/** A circuit has memory if it contains a stateful part or any feedback loop. */
export function hasMemory(circuit: Circuit): boolean {
  if (Object.values(circuit.components).some((c) => findDef(c.type)?.sequential)) return true;
  // Wires are undirected now: build a directed graph from driving pins to reading parts.
  const adj = new Map<string, Set<string>>();
  const dirOf = (id: string, pin: string) => {
    const c = circuit.components[id];
    const def = c && findDef(c.type);
    return def?.pins(c.props).find((p) => p.name === pin)?.dir;
  };
  for (const w of Object.values(circuit.wires)) {
    const a = dirOf(w.from.comp, w.from.pin);
    const b = dirOf(w.to.comp, w.to.pin);
    if (a !== 'in' && b !== 'out') adj.set(w.from.comp, new Set([...(adj.get(w.from.comp) ?? []), w.to.comp]));
    if (b !== 'in' && a !== 'out') adj.set(w.to.comp, new Set([...(adj.get(w.to.comp) ?? []), w.from.comp]));
  }
  const state = new Map<string, 1 | 2>();
  for (const start of Object.keys(circuit.components)) {
    if (state.has(start)) continue;
    const stack: [string, string[]][] = [[start, [...(adj.get(start) ?? [])]]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = top[1].pop();
      if (next === undefined) {
        state.set(top[0], 2);
        stack.pop();
      } else if (state.get(next) === 1) return true;
      else if (!state.has(next)) {
        state.set(next, 1);
        stack.push([next, [...(adj.get(next) ?? [])]]);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- minimisation

/** An implicant over n variables: '0', '1', '-' per variable, variable 0 first. */
export type Implicant = string;

/** An implicant as two masks: the fixed bit values and the don't-care ('-') positions. Variable 0 is the most significant bit. */
interface Cube {
  v: number;
  d: number;
}
const cubes = new Map<Implicant, Cube>();
function cubeOf(imp: Implicant): Cube {
  let c = cubes.get(imp);
  if (!c) {
    let v = 0;
    let d = 0;
    for (let i = 0; i < imp.length; i++) {
      v = v * 2 + (imp[i] === '1' ? 1 : 0);
      d = d * 2 + (imp[i] === '-' ? 1 : 0);
    }
    c = { v, d };
    if (cubes.size > 100_000) cubes.clear();
    cubes.set(imp, c);
  }
  return c;
}
function cubeText(v: number, d: number, n: number): Implicant {
  let s = '';
  for (let i = n - 1; i >= 0; i--) s += (d >> i) & 1 ? '-' : (v >> i) & 1 ? '1' : '0';
  return s;
}
export const covers = (imp: Implicant, m: number) => {
  const c = cubeOf(imp);
  return ((m ^ c.v) & ~c.d) === 0;
};
const literals = (imp: Implicant) => imp.replace(/-/g, '').length;

/** All prime implicants of the function (ones ∪ don't-cares). */
export function primeImplicants(n: number, ones: readonly number[], dontCares: readonly number[] = []): Implicant[] {
  // Two cubes merge when they have the same don't-care positions and differ in exactly one other bit,
  // so each cube only needs to look for its partner with that bit set: linear in the cubes per round.
  const key = (v: number, d: number) => d * 2 ** n + v;
  let current = new Map<number, Cube>();
  for (const m of [...ones, ...dontCares]) current.set(key(m, 0), { v: m, d: 0 });
  const primes = new Set<Implicant>();
  while (current.size) {
    const used = new Set<number>();
    const next = new Map<number, Cube>();
    for (const [k, { v, d }] of current) {
      for (let b = 0; b < n; b++) {
        const bit = 1 << b;
        if (d & bit || v & bit) continue;
        const partner = key(v | bit, d);
        if (!current.has(partner)) continue;
        next.set(key(v, d | bit), { v, d: d | bit });
        used.add(k);
        used.add(partner);
      }
    }
    for (const [k, { v, d }] of current) if (!used.has(k)) primes.add(cubeText(v, d, n));
    current = next;
  }
  return [...primes].sort();
}

/**
 * Quine–McCluskey minimisation to a minimum sum of products: essential prime
 * implicants first, then an exact minimum cover of what is left (fewest
 * terms, then fewest literals). Deterministic and always equivalent.
 */
export function minimize(n: number, minterms: readonly number[], dontCares: readonly number[] = []): Implicant[] {
  const ones = [...new Set(minterms)].sort((a, b) => a - b);
  if (ones.length === 0) return [];
  if (new Set([...ones, ...dontCares]).size === 1 << n) return ['-'.repeat(n)];
  const primes = primeImplicants(n, ones, dontCares);
  const chosen: Implicant[] = [];
  for (const m of ones) {
    const cov = primes.filter((p) => covers(p, m));
    if (cov.length === 1 && !chosen.includes(cov[0])) chosen.push(cov[0]);
  }
  const remaining = ones.filter((m) => !chosen.some((p) => covers(p, m)));
  // Above 8 inputs the exact search almost never finishes inside a 200k-node budget, and each node scans
  // hundreds of minterms, so it gets a smaller budget there before falling back to the greedy cover.
  const rest = exactCover(primes.filter((p) => !chosen.includes(p)), remaining, n <= 8 ? 200_000 : 20_000) ?? greedyCover(primes.filter((p) => !chosen.includes(p)), remaining);
  chosen.push(...rest);
  return chosen.sort((a, b) => literals(a) - literals(b) || (a < b ? 1 : -1));
}

/** Cost of a cover: fewer terms first, then fewer literals. */
const cost = (imps: readonly Implicant[]) => imps.length * 1000 + imps.reduce((n, p) => n + literals(p), 0);

/**
 * Exact minimum cover of `minterms` by `primes` (branch and bound, a form of
 * Petrick's method): always expand the minterm with the fewest covering
 * primes, and prune branches that cannot beat the best cover found. Returns
 * null if the search exceeds its budget (very large functions).
 */
function exactCover(primes: readonly Implicant[], minterms: readonly number[], budget = 200_000): Implicant[] | null {
  if (minterms.length === 0) return [];
  const coverOf = new Map(primes.map((p) => [p, minterms.filter((m) => covers(p, m))]));
  // Options are always tried in one fixed order (most minterms covered, then fewest literals, then text),
  // so each minterm's option list is sorted once here rather than at every search node.
  const lits = new Map(primes.map((p) => [p, literals(p)]));
  const order = [...primes].sort((a, b) => coverOf.get(b)!.length - coverOf.get(a)!.length || lits.get(a)! - lits.get(b)! || (a < b ? -1 : 1));
  const cubeV = order.map((p) => cubeOf(p).v);
  const cubeD = order.map((p) => cubeOf(p).d);
  const optionsOf: number[][] = [];
  for (const m of minterms) {
    const opts: number[] = [];
    for (let i = 0; i < order.length; i++) if (((m ^ cubeV[i]) & ~cubeD[i]) === 0) opts.push(i);
    optionsOf[m] = opts;
  }
  let best: Implicant[] | null = null;
  let bestCost = Infinity;
  let nodes = 0;
  const rec = (remaining: number[], chosen: Implicant[]): boolean => {
    if (++nodes > budget) return false;
    if (remaining.length === 0) {
      const c = cost(chosen);
      if (c < bestCost) {
        bestCost = c;
        best = [...chosen];
      }
      return true;
    }
    // At least one more term is needed.
    if ((chosen.length + 1) * 1000 > bestCost) return true;
    let options = optionsOf[remaining[0]];
    for (const m of remaining) {
      const o = optionsOf[m];
      if (o.length < options.length) options = o;
    }
    for (const i of options) {
      const v = cubeV[i];
      const nd = ~cubeD[i];
      const rest: number[] = [];
      for (const m of remaining) if (((m ^ v) & nd) !== 0) rest.push(m);
      chosen.push(order[i]);
      const ok = rec(rest, chosen);
      chosen.pop();
      if (!ok) return false;
    }
    return true;
  };
  return rec([...minterms], []) ? best : null;
}

/** Fallback for very large functions: most new minterms first, then fewest literals. */
function greedyCover(primes: readonly Implicant[], minterms: readonly number[]): Implicant[] {
  // Live count of the still-uncovered minterms each prime covers, updated as minterms are covered.
  const count = primes.map(() => 0);
  const optionsOf = new Map<number, number[]>();
  for (const m of minterms) {
    const opts: number[] = [];
    primes.forEach((p, i) => {
      if (covers(p, m)) {
        opts.push(i);
        count[i]++;
      }
    });
    optionsOf.set(m, opts);
  }
  const lits = primes.map(literals);
  const remaining = new Set(minterms);
  const taken = primes.map(() => false);
  const chosen: Implicant[] = [];
  while (remaining.size) {
    let best = -1;
    let bestCount = -1;
    for (let i = 0; i < primes.length; i++) {
      if (taken[i]) continue;
      if (count[i] > bestCount || (count[i] === bestCount && best !== -1 && lits[i] < lits[best])) {
        best = i;
        bestCount = count[i];
      }
    }
    taken[best] = true;
    chosen.push(primes[best]);
    for (const m of minterms) {
      if (!remaining.has(m) || !covers(primes[best], m)) continue;
      remaining.delete(m);
      for (const i of optionsOf.get(m)!) count[i]--;
    }
  }
  return chosen;
}

export const evaluateSop = (imps: readonly Implicant[], m: number): 0 | 1 => (imps.some((p) => covers(p, m)) ? 1 : 0);
/** A product-of-sums is stored as the implicants of the 0s: f = NOT(sum of them). */
export const evaluatePos = (zeroImps: readonly Implicant[], m: number): 0 | 1 => (zeroImps.some((p) => covers(p, m)) ? 0 : 1);

const joiner = (names: readonly string[]) => (names.every((x) => x.length === 1) ? '' : '·');

/** Sum of products, e.g. "AB′ + C". */
export function formatSop(imps: readonly Implicant[], names: readonly string[]): string {
  if (imps.length === 0) return '0';
  if (imps.length === 1 && !/[01]/.test(imps[0])) return '1';
  const j = joiner(names);
  return imps.map((p) => [...p].map((ch, i) => (ch === '-' ? null : ch === '1' ? names[i] : `${names[i]}′`)).filter(Boolean).join(j)).join(' + ');
}

/** Product of sums from the implicants of the zeros: each becomes a sum of complemented literals (De Morgan). */
export function formatPos(zeroImps: readonly Implicant[], names: readonly string[]): string {
  if (zeroImps.length === 0) return '1';
  if (zeroImps.length === 1 && !/[01]/.test(zeroImps[0])) return '0';
  const terms = zeroImps.map((p) => [...p].map((ch, i) => (ch === '-' ? null : ch === '0' ? names[i] : `${names[i]}′`)).filter(Boolean) as string[]);
  return terms.map((t) => (t.length === 1 ? t[0] : `(${t.join(' + ')})`)).join(joiner(names));
}

export interface OutputExpression {
  output: string;
  sop: string;
  pos: string;
  sopTerms: Implicant[];
  posTerms: Implicant[];
  minterms: number[];
  maxterms: number[];
  dontCares: number[];
}

/** Minimised SOP and POS for each output column. Unknown (x) rows are treated as don't-cares. */
export function expressions(t: TruthTable): OutputExpression[] {
  const names = t.inputs.map((i) => i.name);
  const n = names.length;
  return t.outputs.map((o, k) => {
    const minterms: number[] = [];
    const maxterms: number[] = [];
    const dontCares: number[] = [];
    t.rows.forEach((row, r) => {
      const v = row.outputs[k];
      if (v === 1) minterms.push(r);
      else if (v === 0) maxterms.push(r);
      else dontCares.push(r);
    });
    const sopTerms = minimize(n, minterms, dontCares);
    const posTerms = minimize(n, maxterms, dontCares);
    return { output: o.name, sop: formatSop(sopTerms, names), pos: formatPos(posTerms, names), sopTerms, posTerms, minterms, maxterms, dontCares };
  });
}

// ---------------------------------------------------------------- Karnaugh maps

/** Reflected Gray code of length 2^bits: 00, 01, 11, 10 … */
export const grayCode = (bits: number) => Array.from({ length: 1 << bits }, (_, i) => i ^ (i >> 1));

export interface KMap {
  /** Variables on rows then columns (row variables are the first ones). */
  rowVars: string[];
  colVars: string[];
  rowCodes: number[];
  colCodes: number[];
  /** cells[r][c] = minterm index and its value. */
  cells: { m: number; v: Cell }[][];
}

/** K-map layout for 2–4 variables (rows take the first ⌊n/2⌋ variables). */
export function kmap(n: number, values: readonly Cell[], names: readonly string[]): KMap | null {
  if (n < 2 || n > 4) return null;
  const rb = Math.floor(n / 2);
  const cb = n - rb;
  const rowCodes = grayCode(rb);
  const colCodes = grayCode(cb);
  return {
    rowVars: names.slice(0, rb) as string[],
    colVars: names.slice(rb) as string[],
    rowCodes,
    colCodes,
    cells: rowCodes.map((rc) => colCodes.map((cc) => ({ m: (rc << cb) | cc, v: values[(rc << cb) | cc] }))),
  };
}

/**
 * The K-map cells an implicant covers, as (row, col) positions. Groups wrap
 * around edges, so a group may appear as several rectangles on screen.
 */
export function groupCells(map: KMap, imp: Implicant): [number, number][] {
  const out: [number, number][] = [];
  map.cells.forEach((row, r) => row.forEach((cell, c) => covers(imp, cell.m) && out.push([r, c])));
  return out;
}
