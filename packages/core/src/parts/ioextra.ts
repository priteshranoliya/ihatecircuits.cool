import { type Bits, bitAt, bits, toUnsigned } from '../bits';
import { DELAY, TRIGGER_EDGE, chip, int, layoutFrom, range, type ComponentDef, type EvalCtx, type PinDef, type PinSpec } from '../library';
import type { Props } from '../types';
import { fires, level, w, type Trigger } from './util';

/**
 * Extra inputs and outputs: keyboard, terminal, LED matrix and slider.
 *
 * The keyboard and terminal change state only when their clock definitely
 * fires with the enable definitely 1. An unknown clock, enable or data value
 * is treated as "nothing happened", because one unknown cannot be stored in a
 * text buffer.
 */

type Lv = 0 | 1 | 'x';
const lv = (ctx: EvalCtx, pin: string): Lv => level(ctx.get(pin));
const CLK: PinSpec = ['clk', '', 1, { clock: true }];
const CLR: PinSpec = ['clr', 'CLR', 1, { floatAs: 0 }];

/** `clk` is the level to remember: it stays null until the clock has been seen known, so power-on settling cannot fake an edge. */
function definitelyFires(ctx: EvalCtx, prev: Lv | null): { clk: Lv | null; fired: boolean } {
  const now = lv(ctx, 'clk');
  const clk = prev === null && now === 'x' ? null : now;
  return { clk, fired: clk !== null && fires(ctx.props.trigger as Trigger, prev ?? now, now) === true };
}

// ---------------------------------------------------------------- keyboard

export interface KeyboardState {
  buffer: string;
  clk: Lv | null;
}

/** Add a typed character (ASCII 1..127) to the end of the buffer. Ignored if the buffer is full or the character is not ASCII. */
export function keyboardType(state: KeyboardState, ch: string, length = 128): KeyboardState {
  const code = ch.length ? ch.charCodeAt(0) : 0;
  if (code < 1 || code > 127 || state.buffer.length >= Math.max(1, length)) return state;
  return { ...state, buffer: state.buffer + String.fromCharCode(code) };
}

const keyboard: ComponentDef = {
  type: 'keyboard',
  name: 'Keyboard',
  category: 'Inputs',
  description:
    'A typing buffer. Characters typed on it queue up as 7-bit ASCII. DATA shows the oldest one (0 when empty) and AVAIL is 1 while any are waiting. A clock edge with RE=1 removes the oldest. CLR empties the buffer.',
  keywords: ['typing', 'ascii', 'input', 'fifo', 'keys'],
  shape: 'keyboard',
  sequential: true,
  props: [{ key: 'length', label: 'Buffer size', kind: 'int', default: 32, min: 1, max: 256 }, TRIGGER_EDGE, DELAY],
  title: () => 'KBD',
  ...layoutFrom(() => chip([CLK, ['re', 'RE', 1, { floatAs: 1 }], CLR], [['data', 'DATA', 7], ['avail', 'AV']], 70)),
  init: (): KeyboardState => ({ buffer: '', clk: null }),
  eval: (ctx) => {
    const st = ctx.state as KeyboardState;
    const { clk, fired } = definitelyFires(ctx, st.clk);
    let buffer = st.buffer;
    if (fired && lv(ctx, 're') === 1) buffer = buffer.slice(1);
    if (lv(ctx, 'clr') === 1) buffer = '';
    return {
      out: { data: bits(7, buffer.length ? buffer.charCodeAt(0) & 127 : 0), avail: bits(1, buffer.length ? 1 : 0) },
      state: { buffer, clk } satisfies KeyboardState,
    };
  },
};

// ---------------------------------------------------------------- terminal

export interface TtyState {
  /** Rows from oldest to newest; the last one is where the next character goes. Never empty. */
  lines: readonly string[];
  clk: Lv | null;
}

/**
 * Apply one character code to the screen lines.
 * Printable (32..126) appends, wrapping to a new line at `cols`. 10 starts a new line.
 * 8 deletes the last character of the current line (it does not join the previous line).
 * 12 clears the screen. Other codes are ignored. The oldest line scrolls off beyond `rows`.
 */
export function ttyWrite(lines: readonly string[], code: number, rows: number, cols: number): string[] {
  let out = lines.length ? [...lines] : [''];
  const newline = () => {
    out.push('');
    if (out.length > rows) out = out.slice(out.length - rows);
  };
  if (code >= 32 && code <= 126) {
    if (out[out.length - 1].length >= cols) newline();
    out[out.length - 1] += String.fromCharCode(code);
  } else if (code === 10) newline();
  else if (code === 8) out[out.length - 1] = out[out.length - 1].slice(0, -1);
  else if (code === 12) out = [''];
  return out;
}

const tty: ComponentDef = {
  type: 'tty',
  name: 'Terminal',
  category: 'Outputs',
  description:
    'A text screen. On a clock edge with WE=1 it writes the ASCII character on DATA: printable characters are added, 10 starts a new line, 8 backspaces within the line, 12 clears the screen. Long lines wrap and old lines scroll away.',
  keywords: ['console', 'text', 'ascii', 'display', 'screen', 'serial'],
  shape: 'tty',
  sequential: true,
  props: [
    { key: 'rows', label: 'Rows', kind: 'int', default: 8, min: 1, max: 32 },
    { key: 'cols', label: 'Columns', kind: 'int', default: 24, min: 1, max: 64 },
    TRIGGER_EDGE,
  ],
  title: () => 'TTY',
  ...layoutFrom(() => chip([['data', 'DATA', 7], CLK, ['we', 'WE', 1, { floatAs: 1 }], CLR], [], 70)),
  init: (): TtyState => ({ lines: [''], clk: null }),
  eval: (ctx) => {
    const st = ctx.state as TtyState;
    const { clk, fired } = definitelyFires(ctx, st.clk);
    let lines = st.lines;
    const code = toUnsigned(ctx.get('data'));
    if (fired && lv(ctx, 'we') === 1 && code !== null) lines = ttyWrite(lines, code, int(ctx.props, 'rows', 8), int(ctx.props, 'cols', 24));
    if (lv(ctx, 'clr') === 1) lines = [''];
    return { out: {}, state: { lines, clk } satisfies TtyState };
  },
};

