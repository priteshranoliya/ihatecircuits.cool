import { describe, expect, it } from 'vitest';
import type { BinaryExpr, Expr, ModuleDecl, TernaryExpr } from '../src/ast';
import { DiagnosticSink, SourceMap } from '../src/diagnostics';
import { lex } from '../src/lexer';
import { parse, parseExpression } from '../src/parser';
import { compile } from '../src';

function parseSource(src: string) {
  const sink = new DiagnosticSink();
  const file = parse(lex(new SourceMap(src), sink), sink);
  return { file, diags: sink.items };
}

function expr(src: string): Expr {
  const sink = new DiagnosticSink();
  const e = parseExpression(lex(new SourceMap(src), sink), sink);
  if (!e) throw new Error(sink.items[0]?.message);
  return e;
}

/** Fully parenthesised rendering, to read precedence off. */
function show(e: Expr): string {
  switch (e.kind) {
    case 'ident':
      return e.name;
    case 'number':
      return e.text;
    case 'index':
      return `${e.base.name}[${show(e.hi)}${e.lo ? ':' + show(e.lo) : ''}]`;
    case 'concat':
      return `{${e.parts.map(show).join(',')}}`;
    case 'replicate':
      return `{${show(e.count)}${show(e.inner)}}`;
    case 'unary':
      return `(${e.op}${show(e.operand)})`;
    case 'binary':
      return `(${show(e.lhs)} ${e.op} ${show(e.rhs)})`;
    case 'ternary':
      return `(${show(e.cond)} ? ${show(e.then)} : ${show(e.else)})`;
    default:
      return `<${e.kind}>`;
  }
}

describe('expression parser (Pratt)', () => {
  it('follows the Verilog precedence table', () => {
    expect(show(expr('a + b == c'))).toBe('((a + b) == c)');
    expect(show(expr('a | b & c'))).toBe('(a | (b & c))');
    expect(show(expr('a | b ^ c & d'))).toBe('(a | (b ^ (c & d)))');
    expect(show(expr('a == b & c'))).toBe('((a == b) & c)');
    expect(show(expr('a + b * c'))).toBe('(a + (b * c))');
    expect(show(expr('a && b || c'))).toBe('((a && b) || c)');
  });

  it('is left associative for binary operators and right associative for ?:', () => {
    expect(show(expr('a + b + c'))).toBe('((a + b) + c)');
    expect(show(expr('a ? b : c ? d : e'))).toBe('(a ? b : (c ? d : e))');
    expect(show(expr('a ? b ? c : d : e'))).toBe('(a ? (b ? c : d) : e)');
  });

  it('binds unary operators tighter than any binary operator', () => {
    expect(show(expr('~a & b'))).toBe('((~a) & b)');
    expect(show(expr('~(a & b)'))).toBe('(~(a & b))');
    expect(show(expr('~(~a)'))).toBe('(~(~a))');
    expect(show(expr('&a | b'))).toBe('((&a) | b)');
  });

  it('parses selects, concatenation and replication', () => {
    expect(show(expr('{a, b[3], c[7:4]}'))).toBe('{a,b[3],c[7:4]}');
    expect(show(expr('{2{a, b}}'))).toBe('{2{a,b}}');
  });

  it('gives binary nodes a span from the first to the last operand', () => {
    const e = expr('abc + de') as BinaryExpr;
    expect(e.span).toMatchObject({ start: 0, end: 8, line: 1, col: 1 });
    expect(e.rhs.span).toMatchObject({ start: 6, end: 8 });
    const t = expr('s ? a : b') as TernaryExpr;
    expect(t.span).toMatchObject({ start: 0, end: 9 });
  });
});

