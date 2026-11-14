import { describe, expect, it } from 'vitest';
import { DiagnosticSink, SourceMap } from '../src/diagnostics';
import { lex } from '../src/lexer';
import { parseNumber } from '../src/number';

function tokens(src: string) {
  const sink = new DiagnosticSink();
  const toks = lex(new SourceMap(src), sink);
  return { toks: toks.filter((t) => t.kind !== 'eof'), diags: sink.items };
}

describe('lexer', () => {
  it('gives every token a span with offsets, line and column', () => {
    const src = 'module m;\n  wire [3:0] x;\nendmodule';
    const { toks, diags } = tokens(src);
    expect(diags).toEqual([]);
    const wire = toks.find((t) => t.text === 'wire')!;
    expect(wire.span).toEqual({ start: 12, end: 16, line: 2, col: 3 });
    expect(src.slice(wire.span.start, wire.span.end)).toBe('wire');
    const last = toks.at(-1)!;
    expect(last.text).toBe('endmodule');
    expect(last.span.line).toBe(3);
    expect(last.span.col).toBe(1);
  });

  it('separates keywords from identifiers', () => {
    const { toks } = tokens('module always_on assign');
    expect(toks.map((t) => [t.kind, t.text])).toEqual([
      ['keyword', 'module'],
      ['ident', 'always_on'],
      ['keyword', 'assign'],
    ]);
  });

  it('skips line and block comments but keeps positions', () => {
    const { toks, diags } = tokens('a // note\n/* multi\nline */ b');
    expect(diags).toEqual([]);
    expect(toks.map((t) => t.text)).toEqual(['a', 'b']);
    expect(toks[1]!.span).toMatchObject({ line: 3, col: 9 });
  });

  it('uses the longest operator at each position', () => {
    const { toks } = tokens('a <= b << c <<< d ~^ e === f');
    expect(toks.filter((t) => t.kind === 'op').map((t) => t.text)).toEqual(['<=', '<<', '<<<', '~^', '===']);
  });

  it('reads sized, unsized and spaced number literals as single tokens', () => {
    const { toks } = tokens("4'b1010 8'hFF 3'd5 'b101 12 8 'h0F 4'b 1_0_1_0 1_000");
    expect(toks.map((t) => t.kind)).toEqual(Array(8).fill('number'));
    expect(toks.map((t) => t.text)).toEqual(["4'b1010", "8'hFF", "3'd5", "'b101", '12', "8 'h0F", "4'b 1_0_1_0", '1_000']);
  });

  it('reports an unterminated comment, a stray character and a compiler directive', () => {
    expect(tokens('a /* never ends').diags[0]).toMatchObject({ code: 'lex-error', severity: 'error' });
    expect(tokens('a # b ` c'.replace('`', '§')).diags[0]).toMatchObject({ code: 'lex-error' });
    expect(tokens('`define W 8\nwire x;').diags[0]).toMatchObject({ code: 'not-supported' });
  });
});

describe('number literals', () => {
  const bits = (s: string) => {
    const r = parseNumber(s);
    if (!r.ok) throw new Error(r.message);
    return { bits: r.literal.bits, size: r.literal.size, width: r.literal.width };
  };

  it('unsized decimal is 32 bits (section 3.5.1)', () => {
    expect(bits('5')).toEqual({ bits: '00000000000000000000000000000101', size: undefined, width: 32 });
    expect(bits('1_000').width).toBe(32);
  });

  it('sized literals have exactly their size, whatever the base', () => {
    expect(bits("4'b1010")).toMatchObject({ bits: '1010', width: 4, size: 4 });
    expect(bits("8'hFF")).toMatchObject({ bits: '11111111', width: 8 });
    expect(bits("3'd5")).toMatchObject({ bits: '101', width: 3 });
    expect(bits("8'h5")).toMatchObject({ bits: '00000101' });
  });

  it('truncates a literal that does not fit and says so', () => {
    const r = parseNumber("4'hFF");
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect(bits("4'hFF").bits).toBe('1111');
  });

  it('rejects bad digits and zero sizes', () => {
    expect(parseNumber("4'b102")).toMatchObject({ ok: false, kind: 'invalid' });
    expect(parseNumber("0'b1")).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('keeps x and z digits (the elaborator rejects them for now)', () => {
    expect(bits("4'b1x0z")).toMatchObject({ bits: '1x0z' });
    expect(bits("8'hxF").bits).toBe('xxxx1111');
  });
});
