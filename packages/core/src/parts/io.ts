import { bits, fromStates, type BitState } from '../bits';
import { int, layoutFrom, range, type ComponentDef, type PinDef, type PropDef } from '../library';

/** Interactive inputs and visual outputs. Outputs have no logic: the canvas reads their input pins. */

const ACTIVE: PropDef = {
  key: 'active',
  label: 'Lights when input is',
  kind: 'enum',
  default: 'high',
  options: [
    { value: 'high', label: '1 (active high)' },
    { value: 'low', label: '0 (active low)' },
  ],
};

const COLORS = ['amber', 'red', 'green', 'blue', 'white'].map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }));

const switchPart: ComponentDef = {
  type: 'switch',
  name: 'Switch',
  category: 'Inputs',
  description: 'A toggle input. Click it to flip between 0 and 1.',
  keywords: ['toggle', 'input', 'lever'],
  shape: 'switch',
  source: true,
  props: [{ key: 'on', label: 'On', kind: 'bool', default: false, runtime: true }],
  size: () => ({ w: 40, h: 20 }),
  pins: () => [{ name: 'out', dir: 'out', x: 40, y: 10, side: 'r', width: 1 }],
  eval: ({ props }) => ({ out: { out: bits(1, props.on ? 1 : 0) } }),
};

const button: ComponentDef = {
  type: 'button',
  name: 'Push button',
  category: 'Inputs',
  description: 'A momentary input: 1 only while held down.',
  keywords: ['momentary', 'press', 'key'],
  shape: 'button',
  source: true,
  props: [{ key: 'on', label: 'Pressed', kind: 'bool', default: false, runtime: true }],
  size: () => ({ w: 40, h: 20 }),
  pins: () => [{ name: 'out', dir: 'out', x: 40, y: 10, side: 'r', width: 1 }],
  eval: ({ props }) => ({ out: { out: bits(1, props.on ? 1 : 0) } }),
};

const dip: ComponentDef = {
  type: 'dip',
  name: 'DIP switch',
  category: 'Inputs',
  description: 'A bank of toggle switches. Outputs them together as one bus; switch 1 is bit 0.',
  keywords: ['dip', 'switch bank', 'bus input', 'multi-bit'],
  shape: 'dip',
  source: true,
  props: [
    { key: 'count', label: 'Switches', kind: 'int', default: 4, min: 1, max: 16 },
    { key: 'value', label: 'Value', kind: 'int', default: 0, min: 0, max: 65535, runtime: true },
  ],
  ...layoutFrom((p) => {
    const n = int(p, 'count', 4);
    return { w: n * 12 + 20, h: 30, pins: [{ name: 'out', dir: 'out', x: n * 12 + 20, y: 10, side: 'r', width: n } as PinDef] };
  }),
  eval: ({ props }) => ({ out: { out: bits(int(props, 'count', 4), int(props, 'value', 0)) } }),
};

const led: ComponentDef = {
  type: 'led',
  name: 'LED',
  category: 'Outputs',
  description: 'Lights up when its input is 1 (or 0 when set to active low). Dark when unknown.',
  keywords: ['lamp', 'light', 'indicator', 'diode'],
  shape: 'led',
  sink: true,
  props: [{ key: 'color', label: 'Colour', kind: 'enum', default: 'amber', options: COLORS }, ACTIVE],
  size: () => ({ w: 40, h: 20 }),
  pins: () => [{ name: 'in', dir: 'in', x: 0, y: 10, side: 'l', width: 1 }],
  eval: () => ({ out: {} }),
};

const rgb: ComponentDef = {
  type: 'rgbled',
  name: 'RGB LED',
  category: 'Outputs',
  description: 'Mixes red, green and blue: each input turns one colour on. All three make white.',
  keywords: ['colour', 'color', 'mix'],
  shape: 'rgbled',
  sink: true,
  props: [ACTIVE],
  size: () => ({ w: 40, h: 60 }),
  pins: () => [
    { name: 'r', label: 'R', dir: 'in', x: 0, y: 10, side: 'l', width: 1 },
    { name: 'g', label: 'G', dir: 'in', x: 0, y: 30, side: 'l', width: 1 },
    { name: 'b', label: 'B', dir: 'in', x: 0, y: 50, side: 'l', width: 1 },
  ],
  eval: () => ({ out: {} }),
};

