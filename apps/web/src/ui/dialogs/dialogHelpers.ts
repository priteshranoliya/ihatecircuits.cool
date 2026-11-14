import { parse, sortVariables, variables, type AST } from '@ihatecircuits/core/expr';
import { covers, type Cell, type Implicant, type KMap, type TruthTable } from '@ihatecircuits/core/analysis';
import type { Circuit, Component } from '@ihatecircuits/core/types';

/** Pure helpers behind the analysis, tests and memory dialogs. */

// ---------------------------------------------------------------- K-map groups

export interface GroupRect {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  /** The group continues past this edge of the map (it wraps around). */
  openTop: boolean;
  openBottom: boolean;
  openLeft: boolean;
  openRight: boolean;
}

const runs = (sorted: number[]): [number, number][] => {
  const out: [number, number][] = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last && last[1] === v - 1) last[1] = v;
    else out.push([v, v]);
  }
  return out;
};

/**
 * Rectangles that draw one implicant on a K-map. The covered cells form a
 * product of a row set and a column set. A set that wraps (rows 3 and 0 on a
 * 4-row map) splits into one run per side, and the pieces facing the edge are
 * marked open so they can be drawn without a closing border.
 */
export function groupRects(map: KMap, imp: Implicant): GroupRect[] {
  const rows = new Set<number>();
  const cols = new Set<number>();
  map.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (covers(imp, cell.m)) {
        rows.add(r);
        cols.add(c);
      }
    }),
  );
  const lastR = map.cells.length - 1;
  const lastC = map.cells[0].length - 1;
  const rr = runs([...rows].sort((a, b) => a - b));
  const cr = runs([...cols].sort((a, b) => a - b));
  const wrapR = rr.length > 1;
  const wrapC = cr.length > 1;
  const out: GroupRect[] = [];
  for (const [r0, r1] of rr)
    for (const [c0, c1] of cr)
      out.push({
        r0,
        r1,
        c0,
        c1,
        openTop: wrapR && r0 === 0 && rr[rr.length - 1][1] === lastR,
        openBottom: wrapR && r1 === lastR && rr[0][0] === 0,
        openLeft: wrapC && c0 === 0 && cr[cr.length - 1][1] === lastC,
        openRight: wrapC && c1 === lastC && cr[0][0] === 0,
      });
  return out;
}

// ---------------------------------------------------------------- truth table text

export const cellText = (v: Cell) => String(v);

export function truthTableText(t: TruthTable): string {
  const head = [...t.inputs, ...t.outputs].map((c) => c.name).join('\t');
  const body = t.rows.map((r) => [...r.inputs, ...r.outputs].join('\t'));
  return [head, ...body].join('\n');
}

// ---------------------------------------------------------------- build from expressions

export interface BuildLine {
  name: string;
  ast: AST;
  line: number;
}
export interface BuildProblem {
  line: number;
  /** One-based column in the line, when known. */
  column?: number;
  message: string;
}
export interface BuildParse {
  outputs: BuildLine[];
  inputs: string[];
  problems: BuildProblem[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse lines of `Name = expression`. Blank lines and lines starting with # are skipped. */
export function parseBuildLines(text: string): BuildParse {
  const outputs: BuildLine[] = [];
  const problems: BuildProblem[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === '' || raw.trim().startsWith('#')) return;
    const eq = raw.indexOf('=');
    if (eq < 0) {
      problems.push({ line, message: 'Write each line as Name = expression, for example F = A·B + A′C.' });
      return;
    }
    const name = raw.slice(0, eq).trim();
    if (!IDENT.test(name)) {
      problems.push({ line, column: 1, message: name ? `“${name}” is not a usable output name. Use letters, digits and underscores, starting with a letter.` : 'Write a name before the = sign.' });
      return;
    }
    if (outputs.some((o) => o.name === name)) {
      problems.push({ line, column: 1, message: `The name ${name} is already used on an earlier line.` });
      return;
    }
    const exprText = raw.slice(eq + 1);
    const res = parse(exprText);
    if ('error' in res) {
      problems.push({ line, column: eq + 1 + res.error.index + 1, message: res.error.message });
      return;
    }
    outputs.push({ name, ast: res.ast, line });
  });
  const inputs = sortVariables([...new Set(outputs.flatMap((o) => variables(o.ast)))]);
  return { outputs, inputs, problems };
}

