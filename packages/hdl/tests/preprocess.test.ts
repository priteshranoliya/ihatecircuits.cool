import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiagnosticSink, formatDiagnostic } from '../src/diagnostics';
import { lex } from '../src/lexer';
import { preprocess } from '../src/preprocess';

const hasIverilog = spawnSync('iverilog', ['-V']).error === undefined;

type Files = Record<string, string>;

function run(files: Files, main = 'main.v') {
  const sink = new DiagnosticSink();
  const pre = preprocess(files[main]!, { fileName: main, files }, sink);
  return { ...pre, sink, diags: sink.items };
}

/** Comments and the directives that pass through `iverilog -E`, removed, and every blank outside a string too. */
function normalize(text: string): string {
  const out: string[] = [];
  let i = 0;
  const keepLine = (line: string) => !/^\s*`(timescale|default_nettype|celldefine|endcelldefine|line|pragma|resetall|begin_keywords|end_keywords|unconnected_drive|nounconnected_drive)\b/.test(line);
  const src = text
    .split(/\r?\n/)
    .filter(keepLine)
    .join('\n');
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"') {
      let p = i + 1;
      while (p < src.length && src[p] !== '"') p += src[p] === '\\' ? 2 : 1;
      out.push(src.slice(i, p + 1));
      i = p + 1;
    } else {
      if (!/\s/.test(c)) out.push(c);
      i++;
    }
  }
  return out.join('');
}

function icarus(files: Files, main = 'main.v'): string {
  const dir = mkdtempSync(join(tmpdir(), 'gw-pp-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const r = spawnSync('iverilog', ['-E', '-o', '-', main], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`iverilog -E failed: ${r.stderr}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ORACLE_CASES: [string, Files][] = [
  ['object-like macro', { 'main.v': '`define W 8\nmodule m; wire [`W-1:0] x; reg [`W+1:0] y; endmodule\n' }],
  ['empty macro body', { 'main.v': '`define NOTHING\nmodule m; wire a; `NOTHING wire b; endmodule\n' }],
  ['macro with arguments', { 'main.v': '`define ADD(a, b) ((a) + (b))\nmodule m; wire [7:0] x = `ADD(1, 2) + `ADD(`ADD(3,4), 5); endmodule\n' }],
  ['arguments with nested brackets and strings', { 'main.v': '`define F(a, b) a ## b\n`define G(x, y) {x, y}\nmodule m; wire [3:0] q = `G({a, b}, c[1:0]); initial $display(`G("a,b", 1)); endmodule\n' }],
  ['default argument values', { 'main.v': '`define D(a, b=3, c=9) a+b+c\nmodule m; wire [7:0] x = `D(1); wire [7:0] y = `D(1, 2); wire [7:0] z = `D(1, , 7); endmodule\n' }],
  ['continued lines', { 'main.v': '`define MULTI(x) \\\n   x + \\\n   x + 1\nmodule m; wire [7:0] y = `MULTI(2); endmodule\n' }],
  ['macro using a macro', { 'main.v': '`define M(y) (y*2)\n`define N(x) `M(x) + x\nmodule m; wire [7:0] a = `N(3); endmodule\n' }],
  ['a macro defined after the macro that uses it', { 'main.v': '`define USER `LATER + 1\n`define LATER 40\nmodule m; wire [7:0] a = `USER; endmodule\n' }],
  ['redefinition and undef', { 'main.v': '`define X 1\n`define X 2\nmodule m; wire [3:0] a = `X; endmodule\n`undef X\n`define X 3\nmodule n; wire [3:0] b = `X; endmodule\n' }],
  ['no expansion in strings or comments', { 'main.v': '`define W 8\nmodule m; // `W here\n /* and `W here */ initial $display("`W %d", `W); endmodule\n' }],
  ['token pasting', { 'main.v': '`define T(a,b) a``b\nmodule m; wire `T(foo,bar), `T(x,1); endmodule\n' }],
  ['ifdef and else', { 'main.v': '`define A\nmodule m;\n`ifdef A\n wire has_a;\n`else\n wire no_a;\n`endif\n`ifdef B\n wire has_b;\n`else\n wire no_b;\n`endif\nendmodule\n' }],
  ['ifndef', { 'main.v': 'module m;\n`ifndef A\n wire no_a;\n`endif\n`define A\n`ifndef A\n wire still_no_a;\n`else\n wire a_now;\n`endif\nendmodule\n' }],
  ['elsif chain', { 'main.v': '`define B\nmodule m;\n`ifdef A\n wire a;\n`elsif B\n wire b;\n`elsif C\n wire c;\n`else\n wire d;\n`endif\nendmodule\n' }],
  ['nested conditionals, with directives in dropped regions', { 'main.v': 'module m;\n`ifdef OUT\n `define IN_OUT 1\n `ifdef IN_OUT\n wire never;\n `else\n wire never2;\n `endif\n`else\n wire kept;\n`endif\n`ifdef IN_OUT\n wire wrong;\n`endif\nendmodule\n' }],
  ['conditional on a macro defined in an include', { 'main.v': '`include "defs.v"\nmodule m;\n`ifdef FROM_INC\n wire inc_seen;\n`endif\nendmodule\n', 'defs.v': '`define FROM_INC 1\n' }],
  ['include in a subdirectory with a nested include', { 'main.v': '`include "lib/a.v"\nmodule m; endmodule\n', 'lib/a.v': 'wire from_a;\n`include "lib/b.v"\n', 'lib/b.v': 'wire from_b;\n' }],
  ['macro defined in an include used after it', { 'main.v': '`include "defs.v"\nmodule m; wire [`WIDTH-1:0] x; endmodule\n', 'defs.v': '`define WIDTH 16\n' }],
  ['directives with no text', { 'main.v': '`timescale 1ns/1ps\n`default_nettype none\n`celldefine\nmodule m; endmodule\n`endcelldefine\n`resetall\n`default_nettype wire\n' }],
  ['file and line', { 'main.v': 'module m;\n  initial $display("%s:%d", `__FILE__, `__LINE__);\nendmodule\n' }],
  ['a macro used as a delay or a number', { 'main.v': '`define DLY #5\n`define N 4\nmodule m; wire w; assign `DLY w = 1\'b1; reg [`N-1:0] r; initial r = `N\'d9; endmodule\n' }],
];

describe('preprocessor against iverilog -E', () => {
  for (const [name, files] of ORACLE_CASES) {
    it.skipIf(!hasIverilog)(`gives the same tokens for ${name}`, () => {
      const mine = run(files);
      expect(mine.diags.map(formatDiagnostic)).toEqual([]);
      expect(normalize(mine.text)).toBe(normalize(icarus(files)));
    });
  }
});

describe('preprocessor output', () => {
  it('returns the source itself when there is nothing to do', () => {
    const src = 'module m; endmodule';
    const r = run({ 'main.v': src });
    expect(r.text).toBe(src);
    expect(r.diags).toEqual([]);
  });

  it('records the directives that carry no text, and removes them', () => {
    const r = run({ 'main.v': '`timescale 1ns / 1ps\n`default_nettype none\n`celldefine\nmodule m; endmodule\n`endcelldefine\n' });
    expect(r.directives.map((d) => [d.name, d.args])).toEqual([
      ['timescale', '1ns / 1ps'],
      ['default_nettype', 'none'],
      ['celldefine', ''],
      ['endcelldefine', ''],
    ]);
    expect(r.text).not.toContain('`');
  });

  it('predefined macros work as if defined on the first line', () => {
    const sink = new DiagnosticSink();
    const r = preprocess('module m; wire [`W-1:0] x; endmodule', { defines: { W: '8' } }, sink);
    expect(sink.items).toEqual([]);
    expect(r.text.replace(/\s+/g, '')).toBe('modulem;wire[8-1:0]x;endmodule');
  });

  it('`line renumbers the lines after it', () => {
    const r = run({ 'main.v': '`line 100 "foo.v" 0\nwire a;\nwire b;\n' });
    const toks = lex(r.map, new DiagnosticSink()).filter((t) => t.kind === 'ident');
    expect(toks.map((t) => [t.text, t.span.line, t.span.file])).toEqual([
      ['a', 100, 'foo.v'],
      ['b', 101, 'foo.v'],
    ]);
  });
});

describe('source map', () => {
  const tokenSpans = (files: Files) => {
    const r = run(files);
    return lex(r.map, new DiagnosticSink()).filter((t) => t.kind !== 'eof');
  };

  it('points tokens after a macro back at their own line and column', () => {
    const toks = tokenSpans({ 'main.v': '`define W 8\nwire [`W-1:0] x;\nwire y;\n' });
    const y = toks.find((t) => t.text === 'y')!;
    expect(y.span).toMatchObject({ line: 3, col: 6 });
    expect(y.span.file).toBeUndefined();
  });

  it('points a token from a macro body at the body, and names the macro and its use', () => {
    const toks = tokenSpans({ 'main.v': '`define BAD(a) a + ;\nmodule m;\n  assign y = `BAD(x);\nendmodule\n' });
    const plus = toks.find((t) => t.text === '+')!;
    expect(plus.span).toMatchObject({ line: 1, col: 18, expansion: { macro: 'BAD', line: 3, col: 14 } });
    const x = toks.find((t) => t.text === 'x')!;
    expect(x.span).toMatchObject({ line: 3, col: 19 });
    expect(x.span.expansion).toBeUndefined();
  });

  it('chains the expansions of macros used inside other macros', () => {
    const toks = tokenSpans({ 'main.v': '`define INNER ?\n`define OUTER 1 + `INNER\nassign y = `OUTER;\n' });
    const q = toks.find((t) => t.text === '?')!;
    expect(q.span).toMatchObject({ line: 1, col: 15, expansion: { macro: 'INNER', line: 2, col: 19, outer: { macro: 'OUTER', line: 3, col: 12 } } });
  });

  it('points tokens of an included file at that file', () => {
    const toks = tokenSpans({ 'main.v': 'wire a;\n`include "lib/inc.v"\nwire c;\n', 'lib/inc.v': '\n  wire b;\n' });
    expect(toks.filter((t) => t.kind === 'ident').map((t) => [t.text, t.span.line, t.span.col, t.span.file])).toEqual([
      ['a', 1, 6, undefined],
      ['b', 2, 8, 'lib/inc.v'],
      ['c', 3, 6, undefined],
    ]);
  });

  it('says in which macro a diagnostic is, and where the macro was used', () => {
    const sink = new DiagnosticSink();
    const pre = preprocess('`define BAD x $\nmodule m;\n  wire w = `BAD;\nendmodule\n', {}, sink);
    lex(pre.map, sink);
    expect(sink.items).toHaveLength(1);
    expect(sink.items[0]!.message).toBe("A '$' must be followed by a system task or function name. (in macro BAD, expanded at line 3)");
    expect(formatDiagnostic(sink.items[0]!)).toContain('1:15');
  });
});

describe('preprocessor errors', () => {
  const diag = (files: Files) => run(files).diags.map((d) => [d.code, d.span.line, d.span.col, d.span.file ?? '', d.message] as const);

  it('reports a macro that is not defined, at its use', () => {
    expect(diag({ 'main.v': 'module m;\n  wire a = `NOPE;\nendmodule\n' })).toEqual([['preprocess-error', 2, 12, '', 'The macro `NOPE is not defined. Define it with `define NOPE ... first.']]);
  });

  it('reports a macro that expands into itself, with the chain', () => {
    const d = diag({ 'main.v': '`define A `B\n`define B `A\nwire x = `A;\n' });
    expect(d).toHaveLength(1);
    expect(d[0]![4]).toBe('The macro `A expands into itself (`A -> `B -> `A). (in macro B, expanded at line 1, inside macro A, expanded at line 3)');
    expect(d[0]![1]).toBe(2);
    expect(diag({ 'main.v': '`define R `R\n`R\n' })[0]![4]).toContain('The macro `R expands into itself (`R -> `R).');
  });

  it('reports an include cycle, naming the files', () => {
    const d = diag({ 'main.v': '`include "a.v"\n', 'a.v': 'wire a;\n`include "b.v"\n', 'b.v': 'wire b;\n`include "a.v"\n' });
    expect(d).toEqual([['preprocess-error', 2, 1, 'b.v', '`include cycle: main.v includes a.v includes b.v includes a.v.']]);
    expect(diag({ 'main.v': '`include "main.v"\n' })[0]![4]).toBe('`include cycle: main.v includes main.v.');
  });

  it('reports an include file that cannot be found', () => {
    expect(diag({ 'main.v': 'wire a;\n`include "gone.v"\n' })).toEqual([['preprocess-error', 2, 1, '', 'Cannot open the include file "gone.v". Pass it in the \'files\' option.']]);
  });

  it('reports conditionals that are never closed or have no opener', () => {
    expect(diag({ 'main.v': 'wire a;\n`ifdef X\nwire b;\n' })).toEqual([['preprocess-error', 2, 1, '', 'This `ifdef is never closed. Add `endif.']]);
    expect(diag({ 'main.v': '`endif\n' })[0]![4]).toBe('`endif without a matching `ifdef or `ifndef.');
    expect(diag({ 'main.v': '`else\n' })[0]![4]).toBe('`else without a matching `ifdef or `ifndef.');
    expect(diag({ 'main.v': '`ifdef X\n`else\n`else\n`endif\n' })[0]![4]).toBe('This conditional already has an `else.');
  });

  it('reports a wrong number of macro arguments', () => {
    expect(diag({ 'main.v': '`define F(a, b) a b\nwire `F(1);\n' })[0]![4]).toBe('`F needs 2 arguments, but 1 was given.');
    expect(diag({ 'main.v': '`define F(a) a\nwire `F(1, 2);\n' })[0]![4]).toBe('`F takes 1 argument, but 2 were given.');
    expect(diag({ 'main.v': '`define F(a) a\nwire `F;\n' })[0]![4]).toBe('The macro `F takes 1 argument. Write `F(...).');
  });

  it('reports a bad timescale and a bad default_nettype', () => {
    expect(diag({ 'main.v': '`timescale 3ns/1ps\n' })[0]![4]).toContain('`timescale needs a unit and a precision');
    expect(diag({ 'main.v': '`default_nettype bogus\n' })[0]![4]).toContain('`default_nettype needs a net type');
  });

  it('does not run away on a macro that doubles itself', () => {
    const files = { 'main.v': `\`define A0 x\n${Array.from({ length: 30 }, (_, i) => `\`define A${i + 1} \`A${i} \`A${i}`).join('\n')}\n\`A30\n` };
    const r = run(files);
    expect(r.diags).toHaveLength(1);
    expect(r.diags[0]!.message).toContain('Macros expand to more than');
  });
});