const hex: ComponentDef = {
  type: 'hex',
  name: 'Hex display',
  category: 'Outputs',
  description: 'Shows a 4-bit value as one hex digit, 0–F. Blank when any bit is unknown.',
  keywords: ['seven segment', 'digit', 'number display', 'hexadecimal'],
  shape: 'hex',
  sink: true,
  props: [
    {
      key: 'input',
      label: 'Inputs',
      kind: 'enum',
      default: 'separate',
      options: [
        { value: 'separate', label: 'Four single bits' },
        { value: 'bus', label: 'One 4-bit bus' },
      ],
    },
    { key: 'dp', label: 'Decimal point input', kind: 'bool', default: false },
  ],
  ...layoutFrom((p) => ({
    w: 70,
    h: 100,
    pins: [
      ...(p.input === 'bus'
        ? [{ name: 'd', label: '4', dir: 'in', x: 0, y: 30, side: 'l', width: 4 } as PinDef]
        : range(4).map((i): PinDef => ({ name: `d${i}`, label: String(1 << i), dir: 'in', x: 0, y: 30 + 20 * i, side: 'l', width: 1 }))),
      ...(p.dp ? [{ name: 'dp', label: '.', dir: 'in', x: 30, y: 100, side: 'b', width: 1 } as PinDef] : []),
    ],
  })),
  eval: () => ({ out: {} }),
};

/** Segment order a, b, c, d, e, f, g, dp — bit 0 is segment a. */
export const SEGMENT_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];

const sevenSeg: ComponentDef = {
  type: 'sevenseg',
  name: '7-segment display',
  category: 'Outputs',
  description: 'Seven bar-shaped LEDs (a–g) plus a decimal point, each driven separately or from one 8-bit bus (bit 0 = a).',
  keywords: ['seven segment', 'segments', 'digit'],
  shape: 'sevenseg',
  sink: true,
  props: [
    {
      key: 'input',
      label: 'Inputs',
      kind: 'enum',
      default: 'separate',
      options: [
        { value: 'separate', label: 'One per segment' },
        { value: 'bus', label: 'One 8-bit bus' },
      ],
    },
    ACTIVE,
  ],
  ...layoutFrom((p) =>
    p.input === 'bus'
      ? { w: 70, h: 100, pins: [{ name: 'seg', label: 'a–dp', dir: 'in', x: 0, y: 50, side: 'l', width: 8 }] }
      : { w: 70, h: 170, pins: SEGMENT_NAMES.map((s, i): PinDef => ({ name: s, label: s, dir: 'in', x: 0, y: 10 + 20 * i, side: 'l', width: 1 })) },
  ),
  eval: () => ({ out: {} }),
};

const ledbar: ComponentDef = {
  type: 'ledbar',
  name: 'LED bar',
  category: 'Outputs',
  description: 'A row of LEDs driven by one bus: segment 1 shows bit 0.',
  keywords: ['bar graph', 'level meter', 'leds'],
  shape: 'ledbar',
  sink: true,
  props: [{ key: 'count', label: 'Segments', kind: 'int', default: 8, min: 1, max: 32 }, { key: 'color', label: 'Colour', kind: 'enum', default: 'green', options: COLORS }],
  ...layoutFrom((p) => {
    const n = int(p, 'count', 8);
    return { w: n * 10 + 20, h: 30, pins: [{ name: 'in', dir: 'in', x: 0, y: 10, side: 'l', width: n } as PinDef] };
  }),
  eval: () => ({ out: {} }),
};

const text: ComponentDef = {
  type: 'text',
  name: 'Text note',
  category: 'Notes',
  description: 'A caption on the canvas. It has no effect on the circuit.',
  keywords: ['label', 'comment', 'annotation'],
  shape: 'text',
  props: [{ key: 'text', label: 'Text', kind: 'text', default: 'Note' }],
  size: (p) => ({ w: Math.max(20, Math.ceil((String(p.text ?? '').length * 6.6) / 10) * 10), h: 20 }),
  pins: () => [],
  eval: () => ({ out: {} }),
};

export const INPUTS: ComponentDef[] = [switchPart, button, dip];
export const OUTPUTS: ComponentDef[] = [led, rgb, hex, sevenSeg, ledbar];
export const NOTES: ComponentDef[] = [text];

/** Is the LED (active-high/low aware) lit for this input value? */
export function lit(v: BitState, active: unknown): boolean {
  return active === 'low' ? v === 0 : v === 1;
}

export { fromStates, range };
