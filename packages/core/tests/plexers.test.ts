import { describe, expect, it } from 'vitest';
import { type Bits, asInput, bits, fromStates, type BitState } from '../src/bits';
import { getDef, sanitizeProps } from '../src/library';
import { T, drive, str } from './helpers';

/** Evaluate a part directly: inputs are MSB-first strings ("01xz") or numbers; absent pins use their default. */
export function run(type: string, rawProps: Record<string, unknown>, inputs: Record<string, string | number>, widths: Record<string, number> = {}): Record<string, string> {
  const def = getDef(type);
  const props = sanitizeProps(type, rawProps);
  const pins = def.pins(props);
  const parse = (name: string, v: string | number): Bits => {
    if (typeof v === 'number') return bits(pins.find((p) => p.name === name)!.width, v);
    return fromStates([...v].reverse().map((c): BitState => (c === '0' ? 0 : c === '1' ? 1 : (c as BitState))));
  };
  const ctx = {
    props,
    state: def.init?.(props),
    tick: 0,
    connected: (n: string) => n in inputs,
    raw: (n: string) => parse(n, inputs[n]),
    get: (n: string) => {
      const pin = pins.find((p) => p.name === n)!;
      if (!(n in inputs)) return pin.floatAs !== undefined ? fromStates(Array(pin.width).fill(pin.floatAs)) : asInput(fromStates(Array(pin.width).fill('z')));
      return asInput(parse(n, inputs[n]));
    },
  };
  const out = def.eval(ctx).out;
  const res: Record<string, string> = {};
  for (const [k, b] of Object.entries(out)) {
    const pin = pins.find((p) => p.name === k);
    expect(pin, `output ${k} is a declared pin`).toBeTruthy();
    expect(b.w, `output ${k} width`).toBe(pin!.width);
    res[k] = str(b);
  }
  void widths;
  return res;
}
const bin = (n: number, w: number) => n.toString(2).padStart(w, '0');
const rnd = (w: number) => Math.floor(Math.random() * 2 ** w) >>> 0;

describe('mux', () => {
  it('selects the right input, exhaustive for 3 select bits x 3 data bits', () => {
    for (let s = 0; s < 8; s++)
      for (let k = 0; k < 20; k++) {
        const d = Array.from({ length: 8 }, () => rnd(3));
        const ins: Record<string, number> = { s };
        d.forEach((v, i) => (ins[`d${i}`] = v));
        expect(run('mux', { bits: 3, sel: 3 }, ins).y).toBe(bin(d[s], 3));
      }
  });
  it('works at 32 bits with 5 select bits', () => {
    for (let k = 0; k < 40; k++) {
      const s = rnd(5);
      const ins: Record<string, number> = { s };
      const d: number[] = [];
      for (let i = 0; i < 32; i++) ins[`d${i}`] = d[i] = rnd(32);
      expect(run('mux', { bits: 32, sel: 5 }, ins).y).toBe(bin(d[s], 32));
    }
  });
  it('unknown select keeps bits where all candidates agree', () => {
    // s = 1x -> candidates 2 and 3
    expect(run('mux', { bits: 4, sel: 2 }, { s: '1x', d0: 0, d1: 0, d2: '1010', d3: '1001' }).y).toBe('10xx');
    // fully unknown select over 4 inputs
    expect(run('mux', { bits: 2, sel: 2 }, { s: 'xx', d0: '11', d1: '10', d2: '11', d3: '01' }).y).toBe('xx');
    expect(run('mux', { bits: 2, sel: 2 }, { s: 'xx', d0: '11', d1: '11', d2: '11', d3: '11' }).y).toBe('11');
    // z select bit is also unknown; the unconnected select is fully unknown
    expect(run('mux', { bits: 1, sel: 1 }, { s: 'z', d0: 0, d1: 1 }).y).toBe('x');
    expect(run('mux', { bits: 1, sel: 1 }, { d0: 1, d1: 1 }).y).toBe('1');
  });
  it('an unknown data bit on the chosen input stays unknown', () => {
    expect(run('mux', { bits: 2, sel: 1 }, { s: 1, d0: '00', d1: 'x1' }).y).toBe('x1');
  });
  it('enable: 0 gives zero or float, unknown gives x, unconnected counts as 1', () => {
    const base = { bits: 4, sel: 1, enable: true };
    expect(run('mux', base, { s: 1, d0: 3, d1: 9, en: 0 }).y).toBe('0000');
    expect(run('mux', { ...base, disabled: 'float' }, { s: 1, d0: 3, d1: 9, en: 0 }).y).toBe('zzzz');
    expect(run('mux', base, { s: 1, d0: 3, d1: 9, en: 1 }).y).toBe('1001');
    expect(run('mux', base, { s: 1, d0: 3, d1: 9, en: 'x' }).y).toBe('xxxx');
    expect(run('mux', base, { s: 1, d0: 3, d1: 9 }).y).toBe('1001');
  });
  it('has an EN pin only when enabled, and 2^sel data pins', () => {
    const names = (p: Record<string, unknown>) => getDef('mux').pins(sanitizeProps('mux', p)).map((x) => x.name);
    expect(names({ sel: 2 })).toEqual(['d0', 'd1', 'd2', 'd3', 'y', 's']);
    expect(names({ sel: 1, enable: true })).toEqual(['d0', 'd1', 'y', 's', 'en']);
  });
  it('works wired into a circuit', () => {
    const t = new T();
    const m = t.add('mux', { bits: 4, sel: 1 });
    const a = t.add('const', { bits: 4, value: 'A' });
    const b = t.add('const', { bits: 4, value: '5' });
    const s = t.add('switch');
    t.wire(a, 'out', m, 'd0').wire(b, 'out', m, 'd1').wire(s, 'out', m, 's');
    const sim = t.sim();
    expect(str(sim.value(m, 'y'))).toBe('1010');
    drive(sim, { [s]: true }, t.c);
    expect(str(sim.value(m, 'y'))).toBe('0101');
  });
});