describe('module parser', () => {
  const src = `module m (input [7:0] a, b, input clk, output [8:0] y, output reg [3:0] q);
  wire [7:0] x, w;
  reg [3:0] r;
  assign y = a + b;
  always @(posedge clk) begin
    if (a[0]) q <= 1;
    else q <= q;
  end
  sub u1 (.a(x), .y());
endmodule`;

  it('reads ANSI ports, letting a port inherit the previous port attributes', () => {
    const { file, diags } = parseSource(src);
    expect(diags).toEqual([]);
    const m = file.modules[0] as ModuleDecl;
    expect(m.ports.map((p) => [p.name.name, p.dir, p.net ?? '', p.range ? 'range' : ''])).toEqual([
      ['a', 'input', '', 'range'],
      ['b', 'input', '', 'range'],
      ['clk', 'input', '', ''],
      ['y', 'output', '', 'range'],
      ['q', 'output', 'reg', 'range'],
    ]);
  });

  it('reads the body items in order with spans', () => {
    const { file } = parseSource(src);
    const m = file.modules[0]!;
    expect(m.items.map((i) => i.kind)).toEqual(['netDecl', 'netDecl', 'continuousAssign', 'always', 'instance']);
    expect(m.name.span).toMatchObject({ line: 1, col: 8 });
    const always = m.items[3]!;
    expect(always.span.line).toBe(5);
    const inst = m.items[4]!;
    expect(inst.kind === 'instance' && inst.conns.map((c) => [c.port.name, c.expr ? 'expr' : 'none'])).toEqual([
      ['a', 'expr'],
      ['y', 'none'],
    ]);
  });

  it('reports two separate syntax errors as two diagnostics', () => {
    const { diags } = parseSource(`module m (input a, output y);
  assign y = a +;
  wire [3:0 w;
  assign y = a;
endmodule`);
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.span.line)).toEqual([2, 3]);
    expect(diags.every((d) => d.code === 'syntax-error' && d.severity === 'error')).toBe(true);
  });

  it('recovers inside a begin/end block, one diagnostic per bad statement', () => {
    const { diags, file } = parseSource(`module m (input clk, output reg q);
  always @(posedge clk) begin
    q <= ;
    q <= 1 +;
    q <= 0;
  end
endmodule`);
    expect(diags.map((d) => d.span.line)).toEqual([3, 4]);
    const always = file.modules[0]!.items[0]!;
    expect(always.kind === 'always' && always.body.kind === 'block' && always.body.stmts).toHaveLength(1);
  });

  it('a missing semicolon costs one diagnostic and the next item still parses', () => {
    const { diags, file } = parseSource(`module m (input a, output y, output z);
  assign y = a
  assign z = a;
endmodule`);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("Expected ';'");
    expect(file.modules[0]!.items).toHaveLength(1);
  });

  it('recovers across modules too', () => {
    const { diags, file } = parseSource(`module a (input x, output y);
  assign y = ;
endmodule
module b (input x, output y);
  assign y = x;
endmodule`);
    expect(diags).toHaveLength(1);
    expect(file.modules.map((m) => m.name.name)).toEqual(['a', 'b']);
  });

  it('says a module is never closed', () => {
    const { diags } = parseSource('module m (input a);\n  wire w;');
    expect(diags[0]!.message).toContain("endmodule");
  });
});

describe('unsupported constructs', () => {
  const cases: [string, string, string, string][] = [
    ['a delay in an initial block', 'initial begin #5 q = 1; end', 'not-synthesizable', 'not synthesizable'],
    ['a real variable', 'real r;', 'not-supported', 'not supported yet'],
    ['a forever loop', 'always @(posedge clk) forever q <= 1;', 'not-synthesizable', 'not synthesizable'],
    ['an event declaration', 'event ev;', 'not-synthesizable', 'not synthesizable'],
    ['a switch primitive', 'nmos g (q, a, a);', 'not-supported', 'not supported yet'],
    ['a multi-dimensional array', 'reg [3:0] mem [0:3][0:3];', 'not-supported', 'not supported yet'],
    ['an always block with no event list', 'always q = a;', 'not-synthesizable', 'not synthesizable'],
    ['a trireg', 'trireg t;', 'not-supported', 'not supported yet'],
  ];
  for (const [what, body, code, text] of cases) {
    it(`says ${what} is ${text} and still checks the rest`, () => {
      const r = compile(`module m (input a, input clk, output reg q);\n  ${body}\n  wire [3:0 broken;\nendmodule`);
      const hits = r.diagnostics.filter((d) => d.code === code);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.message).toContain(text);
      expect(hits[0]!.span.line).toBe(2);
      expect(r.diagnostics.some((d) => d.code === 'syntax-error' && d.span.line === 3)).toBe(true);
      expect(r.design).toBeUndefined();
    });
  }

  it('points the span at the offending expression', () => {
    const src = 'module m (input [3:0] a, input [3:0] b, output y);\n  assign y = a === b;\nendmodule';
    const r = compile(src);
    const d = r.diagnostics.find((x) => x.code === 'x-comparison')!;
    expect(src.slice(d.span.start, d.span.end)).toBe('a === b');
    expect(d).toMatchObject({ severity: 'error', span: { line: 2, col: 14 } });
  });

  it('accepts positional connections and non-ANSI headers', () => {
    const pos = compile('module s (input a, output y); assign y = a; endmodule\nmodule t (input a, output y); s u (a, y); endmodule');
    expect(pos.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const old = compile('module m (a, y); input a; output y; assign y = a; endmodule');
    expect(old.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
