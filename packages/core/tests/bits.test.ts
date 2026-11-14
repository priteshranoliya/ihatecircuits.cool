import { describe, expect, it } from 'vitest';
import { and, bits, concat, floating, formatBits, fromStates, not, or, resolve, slice, toSigned, unknown, xor, exactlyOne } from '../src/bits';
import { str } from './helpers';

const one = (s: 0 | 1 | 'x' | 'z' | 'e') => fromStates([s]);

describe('bit vectors', () => {
  it('round-trips states and formats', () => {
    const b = fromStates([1, 0, 'x', 'z', 'e']);
    expect(str(b)).toBe('ezx01');
    expect(formatBits(b)).toBe('EZx01');
    expect(formatBits(bits(8, 0xa5), 'hex')).toBe('A5');
    expect(toSigned(bits(4, 0b1111))).toBe(-1);
    expect(toSigned(bits(4, 0b0111))).toBe(7);
    expect(toSigned(bits(32, 0x80000000))).toBe(-2147483648);
  });
  it('slices and concatenates (bit 0 first)', () => {
    const b = concat([bits(2, 0b01), bits(2, 0b10)]);
    expect(str(b)).toBe('1001');
    expect(str(slice(b, 1, 2))).toBe('00');
    expect(str(concat([bits(16, 0xffff), bits(16, 0x1234)]))).toBe('0001001000110100' + '1'.repeat(16));
  });
  it('Kleene logic per bit', () => {
    expect(str(and([one(0), one('x')], 1))).toBe('0');
    expect(str(and([one(1), one('x')], 1))).toBe('x');
    expect(str(or([one(1), one('z')], 1))).toBe('1');
    expect(str(or([one(0), one('e')], 1))).toBe('x');
    expect(str(xor([one(1), one('x')], 1))).toBe('x');
    expect(str(not(fromStates([0, 1, 'x', 'z'])))).toBe('xx01');
    expect(str(and([bits(4, 0b1100), bits(4, 0b1010)], 4))).toBe('1000');
  });
  it('exactly-one differs from parity with 3+ inputs', () => {
    const v = [bits(1, 1), bits(1, 1), bits(1, 1)];
    expect(str(xor(v, 1))).toBe('1');
    expect(str(exactlyOne(v, 1))).toBe('0');
    expect(str(exactlyOne([bits(1, 1), bits(1, 1), one('x')], 1))).toBe('0');
  });
});

describe('net resolution (strong part of IEEE 1164)', () => {
  const r = (...ds: (0 | 1 | 'x' | 'z' | 'e')[]) => str(resolve(1, ds.map(one)));
  it('z yields to any driver', () => {
    expect(r('z', 1)).toBe('1');
    expect(r('z', 0)).toBe('0');
    expect(r('z', 'z')).toBe('z');
    expect(r()).toBe('z');
  });
  it('agreeing drivers keep their value; disagreeing ones conflict', () => {
    expect(r(1, 1)).toBe('1');
    expect(r(0, 1)).toBe('e');
    expect(r(0, 'z', 1)).toBe('e');
  });
  it('an unknown driver makes the net unknown', () => {
    expect(r('x', 0)).toBe('x');
    expect(r('x', 'z')).toBe('x');
  });
  it('a pull only sets bits nobody drives', () => {
    expect(str(resolve(1, [one('z')], 1))).toBe('1');
    expect(str(resolve(1, [], 0))).toBe('0');
    expect(str(resolve(1, [one(0)], 1))).toBe('0');
    expect(str(resolve(4, [fromStates([0, 'z', 1, 'z'])], 1))).toBe('1110');
  });
  it('is commutative and works per bit on buses', () => {
    const a = fromStates([0, 1, 'z', 'z']);
    const b = fromStates(['z', 'z', 1, 0]);
    expect(str(resolve(4, [a, b]))).toBe('0110');
    expect(str(resolve(4, [b, a]))).toBe('0110');
    expect(str(resolve(4, [floating(4), unknown(4)]))).toBe('xxxx');
  });
});