// ---------------------------------------------------------------- test vector template

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

interface VecPort {
  comp: Component;
  dir: 'in' | 'out';
  width: number | null;
}

function vecPort(c: Component): VecPort | null {
  switch (c.type) {
    case 'switch':
    case 'button':
      return { comp: c, dir: 'in', width: 1 };
    case 'dip':
      return { comp: c, dir: 'in', width: Number(c.props.count ?? 4) };
    case 'pin':
      return { comp: c, dir: c.props.io === 'out' ? 'out' : 'in', width: Number(c.props.bits ?? 1) };
    case 'led':
      return { comp: c, dir: 'out', width: 1 };
    case 'probe':
      return { comp: c, dir: 'out', width: null };
    default:
      return null;
  }
}

/** A header and two example rows for the labelled inputs and outputs of a circuit (top to bottom, then left to right). */
export function testTemplate(circuit: Circuit): string {
  const ports = Object.values(circuit.components)
    .flatMap((c) => {
      const p = vecPort(c);
      return p && c.label.trim() ? [p] : [];
    })
    .sort((a, b) => a.comp.y - b.comp.y || a.comp.x - b.comp.x || natural.compare(a.comp.label, b.comp.label));
  const ins = ports.filter((p) => p.dir === 'in');
  const outs = ports.filter((p) => p.dir === 'out');
  const head = '# Edit the rows below, then choose Run tests. Use x where an output does not matter.';
  if (ins.length + outs.length === 0) {
    return `${head}\n# Label your switches, LEDs and pins first. Each label becomes a column name here.\nA  B  Out\n0  0  x\n1  1  x\n`;
  }
  const name = (p: VecPort) => p.comp.label.trim() + (p.width && p.width > 1 ? `[${p.width}]` : '');
  const cols = [...ins, ...outs];
  const row = (bit: '0' | '1') => cols.map((p) => (p.dir === 'out' ? 'x' : bit.repeat(p.width ?? 1))).join('  ');
  return `${head}\n${cols.map(name).join('  ')}\n${row('0')}\n${row('1')}\n`;
}

export const testsStorageKey = (circuitId: string) => `ihatecircuits:tests:${circuitId}`;

// ---------------------------------------------------------------- memory

export const hexDigits = (bits: number) => Math.max(1, Math.ceil(bits / 4));
export const formatHex = (value: number, bits: number) => value.toString(16).toUpperCase().padStart(hexDigits(bits), '0');

/** Parse one hex word, cut to `bits`. Null when the text is empty or not hex. */
export function parseHexWord(text: string, bits: number): number | null {
  const t = text.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(t)) return null;
  return parseInt(t, 16) % 2 ** bits;
}

export interface ParsedWords {
  words: number[];
  /** First token that is not a hex word. */
  bad?: { token: string; index: number };
  /** Words beyond the memory size that were left out. */
  dropped: number;
}

/** Whitespace-separated hex words, address 0 first. Words beyond `size` are dropped and counted. */
export function parseHexWords(text: string, bits: number, size: number): ParsedWords {
  const tokens = text.split(/\s+/).filter(Boolean);
  const words: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const v = parseHexWord(tokens[i], bits);
    if (v === null) return { words: [], bad: { token: tokens[i], index: i }, dropped: 0 };
    if (i < size) words.push(v);
  }
  return { words, dropped: Math.max(0, tokens.length - size) };
}

/** Hex words as text, trailing zero words left out. `perLine` 0 puts everything on one line. */
export function wordsToText(words: readonly number[], bits: number, perLine: number): string {
  let end = words.length;
  while (end > 0 && words[end - 1] === 0) end--;
  const hex = words.slice(0, end).map((w) => formatHex(w, bits));
  if (perLine <= 0) return hex.join(' ');
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += perLine) lines.push(hex.slice(i, i + perLine).join(' '));
  return lines.join('\n');
}

/** Which rows of a tall list to draw for a scroll position. */
export function visibleRows(scrollTop: number, viewport: number, rowHeight: number, total: number, overscan = 4): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { start, end };
}

/** Scroll position that brings a row fully into view, or null when it already is. */
export function scrollToReveal(row: number, scrollTop: number, viewport: number, rowHeight: number): number | null {
  const top = row * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return top + rowHeight - viewport;
  return null;
}

// ---------------------------------------------------------------- files

export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFilename = (s: string) => s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ihatecircuits';
