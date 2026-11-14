import { describe, expect, it } from 'vitest';
import { type Bits, asInput, bits, fromStates, type BitState } from '../src/bits';
import { getDef, sanitizeProps } from '../src/library';
import { T, drive, str } from './helpers';

/** Evaluate a part directly: inputs are MSB-first strings ("01xz") or numbers; absent pins use their default. */
function run(type: string, rawProps: Record<string, unknown>, inputs: Record<string, string | number>, widths: Record<string, number> = {}): Record<string, string> {
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
const big = (n: bigint, w: number) => BigInt.asUintN(w, n).toString(2).padStart(w, '0');
const rndBig = (w: number) => BigInt(rnd(w));
const sgn = (n: number, w: number) => (n >= 2 ** (w - 1) ? n - 2 ** w : n);

describe('adder', () => {
  it('exhaustive at 4 bits, with and without carry in', () => {
    for (let a = 0; a < 16; a++)
      for (let b = 0; b < 16; b++)
        for (const c of [0, 1]) {
          const r = run('adder', { bits: 4 }, { a, b, cin: c });
          expect(r.s).toBe(bin((a + b + c) & 15, 4));
          expect(r.cout).toBe(a + b + c > 15 ? '1' : '0');
        }
  });
  it('carry in floats to 0 when unconnected', () => {
    expect(run('adder', { bits: 4 }, { a: 15, b: 0 })).toEqual({ s: '1111', cout: '0' });
  });
  it('random 8/16/32 bit', () => {
    for (const w of [8, 16, 32])
      for (let k = 0; k < 200; k++) {
        const a = rnd(w), b = rnd(w), c = rnd(1);
        const t = BigInt(a) + BigInt(b) + BigInt(c);
        const r = run('adder', { bits: w }, { a, b, cin: c });
        expect(r.s).toBe(big(t, w));
        expect(r.cout).toBe(t >> BigInt(w) ? '1' : '0');
      }
  });
  it('partial evaluation: exact below the first unknown bit, x from there up', () => {
    // a = 0 1 x 1 (bit 1 unknown): bit 0 exact, bits 1..3 x, cout x
    expect(run('adder', { bits: 4 }, { a: '01x1', b: '0011', cin: 0 })).toEqual({ s: 'xxx0', cout: 'x' });
    // unknown in b at bit 2
    expect(run('adder', { bits: 4 }, { a: '0111', b: '0x11', cin: 0 })).toEqual({ s: 'xx10', cout: 'x' });
    // lowest unknown wins even when higher bits are unknown too
    expect(run('adder', { bits: 6 }, { a: 'x1x000', b: '000001', cin: 1 })).toEqual({ s: 'xxx010', cout: 'x' });
    // unknown at the top bit only: three exact bits
    expect(run('adder', { bits: 4 }, { a: 'x001', b: '0001', cin: 0 })).toEqual({ s: 'x010', cout: 'x' });
    // unknown carry in spoils everything
    expect(run('adder', { bits: 3 }, { a: 1, b: 1, cin: 'x' })).toEqual({ s: 'xxx', cout: 'x' });
    // z inputs are unknown too; an unconnected operand is fully unknown
    expect(run('adder', { bits: 2 }, { a: 'z1', b: 0, cin: 0 })).toEqual({ s: 'x1', cout: 'x' });
    expect(run('adder', { bits: 2 }, { b: 0, cin: 0 })).toEqual({ s: 'xx', cout: 'x' });
  });
});

describe('subtractor', () => {
  it('exhaustive at 4 bits with borrow in', () => {
    for (let a = 0; a < 16; a++)
      for (let b = 0; b < 16; b++)
        for (const c of [0, 1]) {
          const r = run('subtractor', { bits: 4 }, { a, b, bin: c });
          expect(r.d).toBe(bin(((a - b - c) % 16 + 16) % 16, 4));
          expect(r.bout).toBe(a - b - c < 0 ? '1' : '0');
        }
  });
  it('random 8/16/32 bit', () => {
    for (const w of [8, 16, 32])
      for (let k = 0; k < 200; k++) {
        const a = rnd(w), b = rnd(w), c = rnd(1);
        const t = BigInt(a) - BigInt(b) - BigInt(c);
        const r = run('subtractor', { bits: w }, { a, b, bin: c });
        expect(r.d).toBe(big(t, w));
        expect(r.bout).toBe(t < 0n ? '1' : '0');
      }
  });
  it('partial evaluation', () => {
    expect(run('subtractor', { bits: 4 }, { a: '10x1', b: '0001', bin: 0 })).toEqual({ d: 'xxx0', bout: 'x' });
    expect(run('subtractor', { bits: 4 }, { a: '0101', b: '1x00', bin: 0 })).toEqual({ d: 'xx01', bout: 'x' });
    expect(run('subtractor', { bits: 3 }, { a: 1, b: 1, bin: 'x' })).toEqual({ d: 'xxx', bout: 'x' });
  });
});

describe('multiplier', () => {
  it('exhaustive at 3 bits with carry in, split into low/high halves', () => {
    for (let a = 0; a < 8; a++)
      for (let b = 0; b < 8; b++)
        for (let c = 0; c < 8; c++) {
          const t = a * b + c;
          expect(run('multiplier', { bits: 3 }, { a, b, cin: c })).toEqual({ p: bin(t & 7, 3), hi: bin(t >> 3, 3) });
        }
  });
  it('random 8/16/32 bit against BigInt, including the 32x32 full product', () => {
    for (const w of [8, 16, 32])
      for (let k = 0; k < 200; k++) {
        const a = rndBig(w), b = rndBig(w), c = rndBig(w);
        const t = a * b + c;
        const r = run('multiplier', { bits: w }, { a: Number(a), b: Number(b), cin: Number(c) });
        expect(r.p).toBe(big(t, w));
        expect(r.hi).toBe(big(t >> BigInt(w), w));
      }
    expect(run('multiplier', { bits: 32 }, { a: 0xffffffff, b: 0xffffffff })).toEqual({ p: bin(1, 32), hi: bin(0xfffffffe, 32) });
  });
  it('carry in defaults to 0; any unknown makes everything x', () => {
    expect(run('multiplier', { bits: 4 }, { a: 3, b: 5 })).toEqual({ p: '1111', hi: '0000' });
    expect(run('multiplier', { bits: 4 }, { a: '00x0', b: 0 })).toEqual({ p: 'xxxx', hi: 'xxxx' });
    expect(run('multiplier', { bits: 4 }, { a: 1, b: 1, cin: 'xxxx' })).toEqual({ p: 'xxxx', hi: 'xxxx' });
    expect(run('multiplier', { bits: 4 }, { a: 1 })).toEqual({ p: 'xxxx', hi: 'xxxx' });
  });
});

describe('divider', () => {
  it('exhaustive at 4 bits with no upper half', () => {
    for (let a = 0; a < 16; a++)
      for (let b = 1; b < 16; b++) expect(run('divider', { bits: 4 }, { a, b })).toEqual({ q: bin(Math.floor(a / b), 4), r: bin(a % b, 4) });
  });
  it('uses the upper half of the dividend; quotient keeps only its low bits', () => {
    // dividend 0x1_2 = 18, / 4 = 4 r 2 (4 bits)
    expect(run('divider', { bits: 4 }, { a: 2, hi: 1, b: 4 })).toEqual({ q: '0100', r: '0010' });
    // dividend 0xF_F = 255 / 1 = 255 -> low 4 bits 1111
    expect(run('divider', { bits: 4 }, { a: 15, hi: 15, b: 1 })).toEqual({ q: '1111', r: '0000' });
    // dividend 0xF_0 = 240 / 3 = 80 = 0x50 -> low nibble 0, r 0
    expect(run('divider', { bits: 4 }, { a: 0, hi: 15, b: 3 })).toEqual({ q: '0000', r: '0000' });
  });
  it('random 8/16/32 bit including 64-bit dividends', () => {
    for (const w of [8, 16, 32])
      for (let k = 0; k < 200; k++) {
        const a = rndBig(w), hi = rndBig(w);
        let b = rndBig(w);
        if (b === 0n) b = 1n;
        const n = (hi << BigInt(w)) | a;
        const r = run('divider', { bits: w }, { a: Number(a), hi: Number(hi), b: Number(b) });
        expect(r.q).toBe(big(n / b, w));
        expect(r.r).toBe(big(n % b, w));
      }
  });
  it('divide by zero: quotient all ones, remainder is the low dividend', () => {
    expect(run('divider', { bits: 4 }, { a: 9, b: 0 })).toEqual({ q: '1111', r: '1001' });
    expect(run('divider', { bits: 4 }, { a: 9, hi: 5, b: 0 })).toEqual({ q: '1111', r: '1001' });
    expect(run('divider', { bits: 32 }, { a: 7, b: 0 })).toEqual({ q: '1'.repeat(32), r: bin(7, 32) });
  });
  it('any unknown gives x, even with a zero divisor', () => {
    expect(run('divider', { bits: 4 }, { a: '1x00', b: 3 })).toEqual({ q: 'xxxx', r: 'xxxx' });
    expect(run('divider', { bits: 4 }, { a: 4, b: 'x000' })).toEqual({ q: 'xxxx', r: 'xxxx' });
    expect(run('divider', { bits: 4 }, { a: 4, hi: 'x', b: 2 })).toEqual({ q: 'xxxx', r: 'xxxx' });
    expect(run('divider', { bits: 4 }, { a: 4 })).toEqual({ q: 'xxxx', r: 'xxxx' });
  });
});

describe('negator', () => {
  it('exhaustive at 4 bits; the most negative value maps to itself', () => {
    for (let a = 0; a < 16; a++) expect(run('negator', { bits: 4 }, { a }).y).toBe(bin((16 - a) & 15, 4));
    expect(run('negator', { bits: 4 }, { a: 0b1000 }).y).toBe('1000');
    expect(run('negator', { bits: 4 }, { a: 0 }).y).toBe('0000');
  });
  it('random 8/16/32 bit', () => {
    for (const w of [8, 16, 32])
      for (let k = 0; k < 200; k++) {
        const a = rndBig(w);
        expect(run('negator', { bits: w }, { a: Number(a) }).y).toBe(big(-a, w));
      }
    expect(run('negator', { bits: 32 }, { a: 0x80000000 }).y).toBe('1' + '0'.repeat(31));
  });
  it('unknown bits spoil only the bits that depend on them', () => {
    // -(01x0) is 1010 or 1100: only the middle bits differ
    expect(run('negator', { bits: 4 }, { a: '01x0' }).y).toBe('1xx0');
    // a known 1 at bit 0 fixes every higher bit's flip, so unknowns above stay x only in themselves
    expect(run('negator', { bits: 4 }, { a: '1x01' }).y).toBe('0x11');
    expect(run('negator', { bits: 2 }, {}).y).toBe('xx');
  });
});

describe('comparator', () => {
  it('exhaustive unsigned and signed at 4 bits', () => {
    for (let a = 0; a < 16; a++)
      for (let b = 0; b < 16; b++) {
        const u = run('comparator', { bits: 4 }, { a, b });
        expect(u).toEqual({ gt: a > b ? '1' : '0', eq: a === b ? '1' : '0', lt: a < b ? '1' : '0' });
        const s = run('comparator', { bits: 4, numeric: 'signed' }, { a, b });
        const sa = sgn(a, 4), sb = sgn(b, 4);
        expect(s).toEqual({ gt: sa > sb ? '1' : '0', eq: sa === sb ? '1' : '0', lt: sa < sb ? '1' : '0' });
      }
  });
  it('signed comparison of negative numbers', () => {
    // -1 (0xFF) < 1, but 255 > 1 unsigned
    expect(run('comparator', { bits: 8, numeric: 'signed' }, { a: 0xff, b: 1 })).toEqual({ gt: '0', eq: '0', lt: '1' });
    expect(run('comparator', { bits: 8 }, { a: 0xff, b: 1 })).toEqual({ gt: '1', eq: '0', lt: '0' });
    // -2 < -1
    expect(run('comparator', { bits: 8, numeric: 'signed' }, { a: 0xfe, b: 0xff })).toEqual({ gt: '0', eq: '0', lt: '1' });
    expect(run('comparator', { bits: 32, numeric: 'signed' }, { a: 0x80000000, b: 0x7fffffff }).lt).toBe('1');
  });
  it('random 8/16/32 bit', () => {
    for (const w of [8, 16, 32])
      for (const signed of [false, true])
        for (let k = 0; k < 200; k++) {
          const a = rnd(w), b = k % 5 === 0 ? a : rnd(w);
          const [x, y] = signed ? [sgn(a, w), sgn(b, w)] : [a, b];
          expect(run('comparator', { bits: w, numeric: signed ? 'signed' : 'unsigned' }, { a, b })).toEqual({ gt: x > y ? '1' : '0', eq: x === y ? '1' : '0', lt: x < y ? '1' : '0' });
        }
  });
  it('unknown bit reached before a difference gives x on all outputs', () => {
    const X = { gt: 'x', eq: 'x', lt: 'x' };
    expect(run('comparator', { bits: 4 }, { a: '10x0', b: '1000' })).toEqual(X);
    expect(run('comparator', { bits: 4 }, { a: '1100', b: '1x00' })).toEqual(X);
    // a difference above the unknown bit decides first
    expect(run('comparator', { bits: 4 }, { a: '1x00', b: '0000' })).toEqual({ gt: '1', eq: '0', lt: '0' });
    expect(run('comparator', { bits: 4 }, { a: '0000', b: '01xx' })).toEqual({ gt: '0', eq: '0', lt: '1' });
    expect(run('comparator', { bits: 4, numeric: 'signed' }, { a: '1xxx', b: '0000' })).toEqual({ gt: '0', eq: '0', lt: '1' });
    expect(run('comparator', { bits: 4 }, { a: 3 })).toEqual(X);
  });
});

describe('shifter', () => {
  const refShift = (mode: string, a: number, d: number, w: number): bigint => {
    const A = BigInt(a), W = BigInt(w), M = (1n << W) - 1n;
    switch (mode) {
      case 'sll': return d >= w ? 0n : (A << BigInt(d)) & M;
      case 'srl': return d >= w ? 0n : A >> BigInt(d);
      case 'sra': {
        const neg = (A >> (W - 1n)) & 1n;
        const r = d >= w ? (neg ? M : 0n) : A >> BigInt(d);
        return neg && d < w ? (r | (M & ~(M >> BigInt(d)))) & M : r;
      }
      case 'rol': { const k = BigInt(d % w); return ((A << k) | (A >> (W - k))) & M; }
      default: { const k = BigInt(d % w); return ((A >> k) | (A << (W - k))) & M; }
    }
  };
  const MODES = ['sll', 'srl', 'sra', 'rol', 'ror'];
  it('exhaustive at 4 bits for every mode', () => {
    for (const mode of MODES)
      for (let a = 0; a < 16; a++)
        for (let d = 0; d < 4; d++) expect(run('shifter', { bits: 4, mode }, { a, n: d }).y).toBe(big(refShift(mode, a, d, 4), 4));
  });
  it('odd width (5 bits): distances 5..7 exceed the width', () => {
    for (const mode of MODES)
      for (let a = 0; a < 32; a++)
        for (let d = 0; d < 8; d++) expect(run('shifter', { bits: 5, mode }, { a, n: d }).y, `${mode} ${a} ${d}`).toBe(big(refShift(mode, a, d, 5), 5));
  });
  it('shifts of the width or more: zeros, sign fill, rotate modulo', () => {
    expect(run('shifter', { bits: 5, mode: 'sll' }, { a: 0b11111, n: 5 }).y).toBe('00000');
    expect(run('shifter', { bits: 5, mode: 'srl' }, { a: 0b11111, n: 7 }).y).toBe('00000');
    expect(run('shifter', { bits: 5, mode: 'sra' }, { a: 0b10000, n: 6 }).y).toBe('11111');
    expect(run('shifter', { bits: 5, mode: 'sra' }, { a: 0b01111, n: 6 }).y).toBe('00000');
    expect(run('shifter', { bits: 5, mode: 'rol' }, { a: 0b10010, n: 5 }).y).toBe('10010');
    expect(run('shifter', { bits: 5, mode: 'rol' }, { a: 0b10010, n: 6 }).y).toBe('00101');
  });
  it('random 8/16/32 bit', () => {
    for (const w of [8, 16, 32])
      for (const mode of MODES)
        for (let k = 0; k < 100; k++) {
          const a = rnd(w), d = rnd(Math.ceil(Math.log2(w)));
          expect(run('shifter', { bits: w, mode }, { a, n: d }).y).toBe(big(refShift(mode, a, d, w), w));
        }
  });
  it('unknown distance gives all x; unknown data bits travel with the shift', () => {
    expect(run('shifter', { bits: 4 }, { a: 5, n: 'x0' }).y).toBe('xxxx');
    expect(run('shifter', { bits: 4 }, { a: 5 }).y).toBe('xxxx');
    expect(run('shifter', { bits: 4, mode: 'sll' }, { a: '00x1', n: 1 }).y).toBe('0x10');
    expect(run('shifter', { bits: 4, mode: 'sra' }, { a: 'x000', n: 1 }).y).toBe('xx00');
  });
});

describe('bit counter (population count)', () => {
  const pop = (n: number) => n.toString(2).replace(/0/g, '').length;
  it('output width holds inputs*bits', () => {
    const wOut = (p: Record<string, unknown>) => getDef('bitadder').pins(sanitizeProps('bitadder', p)).find((x) => x.name === 'y')!.width;
    expect(wOut({ bits: 1, inputs: 1 })).toBe(1);
    expect(wOut({ bits: 8, inputs: 1 })).toBe(4);
    expect(wOut({ bits: 4, inputs: 4 })).toBe(5);
    expect(wOut({ bits: 7, inputs: 1 })).toBe(3);
    expect(wOut({ bits: 32, inputs: 8 })).toBe(9);
  });
  it('exhaustive for one 8-bit input', () => {
    for (let a = 0; a < 256; a++) expect(run('bitadder', { bits: 8, inputs: 1 }, { in0: a }).y).toBe(bin(pop(a), 4));
  });
  it('several inputs, random 32 bit', () => {
    for (let k = 0; k < 100; k++) {
      const vs = Array.from({ length: 8 }, () => rnd(32));
      const ins = Object.fromEntries(vs.map((v, i) => [`in${i}`, v]));
      expect(run('bitadder', { bits: 32, inputs: 8 }, ins).y).toBe(bin(vs.reduce((s, v) => s + pop(v), 0), 9));
    }
  });
  it('unknown bits: an output bit stays known only if constant over every possible count', () => {
    // counts 1..2 = 001/010 in a 3-bit output: only the top bit is constant
    expect(run('bitadder', { bits: 4, inputs: 1 }, { in0: '1x00' }).y).toBe('0xx');
    // counts 0..1: only bit 0 varies
    expect(run('bitadder', { bits: 4, inputs: 1 }, { in0: 'x000' }).y).toBe('00x');
    // counts 4..5 = 0100/0101
    expect(run('bitadder', { bits: 8, inputs: 1 }, { in0: '1111x000' }).y).toBe('010x');
    // counts 3..5 = 011,100,101: bit 0 of min and max agree (1) but 4 is in range, so it must be x
    expect(run('bitadder', { bits: 8, inputs: 1 }, { in0: '111xx000' }).y).toBe('0xxx');
    // an unconnected input is unknown: counts 1..2
    expect(run('bitadder', { bits: 1, inputs: 2 }, { in0: 1 }).y).toBe('xx');
  });
});

describe('bit finder', () => {
  const ref = (mode: string, a: number, w: number): [number, number] => {
    const target = mode.endsWith('1') ? 1 : 0;
    const order = Array.from({ length: w }, (_, i) => i);
    if (mode.startsWith('high')) order.reverse();
    for (const i of order) if (((a >> i) & 1) === target) return [i, 1];
    return [0, 0];
  };
  it('exhaustive at 6 bits for every mode', () => {
    for (const mode of ['low1', 'high1', 'low0', 'high0'])
      for (let a = 0; a < 64; a++) {
        const [i, f] = ref(mode, a, 6);
        expect(run('bitfinder', { bits: 6, mode }, { a })).toEqual({ index: bin(i, 3), found: String(f) });
      }
  });
  it('random 32 bit', () => {
    for (const mode of ['low1', 'high1', 'low0', 'high0'])
      for (let k = 0; k < 100; k++) {
        const a = k % 10 === 0 ? [0, 0xffffffff][k % 2] : rnd(32);
        const [i, f] = ref(mode, a >>> 0, 32);
        expect(run('bitfinder', { bits: 32, mode }, { a })).toEqual({ index: bin(i, 5), found: String(f) });
      }
  });
  it('not found: index 0, found 0', () => {
    expect(run('bitfinder', { bits: 4, mode: 'low1' }, { a: 0 })).toEqual({ index: '00', found: '0' });
    expect(run('bitfinder', { bits: 4, mode: 'high0' }, { a: 15 })).toEqual({ index: '00', found: '0' });
  });
  it('unknown bit before the target gives x; beyond the target is ignored', () => {
    expect(run('bitfinder', { bits: 4, mode: 'low1' }, { a: '0x00' })).toEqual({ index: 'xx', found: 'x' });
    expect(run('bitfinder', { bits: 4, mode: 'low1' }, { a: 'xx10' })).toEqual({ index: '01', found: '1' });
    expect(run('bitfinder', { bits: 4, mode: 'high1' }, { a: '00x1' })).toEqual({ index: 'xx', found: 'x' });
    expect(run('bitfinder', { bits: 4, mode: 'high1' }, { a: '01xx' })).toEqual({ index: '10', found: '1' });
    expect(run('bitfinder', { bits: 4, mode: 'low0' }, { a: '1z11' })).toEqual({ index: 'xx', found: 'x' });
    expect(run('bitfinder', { bits: 4, mode: 'high0' }, { a: '1x11' })).toEqual({ index: 'xx', found: 'x' });
  });
  it('index width is indexBits(bits)', () => {
    const w = (b: number) => getDef('bitfinder').pins(sanitizeProps('bitfinder', { bits: b })).find((x) => x.name === 'index')!.width;
    expect([1, 2, 3, 8, 9, 32].map(w)).toEqual([1, 1, 2, 3, 4, 5]);
  });
});

describe('gray code', () => {
  const toG = (b: number) => (b ^ (b >>> 1)) >>> 0;
  it('exhaustive at 6 bits, both directions, and they invert each other', () => {
    for (let b = 0; b < 64; b++) {
      expect(run('gray', { bits: 6 }, { a: b }).y).toBe(bin(toG(b), 6));
      expect(run('gray', { bits: 6, direction: 'fromGray' }, { a: toG(b) }).y).toBe(bin(b, 6));
    }
  });
  it('consecutive values differ in one bit', () => {
    for (let b = 0; b < 15; b++) expect((toG(b) ^ toG(b + 1)).toString(2).replace(/0/g, '').length).toBe(1);
  });
  it('random 8/16/32 bit', () => {
    for (const w of [8, 16, 32])
      for (let k = 0; k < 100; k++) {
        const b = rnd(w);
        expect(run('gray', { bits: w }, { a: b }).y).toBe(bin(toG(b), w));
        expect(run('gray', { bits: w, direction: 'fromGray' }, { a: toG(b) }).y).toBe(bin(b, w));
      }
  });
  it('unknowns: each Gray bit mixes two neighbours; fromGray spoils bits at and below the unknown', () => {
    expect(run('gray', { bits: 4 }, { a: '10x0' }).y).toBe('11xx');
    expect(run('gray', { bits: 4, direction: 'fromGray' }, { a: '10x0' }).y).toBe('11xx');
    expect(run('gray', { bits: 3 }, {}).y).toBe('xxx');
  });
});

describe('wired into a circuit', () => {
  it('adder with a constant and a pin', () => {
    const t = new T();
    const add = t.add('adder', { bits: 8 });
    const c = t.add('const', { bits: 8, value: '0F' });
    const p = t.add('pin', { bits: 8 });
    t.wire(c, 'out', add, 'a').wire(p, 'p', add, 'b');
    const sim = t.sim();
    drive(sim, { [p]: '11110001' }, t.c);
    expect(str(sim.value(add, 's'))).toBe('00000000');
    expect(str(sim.value(add, 'cout'))).toBe('1');
  });
  it('comparator and shifter via wires', () => {
    const t = new T();
    const cmp = t.add('comparator', { bits: 4, numeric: 'signed' });
    const a = t.add('const', { bits: 4, value: 'F' });
    const b = t.add('const', { bits: 4, value: '1' });
    t.wire(a, 'out', cmp, 'a').wire(b, 'out', cmp, 'b');
    const sh = t.add('shifter', { bits: 4, mode: 'ror' });
    const d = t.add('const', { bits: 2, value: '1' });
    t.wire(b, 'out', sh, 'a').wire(d, 'out', sh, 'n');
    const sim = t.sim();
    expect(str(sim.value(cmp, 'lt'))).toBe('1');
    expect(str(sim.value(sh, 'y'))).toBe('1000');
  });
});