// ---------------------------------------------------------------- LED matrix

/** Pixel cell size in the part's local frame. Input pins sit at cell centres. */
export const MATRIX_CELL = 20;

const matrixInputs = (p: Props) => ({
  rows: int(p, 'rows', 5),
  cols: int(p, 'cols', 5),
  mode: p.input === 'rows' || p.input === 'select' ? (p.input as string) : 'columns',
});

/**
 * Lit pixels as pixels[row][col], row 0 at the top and col 0 at the left.
 *
 * Bit conventions, the same in every mode: for a vertical bus bit 0 is the
 * bottom row, for a horizontal bus bit 0 is the rightmost column.
 * - columns: pin `c<j>` (j from 0 at the left) holds `rows` bits for column j.
 * - rows: pin `r<i>` (i from 0 at the top) holds `cols` bits for row i.
 * - select: pin `r` (rows bits) and pin `c` (cols bits). A pixel lights when its row bit and column bit are both 1.
 * A bit that is unknown, floating or in conflict lights nothing.
 */
export function matrixPixels(props: Props, readPin: (name: string) => Bits): boolean[][] {
  const { rows, cols, mode } = matrixInputs(props);
  const on = (b: Bits, i: number) => bitAt(b, i) === 1;
  if (mode === 'rows') return range(rows).map((r) => range(cols).map((c) => on(readPin(`r${r}`), cols - 1 - c)));
  if (mode === 'select') {
    const rb = readPin('r');
    const cb = readPin('c');
    return range(rows).map((r) => range(cols).map((c) => on(rb, rows - 1 - r) && on(cb, cols - 1 - c)));
  }
  return range(rows).map((r) => range(cols).map((c) => on(readPin(`c${c}`), rows - 1 - r)));
}

const ledmatrix: ComponentDef = {
  type: 'ledmatrix',
  name: 'LED matrix',
  category: 'Outputs',
  description:
    'A grid of LEDs. Drive it one column at a time, one row at a time, or with a row-select and column-select pair that light the crossing pixel. Unknown bits stay dark.',
  keywords: ['dot matrix', 'pixel', 'display', 'grid', '8x8'],
  shape: 'ledmatrix',
  sink: true,
  props: [
    { key: 'rows', label: 'Rows', kind: 'int', default: 5, min: 1, max: 16 },
    { key: 'cols', label: 'Columns', kind: 'int', default: 5, min: 1, max: 16 },
    {
      key: 'input',
      label: 'Inputs',
      kind: 'enum',
      default: 'columns',
      options: [
        { value: 'columns', label: 'One bus per column' },
        { value: 'rows', label: 'One bus per row' },
        { value: 'select', label: 'Row select and column select' },
      ],
      hint: 'Vertical buses count from the bottom (bit 0). Horizontal buses count from the right (bit 0).',
    },
  ],
  ...layoutFrom((p) => {
    const { rows, cols, mode } = matrixInputs(p);
    const W = cols * MATRIX_CELL;
    const H = rows * MATRIX_CELL;
    const pins: PinDef[] =
      mode === 'rows'
        ? range(rows).map((r): PinDef => ({ name: `r${r}`, label: `R${r}`, dir: 'in', x: 0, y: r * MATRIX_CELL + 10, side: 'l', width: cols }))
        : mode === 'select'
          ? [
              { name: 'r', label: 'R', dir: 'in', x: 0, y: Math.floor(H / 20) * 10, side: 'l', width: rows },
              { name: 'c', label: 'C', dir: 'in', x: Math.floor(W / 20) * 10, y: H, side: 'b', width: cols },
            ]
          : range(cols).map((c): PinDef => ({ name: `c${c}`, label: `C${c}`, dir: 'in', x: c * MATRIX_CELL + 10, y: H, side: 'b', width: rows }));
    return { w: W, h: H, pins };
  }),
  eval: () => ({ out: {} }),
};

// ---------------------------------------------------------------- slider

const slider: ComponentDef = {
  type: 'slider',
  name: 'Slider',
  category: 'Inputs',
  description: 'A draggable control that outputs a whole number from 0 up to the largest value the bit width allows.',
  keywords: ['dial', 'knob', 'analog', 'number input', 'range'],
  shape: 'slider',
  source: true,
  props: [
    { key: 'bits', label: 'Bits', kind: 'int', default: 4, min: 1, max: 8 },
    { key: 'value', label: 'Value', kind: 'int', default: 0, min: 0, max: 255, runtime: true },
  ],
  size: () => ({ w: 100, h: 20 }),
  pins: (p) => [{ name: 'out', dir: 'out', x: 100, y: 10, side: 'r', width: w(p) }],
  eval: ({ props }) => ({ out: { out: bits(w(props), int(props, 'value', 0)) } }),
};

export const IO_EXTRA: ComponentDef[] = [keyboard, tty, ledmatrix, slider];