describe('demux', () => {
  it('routes data to the selected output, exhaustive for 2 select bits x 3 data bits', () => {
    for (let s = 0; s < 4; s++)
      for (let d = 0; d < 8; d++) {
        const r = run('demux', { bits: 3, sel: 2 }, { s, d });
        for (let i = 0; i < 4; i++) expect(r[`y${i}`]).toBe(i === s ? bin(d, 3) : '000');
      }
  });
  it('unselected outputs float on request, also while disabled', () => {
    const r = run('demux', { bits: 2, sel: 1, unselected: 'float' }, { s: 1, d: 3 });
    expect(r).toEqual({ y0: 'zz', y1: '11' });
    const off = run('demux', { bits: 2, sel: 1, enable: true, unselected: 'float' }, { s: 1, d: 3, en: 0 });
    expect(off).toEqual({ y0: 'zz', y1: 'zz' });
    expect(run('demux', { bits: 2, sel: 1, enable: true }, { s: 1, d: 3, en: 0 })).toEqual({ y0: '00', y1: '00' });
    expect(run('demux', { bits: 2, sel: 1, enable: true }, { s: 1, d: 3, en: 'x' })).toEqual({ y0: 'xx', y1: 'xx' });
    expect(run('demux', { bits: 2, sel: 1, enable: true }, { s: 1, d: 3 })).toEqual({ y0: '00', y1: '11' });
  });
  it('unknown select: candidate outputs are the data where it differs from idle', () => {
    expect(run('demux', { bits: 2, sel: 2 }, { s: '1x', d: '10' })).toEqual({ y0: '00', y1: '00', y2: 'x0', y3: 'x0' });
    expect(run('demux', { bits: 1, sel: 1, unselected: 'float' }, { s: 'x', d: 1 })).toEqual({ y0: 'x', y1: 'x' });
  });
});

