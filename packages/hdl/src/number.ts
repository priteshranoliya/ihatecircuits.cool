import { abbreviate } from './diagnostics';

/**
 * Number literals (IEEE 1364-2005 §3.5).
 *
 * `bits` is the literal's value written most significant bit first, one of
 * '0' '1' 'x' 'z' per bit, exactly `width` characters long. An unsized literal
 * is 32 bits wide, or wider when its value needs more (§3.5.1).
 */

export interface NumberLiteral {
  /** Declared size in bits; undefined for an unsized literal. */
  size: number | undefined;
  base: 'b' | 'o' | 'd' | 'h';
  /** The literal carried an `s`, as in 8'sd5. */
  signed: boolean;
  bits: string;
  /** Width the literal has when it takes part in an expression. */
  width: number;
}

export type NumberParse =
  | { ok: true; literal: NumberLiteral; /** Known 1 bits were cut off by a too-small size. */ truncated: boolean }
  | { ok: false; kind: 'invalid' | 'unsupported' | 'too-large'; message: string };

const UNSIZED_WIDTH = 32;
/** The largest literal the compiler will build, in bits. Checked before any digit string is expanded. */
export const MAX_LITERAL_BITS = 65536;
const MAX_DECIMAL_DIGITS = Math.ceil(MAX_LITERAL_BITS * Math.log10(2));
const BASE_NAME = { b: 'binary', o: 'octal', d: 'decimal', h: 'hexadecimal' } as const;
const DIGIT_BITS = { b: 1, o: 3, h: 4 } as const;

function validDigit(base: 'b' | 'o' | 'd' | 'h', ch: string): boolean {
  if ('xzXZ?'.includes(ch)) return true;
  switch (base) {
    case 'b':
      return ch === '0' || ch === '1';
    case 'o':
      return ch >= '0' && ch <= '7';
    case 'd':
      return ch >= '0' && ch <= '9';
    case 'h':
      return /[0-9a-fA-F]/.test(ch);
  }
}

const tooLarge = (what: string): NumberParse => ({ ok: false, kind: 'too-large', message: `${what} is more than ${MAX_LITERAL_BITS} bits wide, which is the largest number the compiler will build.` });

export function parseNumber(raw: string): NumberParse {
  const text = raw.replace(/_/g, '').replace(/\s+/g, '');
  if (/^[0-9]+$/.test(text)) {
    const digits = text.replace(/^0+(?=.)/, '');
    if (digits.length > MAX_DECIMAL_DIGITS) return tooLarge('This number');
    const value = BigInt(digits);
    const bits = value.toString(2);
    if (bits.length > MAX_LITERAL_BITS) return tooLarge('This number');
    const width = Math.max(UNSIZED_WIDTH, bits.length);
    return { ok: true, literal: { size: undefined, base: 'd', signed: false, bits: bits.padStart(width, '0'), width }, truncated: false };
  }
  if (!text.includes("'")) return { ok: false, kind: 'unsupported', message: 'Real numbers are not supported yet.' };
  const m = /^([0-9]*)'([sS]?)([bBoOdDhH])(.*)$/.exec(text);
  if (!m) return { ok: false, kind: 'invalid', message: `'${abbreviate(raw)}' is not a valid number.` };
  const [, sizeText, sign, baseLetter, digits] = m as unknown as [string, string, string, string, string];
  const base = baseLetter.toLowerCase() as 'b' | 'o' | 'd' | 'h';
  const size = sizeText === '' ? undefined : Number(sizeText);
  if (size !== undefined && size > MAX_LITERAL_BITS) return tooLarge(`The size ${abbreviate(sizeText)}`);
  if (size === 0) return { ok: false, kind: 'invalid', message: 'A number cannot be 0 bits wide. Use a size of at least 1.' };
  if (digits === '') return { ok: false, kind: 'invalid', message: `This ${BASE_NAME[base]} number has no digits.` };
  for (const ch of digits) {
    if (!validDigit(base, ch)) return { ok: false, kind: 'invalid', message: `'${ch}' is not a valid ${BASE_NAME[base]} digit.` };
  }
  const perDigit = base === 'd' ? 3.33 : DIGIT_BITS[base];
  if (digits.length * perDigit > MAX_LITERAL_BITS + 4) return tooLarge('This number');
  let bits: string;
  if (base === 'd') {
    if (/[xXzZ?]/.test(digits)) {
      if (digits.length !== 1) return { ok: false, kind: 'invalid', message: "A decimal number can use x or z only as its single digit, as in 4'dx." };
      bits = ('xX'.includes(digits) ? 'x' : 'z').repeat(size ?? UNSIZED_WIDTH);
    } else bits = BigInt(digits).toString(2);
    if (bits.length > MAX_LITERAL_BITS) return tooLarge('This number');
  } else {
    const per = DIGIT_BITS[base];
    bits = [...digits]
      .map((ch) => {
        if ('xX'.includes(ch)) return 'x'.repeat(per);
        if ('zZ?'.includes(ch)) return 'z'.repeat(per);
        return parseInt(ch, base === 'h' ? 16 : base === 'o' ? 8 : 2).toString(2).padStart(per, '0');
      })
      .join('');
  }
  if (bits.length > MAX_LITERAL_BITS && size === undefined) return tooLarge('This number');
  const width = size ?? Math.max(UNSIZED_WIDTH, bits.length);
  let truncated = false;
  if (bits.length < width) {
    const lead = bits[0]!;
    bits = (lead === 'x' || lead === 'z' ? lead : '0').repeat(width - bits.length) + bits;
  } else if (bits.length > width) {
    truncated = bits.slice(0, bits.length - width).includes('1');
    bits = bits.slice(bits.length - width);
  }
  return { ok: true, literal: { size, base, signed: sign !== '', bits, width }, truncated };
}
