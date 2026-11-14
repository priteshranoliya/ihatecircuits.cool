import { bitAt, toStates, type Bits } from './bits';
import type { Simulator } from './sim';
import type { Circuit, Component } from './types';

/**
 * Test vectors: a plain-text table that drives a circuit and checks its outputs.
 *
 * FORMAT
 *   # a comment line (a "#" after whitespace starts a comment to end of line)
 *   A  B  Cin  Sum[4]  Cout      <- header: first non-comment line
 *   0  0  0    0000    0         <- one row per line, whitespace separated
 *   1  1  1    0x1     1
 *
 * Header. One name per column, matching the label of a part in the circuit.
 * A name may carry a width, `Sum[4]`; without one the part's own width is used.
 * Inputs are matched to switches, push buttons, DIP switches and input pins;
 * outputs to LEDs, output pins and probes.
 *
 * Values (a column's width w comes from the header or from the part):
 *   binary    0101        w digits of 0/1. Outputs may also use x (don't care)
 *                         or z (floating) per digit, e.g. 01xx.
 *   hex       0x1F        must fit in w bits.
 *   decimal   13  or -3   negatives are two's complement in w bits.
 *   x         any width: don't care. Outputs only. Driving an unknown input is
 *                         not supported and is reported as an error.
 *   z         any width: expected to be floating. Outputs only.
 * A token made only of 0s and 1s is binary when it has exactly w digits and
 * decimal otherwise (so `10` is 2 in a 2-bit column and ten in a 4-bit one).
 *
 * Sequential testing. A column named `#clock` (the only place a "#" is not a
 * comment) takes the values:
 *   0   do not advance time; just apply the inputs and check
 *   1   advance clocks one step (half a period with the default clock)
 *   ^   advance clocks one full period (two steps), then check
 * Without a `#clock` column every row is combinational: the simulator is reset
 * before each row. With one, the simulator is reset once before the first row
 * and state carries from row to row. Inputs are applied and settled before any
 * stepping, and outputs are read after.
 *
 * Everything runs on a clone; the simulator you pass in is never touched.
 */

export interface VectorColumn {
  name: string;
  /** Width from the header, if given. */
  width?: number;
}

export type VectorCell =
  | { kind: 'x' }
  | { kind: 'z' }
  /** A token of 0/1/x/z digits. If it is only 0/1, `alt` is its decimal reading, used when the digit count is not the width. */
  | { kind: 'digits'; text: string; alt?: number }
  | { kind: 'num'; value: number; text: string };

export type ClockCell = '0' | '1' | '^';

export interface VectorRow {
  /** One-based line number in the source text. */
  line: number;
  /** One value per header column. */
  cells: VectorCell[];
  clock?: ClockCell;
}

export interface ParsedVectors {
  header: VectorColumn[];
  /** The header had a `#clock` column. */
  sequential: boolean;
  rows: VectorRow[];
}

export interface VectorParseError {
  error: string;
  /** One-based line number. */
  line: number;
}

const MAX_WIDTH = 32;

