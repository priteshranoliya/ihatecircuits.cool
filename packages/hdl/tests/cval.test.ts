import { describe, expect, it } from 'vitest';
import * as cv from '../src/elab/cval';

const v = (bits: string, signed = false) => cv.fromBits(bits, signed);
const b = cv.toBits;

describe('four-state constants', () => {
  it('keeps small values in numbers and wide ones in bigints', () => {
    expect(typeof v('1'.repeat(32)).a).toBe('number');
    expect(typeof v('1'.repeat(33)).a).toBe('bigint');
    expect(b(v('10xz01'))).toBe('10xz01');
    expect(b(cv.fromBig(-1n, 70, true))).toBe('1'.repeat(70));
  });

  it('bitwise operators follow the Verilog tables', () => {
    expect(b(cv.and(v('01x'), v('000')))).toBe('000');
    expect(b(cv.and(v('1x1'), v('11z')))).toBe('1xx');
    expect(b(cv.or(v('1x0'), v('xx0')))).toBe('1xx'.slice(0, 1) + 'x0');
    expect(b(cv.xor(v('10x'), v('111')))).toBe('01x');
    expect(b(cv.not(v('01xz')))).toBe('10xx');
  });

  it('arithmetic on a value with an unknown bit is entirely x, and division by zero is x', () => {
    expect(b(cv.add(v('01x1'), v('0001')))).toBe('xxxx');
    expect(b(cv.divide(v('0101'), v('0000'), false))).toBe('xxxx');
    expect(b(cv.add(v('1111'), v('0001')))).toBe('0000');
  });

  it('signed division truncates toward zero and the remainder takes the dividend sign', () => {
    const q = cv.divide(v('11111001', true), v('00000010', true), false);
    const r = cv.divide(v('11111001', true), v('00000010', true), true);
    expect([cv.toBigInt(q), cv.toBigInt(r)]).toEqual([-3n, -1n]);
  });

  it('shifts: arithmetic right fills with the sign, a shift past the width is all fill', () => {
    expect(b(cv.shiftRight(v('1000', true), cv.fromInt(1, 4, false), true))).toBe('1100');
    expect(b(cv.shiftRight(v('1000'), cv.fromInt(1, 4, false), false))).toBe('0100');
    expect(b(cv.shiftRight(v('1000', true), cv.fromInt(9, 4, false), true))).toBe('1111');
    expect(b(cv.shiftLeft(v('0011'), cv.fromInt(2, 4, false)))).toBe('1100');
    expect(b(cv.shiftLeft(v('0011'), v('00x0')))).toBe('xxxx');
  });

  it('== lets a known difference decide, and the power operator handles negative exponents', () => {
    expect(b(cv.eq(v('1x'), v('0x')))).toBe('0');
    expect(b(cv.eq(v('1x'), v('1x')))).toBe('x');
    expect(cv.toBigInt(cv.power(cv.fromInt(2), cv.fromInt(10)))).toBe(1024n);
    expect(cv.toBigInt(cv.power(cv.fromInt(2), cv.fromInt(-1)))).toBe(0n);
    expect(cv.toBigInt(cv.power(cv.fromInt(-1), cv.fromInt(-3)))).toBe(-1n);
  });

  it('reductions, conditions and the unknown-select merge', () => {
    expect(b(cv.reduceAnd(v('1x0')))).toBe('0');
    expect(b(cv.reduceOr(v('0x0')))).toBe('x');
    expect(b(cv.truth(v('0z1')))).toBe('1');
    expect(b(cv.select(v('x'), v('1100'), v('1010')))).toBe('1xx0');
  });

  it('extends by sign, concatenates, slices and replicates', () => {
    expect(b(cv.resize(v('10', true), 4))).toBe('1110');
    expect(b(cv.resize(v('10'), 4))).toBe('0010');
    expect(b(cv.concat([v('1x'), v('0z')]))).toBe('1x0z');
    expect(b(cv.slice(v('110010'), 1, 3))).toBe('001');
    expect(b(cv.replicate(v('10'), 3))).toBe('101010');
  });
});