describe('where this preprocessor follows the standard and iverilog -E does not', () => {
  const text = (files: Files) => normalize(run(files).text);

  it('keeps a parenthesised default argument whole (iverilog drops a parenthesis)', () => {
    expect(text({ 'main.v': '`define D(a, c=(4+5)) a+c\nwire [7:0] x = `D(1);\n' })).toBe('wire[7:0]x=1+(4+5);');
  });

  it('does not substitute an argument name inside a string (iverilog does)', () => {
    expect(text({ 'main.v': '`define S(x) "x" x\ninitial $display(`S(q));\n' })).toBe('initial$display("x"q);');
  });

  it('finds an include relative to the including file as well as to the root', () => {
    expect(text({ 'main.v': '`include "lib/a.v"\n', 'lib/a.v': '`include "b.v"\nwire a;\n', 'lib/b.v': 'wire b;\n' })).toBe('wireb;wirea;');
  });

  it('treats a macro that is not defined as an error (iverilog warns and assumes it empty)', () => {
    expect(run({ 'main.v': 'wire a = `NOPE;\n' }).diags).toHaveLength(1);
  });

  it('reports a recursive macro (iverilog crashes)', () => {
    expect(run({ 'main.v': '`define R `R\n`R\n' }).diags).toHaveLength(1);
  });
});