function stripComment(line: string): string {
  return line.replace(/(^|\s)#(?!clock(\s|$)).*$/, '$1').trim();
}

function parseCell(tok: string, col: VectorColumn): VectorCell | string {
  if (/^[xX]$/.test(tok)) return { kind: 'x' };
  if (/^[zZ]$/.test(tok)) return { kind: 'z' };
  if (/^0[xX]/.test(tok)) {
    if (!/^0[xX][0-9a-fA-F]+$/.test(tok)) return `"${tok}" is not a hex value (use digits 0-9 and A-F after 0x)`;
    return { kind: 'num', value: parseInt(tok.slice(2), 16), text: tok };
  }
  if (/^-\d+$/.test(tok)) return { kind: 'num', value: Number(tok), text: tok };
  if (/^[01xXzZ]+$/.test(tok)) {
    const text = tok.toLowerCase();
    return /^[01]+$/.test(text) ? { kind: 'digits', text, alt: Number(text) } : { kind: 'digits', text };
  }
  if (/^\d+$/.test(tok)) return { kind: 'num', value: Number(tok), text: tok };
  return `"${tok}" is not a value for ${col.name}: use binary like 0101, hex like 0x1F, decimal like 13 or -3, or x / z`;
}

/** Turn a cell into per-bit characters, most significant first. */
function resolve(cell: VectorCell, width: number, name: string): string | { error: string } {
  switch (cell.kind) {
    case 'x':
      return 'x'.repeat(width);
    case 'z':
      return 'z'.repeat(width);
    case 'digits':
      if (cell.text.length === width) return cell.text;
      if (cell.alt === undefined) return { error: `${name}: "${cell.text}" has ${cell.text.length} digits but the column is ${width} bits wide` };
      return fromNumber(cell.alt, width, name, cell.text);
    case 'num':
      return fromNumber(cell.value, width, name, cell.text);
  }
}

function fromNumber(value: number, width: number, name: string, text: string): string | { error: string } {
  const span = 2 ** width;
  if (!Number.isSafeInteger(value)) return { error: `${name}: ${text} is too large` };
  if (value >= span || value < -span / 2) {
    const lo = value < 0 ? -span / 2 : 0;
    return { error: `${name}: ${text} does not fit in ${width} bit${width === 1 ? '' : 's'} (the range is ${lo} to ${value < 0 ? span / 2 - 1 : span - 1})` };
  }
  return (value < 0 ? value + span : value).toString(2).padStart(width, '0');
}

export function parseVectors(text: string): ParsedVectors | VectorParseError {
  try {
    return parseBody(text);
  } catch (e) {
    if (e instanceof VecFail) return { error: e.error, line: e.line };
    throw e;
  }
}

function parseBody(text: string): ParsedVectors | VectorParseError {
  const lines = text.split(/\r\n|\r|\n/);
  let header: VectorColumn[] | null = null;
  let clockCol = -1;
  let columnCount = 0;
  const rows: VectorRow[] = [];

  for (let li = 0; li < lines.length; li++) {
    const line = li + 1;
    const body = stripComment(lines[li]);
    if (body === '') continue;
    const toks = body.split(/\s+/);

    if (!header) {
      const cols: VectorColumn[] = [];
      const seen = new Set<string>();
      toks.forEach((tok, i) => {
        if (tok === '#clock') {
          if (clockCol >= 0) throw new VecFail('The header has #clock twice', line);
          clockCol = i;
          return;
        }
        const m = /^([^[\]\s]+)(?:\[(\d+)\])?$/.exec(tok);
        if (!m) throw new VecFail(`"${tok}" is not a valid column name. Write a label, optionally with a width like Sum[4]`, line);
        const width = m[2] === undefined ? undefined : Number(m[2]);
        if (width !== undefined && (width < 1 || width > MAX_WIDTH)) throw new VecFail(`Width of ${m[1]} must be between 1 and ${MAX_WIDTH}, not ${width}`, line);
        if (seen.has(m[1])) throw new VecFail(`Column "${m[1]}" appears twice in the header`, line);
        seen.add(m[1]);
        cols.push({ name: m[1], width });
      });
      if (cols.length === 0) throw new VecFail('The header has no signal names', line);
      header = cols;
      columnCount = toks.length;
      continue;
    }

    if (toks.length !== columnCount) throw new VecFail(`This row has ${toks.length} value${toks.length === 1 ? '' : 's'} but the header has ${columnCount} column${columnCount === 1 ? '' : 's'}`, line);
    const cells: VectorCell[] = [];
    let clock: ClockCell | undefined;
    let sig = 0;
    for (let i = 0; i < toks.length; i++) {
      if (i === clockCol) {
        if (toks[i] !== '0' && toks[i] !== '1' && toks[i] !== '^') throw new VecFail(`#clock must be 0, 1 or ^, not "${toks[i]}"`, line);
        clock = toks[i] as ClockCell;
        continue;
      }
      const col = header[sig++];
      const cell = parseCell(toks[i], col);
      if (typeof cell === 'string') throw new VecFail(cell, line);
      if (col.width !== undefined) {
        const r = resolve(cell, col.width, col.name);
        if (typeof r !== 'string') throw new VecFail(r.error, line);
      }
      cells.push(cell);
    }
    rows.push({ line, cells, clock });
  }
  if (!header) return { error: 'No header line found. The first line should list the signal names', line: 1 };
  return { header, sequential: clockCol >= 0, rows };
}

class VecFail extends Error {
  constructor(
    public error: string,
    public line: number,
  ) {
    super(error);
  }
}

// ---------------------------------------------------------------- running

export interface Mismatch {
  signal: string;
  /** Expected bits, most significant first, with x for don't-care. */
  expected: string;
  /** Actual bits, most significant first (x unknown, z floating, e conflict). */
  got: string;
}

export interface RowResult {
  /** Index into `parsed.rows`. */
  row: number;
  /** Source line of the row. */
  line: number;
  ok: boolean;
  mismatches: Mismatch[];
}

export interface VectorRun {
  passed: number;
  failed: number;
  results: RowResult[];
}

export interface VectorRunError {
  error: string;
  line?: number;
}

interface Port {
  comp: Component;
  col: VectorColumn;
  dir: 'in' | 'out';
  width: number | null;
  pin: string;
}

const bitString = (b: Bits) =>
  toStates(b)
    .reverse()
    .map(String)
    .join('');

function findPorts(circuit: Circuit, header: readonly VectorColumn[]): Port[] | VectorRunError {
  const comps = Object.values(circuit.components);
  const classify = (c: Component): Omit<Port, 'col'> | null => {
    switch (c.type) {
      case 'switch':
      case 'button':
        return { comp: c, dir: 'in', width: 1, pin: 'out' };
      case 'dip':
        return { comp: c, dir: 'in', width: Number(c.props.count ?? 4), pin: 'out' };
      case 'pin':
        return c.props.io === 'out' ? { comp: c, dir: 'out', width: Number(c.props.bits ?? 1), pin: 'p' } : { comp: c, dir: 'in', width: Number(c.props.bits ?? 1), pin: 'p' };
      case 'led':
        return { comp: c, dir: 'out', width: 1, pin: 'in' };
      case 'probe':
        return { comp: c, dir: 'out', width: null, pin: 'p' };
      default:
        return null;
    }
  };
  const ports: Port[] = [];
  const unknown: string[] = [];
  for (const col of header) {
    const hits = comps.filter((c) => c.label.trim() === col.name).flatMap((c) => {
      const k = classify(c);
      return k ? [{ ...k, col }] : [];
    });
    if (hits.length === 0) unknown.push(col.name);
    else if (hits.length > 1) return { error: `More than one input or output part is labelled "${col.name}". Give each a different label` };
    else ports.push(hits[0]);
  }
  if (unknown.length) {
    return { error: `No input or output part is labelled ${unknown.map((n) => `"${n}"`).join(', ')}. Label switches, buttons, pins, LEDs and probes to match the header names` };
  }
  for (const p of ports) {
    if (p.col.width !== undefined && p.width !== null && p.col.width !== p.width) {
      return { error: `${p.col.name} is ${p.col.width} bits wide in the header but the part is ${p.width} bits wide` };
    }
  }
  return ports;
}

/**
 * Run parsed vectors against a circuit. Rows run on a clone of `sim`.
 * Returns an error (not a thrown exception) for unknown header names, a width
 * clash, or an x/z given to an input.
 */
export function runVectors(circuit: Circuit, sim: Simulator, parsed: ParsedVectors): VectorRun | VectorRunError {
  const ports = findPorts(circuit, parsed.header);
  if ('error' in ports) return ports;

  // Resolve every cell up front so errors surface before anything runs.
  const resolved: string[][] = [];
  for (const row of parsed.rows) {
    const r: string[] = [];
    for (let i = 0; i < ports.length; i++) {
      const p = ports[i];
      const width = p.width ?? p.col.width ?? sim.input(p.comp.id, p.pin).w;
      const bitsOut = resolve(row.cells[i], width, p.col.name);
      if (typeof bitsOut !== 'string') return { error: bitsOut.error, line: row.line };
      if (p.dir === 'in' && /[xz]/.test(bitsOut)) {
        return { error: `${p.col.name} is an input, so it must be 0 or 1. Driving x or z into an input is not supported`, line: row.line };
      }
      r.push(bitsOut);
    }
    resolved.push(r);
  }

  const work = sim.clone();
  if (parsed.sequential) work.reset();
  const results: RowResult[] = [];

  parsed.rows.forEach((row, ri) => {
    if (!parsed.sequential) work.reset();
    ports.forEach((p, i) => {
      if (p.dir !== 'in') return;
      const v = resolved[ri][i];
      if (p.comp.type === 'switch' || p.comp.type === 'button') work.setRuntime(p.comp.id, 'on', v === '1');
      else if (p.comp.type === 'dip') work.setRuntime(p.comp.id, 'value', parseInt(v, 2));
      else work.setRuntime(p.comp.id, 'value', v);
    });
    let stable = work.settle().stable;
    const steps = row.clock === '^' ? 2 : row.clock === '1' ? 1 : 0;
    for (let s = 0; s < steps && stable; s++) stable = work.step().stable;

    const mismatches: Mismatch[] = [];
    if (!stable) mismatches.push({ signal: '(circuit)', expected: 'stable', got: 'oscillating' });
    ports.forEach((p, i) => {
      if (p.dir !== 'out') return;
      const expected = resolved[ri][i];
      const got = work.input(p.comp.id, p.pin);
      const w = expected.length;
      let ok = got.w === w;
      for (let k = 0; ok && k < w; k++) {
        const want = expected[k];
        if (want === 'x') continue;
        const s = bitAt(got, w - 1 - k);
        if (want === 'z' ? s !== 'z' : s !== Number(want)) ok = false;
      }
      if (!ok) mismatches.push({ signal: p.col.name, expected, got: bitString(got) });
    });
    results.push({ row: ri, line: row.line, ok: mismatches.length === 0, mismatches });
  });

  const failed = results.filter((r) => !r.ok).length;
  return { passed: results.length - failed, failed, results };
}