describe('decoder', () => {
  it('is one-hot, exhaustive for 1..4 select bits', () => {
    for (let n = 1; n <= 4; n++)
      for (let s = 0; s < 1 << n; s++) {
        const r = run('decoder', { sel: n }, { s });
        expect(Object.keys(r).length).toBe(1 << n);
        for (let i = 0; i < 1 << n; i++) expect(r[`y${i}`]).toBe(i === s ? '1' : '0');
      }
  });
  it('5 select bits gives 32 outputs', () => {
    expect(Object.keys(run('decoder', { sel: 5 }, { s: 21 })).length).toBe(32);
    expect(run('decoder', { sel: 5 }, { s: 21 }).y21).toBe('1');
  });
  it('float mode and enable', () => {
    expect(run('decoder', { sel: 1, unselected: 'float' }, { s: 0 })).toEqual({ y0: '1', y1: 'z' });
    expect(run('decoder', { sel: 1, enable: true }, { s: 0, en: 0 })).toEqual({ y0: '0', y1: '0' });
    expect(run('decoder', { sel: 1, enable: true, unselected: 'float' }, { s: 0, en: 0 })).toEqual({ y0: 'z', y1: 'z' });
    expect(run('decoder', { sel: 1, enable: true }, { s: 0, en: 'x' })).toEqual({ y0: 'x', y1: 'x' });
    expect(run('decoder', { sel: 1, enable: true }, { s: 0 })).toEqual({ y0: '1', y1: '0' });
  });
  it('unknown select: x on possible outputs, idle elsewhere', () => {
    expect(run('decoder', { sel: 2 }, { s: 'x1' })).toEqual({ y0: '0', y1: 'x', y2: '0', y3: 'x' });
    expect(run('decoder', { sel: 2, unselected: 'float' }, { s: '1x' })).toEqual({ y0: 'z', y1: 'z', y2: 'x', y3: 'x' });
    expect(run('decoder', { sel: 1 }, { s: 'x' })).toEqual({ y0: 'x', y1: 'x' });
  });
});

describe('priority encoder', () => {
  const ins = (n: number, active: number[]) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`i${i}`, active.includes(i) ? 1 : 0]));
  it('highest input wins, exhaustive for 3 select bits (8 inputs)', () => {
    for (let m = 0; m < 256; m++) {
      const active = Array.from({ length: 8 }, (_, i) => i).filter((i) => (m >> i) & 1);
      const r = run('encoder', { sel: 3 }, ins(8, active));
      const top = active.length ? Math.max(...active) : -1;
      expect(r.y).toBe(bin(Math.max(top, 0), 3));
      expect(r.v).toBe(top >= 0 ? '1' : '0');
      expect(r.eo).toBe(top >= 0 ? '0' : '1');
    }
  });
  it('no active input floats y when asked', () => {
    expect(run('encoder', { sel: 2, disabled: 'float' }, ins(4, []))).toEqual({ y: 'zz', v: '0', eo: '1' });
    expect(run('encoder', { sel: 2, disabled: 'float' }, ins(4, [2]))).toEqual({ y: '10', v: '1', eo: '0' });
  });
  it('enable: off gives idle y, V=0, EO=0; unknown gives x; unconnected is enabled', () => {
    const p = { sel: 2, enable: true };
    expect(run('encoder', p, { ...ins(4, [3]), en: 0 })).toEqual({ y: '00', v: '0', eo: '0' });
    expect(run('encoder', { ...p, disabled: 'float' }, { ...ins(4, [3]), en: 0 })).toEqual({ y: 'zz', v: '0', eo: '0' });
    expect(run('encoder', p, { ...ins(4, [3]), en: 'x' })).toEqual({ y: 'xx', v: 'x', eo: 'x' });
    expect(run('encoder', p, ins(4, [3]))).toEqual({ y: '11', v: '1', eo: '0' });
    expect(run('encoder', p, { ...ins(4, []), en: 1 })).toEqual({ y: '00', v: '0', eo: '1' });
  });
  it('unknown inputs above the highest known 1 produce x only where it matters', () => {
    // i3 unknown, i1 = 1: result is 3 or 1 -> y = x1, V = 1, EO = 0
    expect(run('encoder', { sel: 2 }, { i3: 'x', i2: 0, i1: 1, i0: 0 })).toEqual({ y: 'x1', v: '1', eo: '0' });
    // unknown below the known 1 is irrelevant
    expect(run('encoder', { sel: 2 }, { i3: 0, i2: 1, i1: 'x', i0: 'x' })).toEqual({ y: '10', v: '1', eo: '0' });
    // nothing known active and one unknown: could be that input or idle
    expect(run('encoder', { sel: 2 }, { i3: 0, i2: 0, i1: 'x', i0: 0 })).toEqual({ y: '0x', v: 'x', eo: 'x' });
    // unknown at the top with a known 1 at 2: 3 vs 2 -> low bit x, high bit 1
    expect(run('encoder', { sel: 2 }, { i3: 'z', i2: 1, i1: 0, i0: 0 }).y).toBe('1x');
    // with float idle, "maybe nothing" is x on every bit
    expect(run('encoder', { sel: 1, disabled: 'float' }, { i1: 'x', i0: 0 }).y).toBe('x');
  });
});

