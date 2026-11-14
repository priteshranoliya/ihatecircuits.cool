import type { TracePort } from '@ihatecircuits/hdl/trace';

export interface HeaderPort extends TracePort {
  /** The range text as written, e.g. "[7:0]", or '' for a scalar. */
  range: string;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function evalInt(text: string): number {
  const m = /^\s*(\d+)\s*(?:([-+])\s*(\d+))?\s*$/.exec(text);
  if (!m) throw new Error(`unsupported range bound "${text.trim()}"`);
  const a = Number(m[1]);
  return m[2] === '-' ? a - Number(m[3]) : m[2] === '+' ? a + Number(m[3]) : a;
}

function rangeWidth(range: string): number {
  const m = /^\[([^:\]]+):([^\]]+)\]$/.exec(range);
  if (!m) throw new Error(`unsupported range "${range}"`);
  return Math.abs(evalInt(m[1]!) - evalInt(m[2]!)) + 1;
}

const PORT_ITEM = /^(?:(input|output|inout)\b)?\s*(?:(?:wire|reg|logic|tri)\b)?\s*(?:signed\b)?\s*(\[[^\]]*\])?\s*([A-Za-z_][\w$]*)$/;

/**
 * Regex-level parse of the ANSI port list of `module <top>`. Handles direction and
 * range carry-over (`input [3:0] a, b`) and an initial value on an output reg (`output reg [3:0] q = 4'd5`, a literal without commas).
 * Non-ANSI headers and parameters are not supported.
 */
export function parseTopPorts(source: string, top: string): HeaderPort[] {
  const text = stripComments(source);
  const start = new RegExp(`\\bmodule\\s+${top.replace(/[$]/g, '\\$')}\\b\\s*\\(`).exec(text);
  if (!start) throw new Error(`module "${top}" with an ANSI port list not found`);
  let depth = 1;
  let i = start.index + start[0].length;
  const from = i;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
  }
  if (depth !== 0) throw new Error(`unterminated port list of module "${top}"`);
  const body = text.slice(from, i - 1).trim();
  if (body === '') return [];

  const ports: HeaderPort[] = [];
  let dir: 'in' | 'out' | undefined;
  let range = '';
  for (const raw of body.split(',')) {
    const item = raw.replace(/=[\s\S]*$/, '').trim().replace(/\s+/g, ' ');
    const m = PORT_ITEM.exec(item);
    if (!m) throw new Error(`cannot parse port "${item}" of module "${top}"`);
    if (m[1]) {
      if (m[1] === 'inout') throw new Error(`inout port "${m[3]}" is not supported`);
      dir = m[1] === 'input' ? 'in' : 'out';
      range = m[2] ?? '';
    } else if (m[2]) {
      range = m[2];
    } else if (dir === undefined) {
      throw new Error(`non-ANSI port "${m[3]}": only ANSI headers are supported`);
    }
    ports.push({ name: m[3]!, dir: dir!, range, width: range ? rangeWidth(range) : 1 });
  }
  return ports;
}