describe('bit selector', () => {
  it('picks groups: 8 bits into 2-bit groups', () => {
    const d = 0b11_10_01_00;
    for (let k = 0; k < 4; k++) expect(run('bitselect', { bits: 8, outBits: 2 }, { d, s: k }).y).toBe(bin(k, 2));
  });
  it('single-bit selection, exhaustive at 4 bits', () => {
    for (let d = 0; d < 16; d++) for (let s = 0; s < 4; s++) expect(run('bitselect', { bits: 4, outBits: 1 }, { d, s }).y).toBe(String((d >> s) & 1));
  });
  it('bits past the top read 0 and select past the last group gives 0', () => {
    // 6 bits in 4-bit groups: group 1 = bits 4..7, only 4,5 exist
    expect(run('bitselect', { bits: 6, outBits: 4 }, { d: 0b111111, s: 1 }).y).toBe('0011');
    // 3 groups of 2 -> select width 2; select 3 is past the end
    expect(run('bitselect', { bits: 6, outBits: 2 }, { d: 0b111111, s: 3 }).y).toBe('00');
    expect(run('bitselect', { bits: 6, outBits: 2 }, { d: 0b111111, s: 2 }).y).toBe('11');
  });
  it('select width follows the group count', () => {
    const pins = (p: Record<string, unknown>) => getDef('bitselect').pins(sanitizeProps('bitselect', p));
    expect(pins({ bits: 8, outBits: 1 }).find((x) => x.name === 's')!.width).toBe(3);
    expect(pins({ bits: 8, outBits: 8 }).find((x) => x.name === 's')!.width).toBe(1);
    expect(pins({ bits: 32, outBits: 1 }).find((x) => x.name === 's')!.width).toBe(5);
  });
  it('unknown select merges the candidate groups; unknown data bits propagate', () => {
    // groups: 00 01 10 11; select 'x0' -> groups 0 and 2 -> 00 vs 10 -> x0
    expect(run('bitselect', { bits: 8, outBits: 2 }, { d: 0b11_10_01_00, s: 'x0' }).y).toBe('x0');
    expect(run('bitselect', { bits: 4, outBits: 1 }, { d: '1x01', s: 1 }).y).toBe('0');
    expect(run('bitselect', { bits: 4, outBits: 1 }, { d: '1x01', s: 2 }).y).toBe('x');
  });
  it('random 32-bit data', () => {
    for (let k = 0; k < 100; k++) {
      const d = rnd(32);
      const ob = 1 + Math.floor(Math.random() * 8);
      const s = rnd(5);
      const groups = Math.ceil(32 / ob);
      const sw = Math.max(1, Math.ceil(Math.log2(groups)));
      const sv = s & ((1 << sw) - 1);
      const expected = sv < groups ? Number((BigInt(d) >> BigInt(sv * ob)) & ((1n << BigInt(ob)) - 1n)) : 0;
      expect(run('bitselect', { bits: 32, outBits: ob }, { d, s: sv }).y).toBe(bin(expected, ob));
    }
  });
});
