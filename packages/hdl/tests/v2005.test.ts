import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type * as A from '../src/ast';
import { formatDiagnostic } from '../src/diagnostics';
import { lex } from '../src/lexer';
import { parseExpression } from '../src/parser';
import { print } from '../src/print';
import { DiagnosticSink, SourceMap } from '../src/diagnostics';
import { parseSource, stripSpans } from './ast-util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'v2005');
const hasIverilog = spawnSync('iverilog', ['-V']).error === undefined;

const mainFiles = readdirSync(ROOT).filter((f) => f.endsWith('.v')).sort();
const standardOnly = readdirSync(join(ROOT, 'standard-only')).filter((f) => f.endsWith('.v')).sort();
const read = (path: string) => readFileSync(path, 'utf8');

function roundTrip(src: string) {
  const a = parseSource(src);
  expect(a.diags.map(formatDiagnostic)).toEqual([]);
  const text = print(a.file);
  const b = parseSource(text);
  expect(b.diags.map(formatDiagnostic), `printed text:\n${text}`).toEqual([]);
  expect(stripSpans(b.file)).toEqual(stripSpans(a.file));
  expect(print(b.file)).toBe(text);
}

describe('handwritten Verilog-2005 corpus', () => {
  it('has at least 60 files and each says which Annex A productions it covers', () => {
    expect(mainFiles.length).toBeGreaterThanOrEqual(60);
    for (const f of mainFiles) expect(read(join(ROOT, f)), f).toMatch(/^\/\/ annex: [A-Za-z0-9.,; \-]+/);
  });

  for (const f of mainFiles) {
    const path = join(ROOT, f);
    it.skipIf(!hasIverilog)(`iverilog -g2005 accepts ${f}`, () => {
      const r = spawnSync('iverilog', ['-g2005', '-t', 'null', '-o', '/dev/null', path], { encoding: 'utf8' });
      expect(r.stderr.split('\n').filter((l) => /error|syntax/i.test(l))).toEqual([]);
      expect(r.status).toBe(0);
    });
    it(`parses ${f} with no errors, and print then parse gives the same tree`, () => roundTrip(read(path)));
  }
});

describe('valid IEEE 1364-2005 that iverilog rejects', () => {
  it('has the standard-only files', () => expect(standardOnly.length).toBeGreaterThanOrEqual(4));
  for (const f of standardOnly) {
    it(`parses ${f}, and print then parse gives the same tree`, () => roundTrip(read(join(ROOT, 'standard-only', f))));
  }
});

// ---------------------------------------------------------------- AST shape

/** Expressions as S-expressions, to read precedence and structure off. */
function sx(e: A.Expr | null | undefined): string {
  if (!e) return '_';
  switch (e.kind) {
    case 'ident':
      return e.name;
    case 'hier':
      return e.segments.map((s) => s.name.name + (s.index ? `[${sx(s.index)}]` : '')).join('.');
    case 'number':
    case 'real':
    case 'string':
      return e.text;
    case 'index': {
      const base = e.base.kind === 'ident' ? e.base.name : sx(e.base);
      const dims = e.dims.map((d) => `[${sx(d)}]`).join('');
      const op = { bit: '', range: ':', plus: '+:', minus: '-:' }[e.mode];
      return `${base}${dims}[${sx(e.hi)}${e.lo ? op + sx(e.lo) : ''}]`;
    }
    case 'concat':
      return `{${e.parts.map(sx).join(',')}}`;
    case 'replicate':
      return `{${sx(e.count)}${sx(e.inner)}}`;
    case 'unary':
      return `(${e.op} ${sx(e.operand)})`;
    case 'binary':
      return `(${e.op} ${sx(e.lhs)} ${sx(e.rhs)})`;
    case 'ternary':
      return `(? ${sx(e.cond)} ${sx(e.then)} ${sx(e.else)})`;
    case 'mintypmax':
      return `(${sx(e.min)}:${sx(e.typ)}:${sx(e.max)})`;
    case 'call':
      return `${sx(e.callee)}(${e.args.map(sx).join(',')})`;
    case 'syscall':
      return `${e.name}(${e.args.map(sx).join(',')})`;
  }
}

function expr(src: string): A.Expr {
  const sink = new DiagnosticSink();
  const e = parseExpression(lex(new SourceMap(src), sink), sink);
  if (!e) throw new Error(sink.items.map(formatDiagnostic).join('\n'));
  return e;
}

const moduleOf = (body: string, header = 'module m;') => {
  const r = parseSource(`${header}\n${body}\nendmodule`);
  expect(r.diags.map(formatDiagnostic)).toEqual([]);
  return r.file.modules[0]!;
};
const stmtOf = (src: string): A.Stmt => {
  const m = moduleOf(`initial ${src}`);
  return (m.items[0] as A.InitialBlock).body;
};

describe('printer', () => {
  const pr = (src: string) => print(parseSource(`module m; assign y = ${src}; endmodule`).file).split('\n')[1]!.trim();
  it('writes only the parentheses precedence needs, and the result reads back the same', () => {
    const cases: [string, string][] = [
      ['(a + b) * c', 'assign y = (a + b) * c;'],
      ['a - (b - c)', 'assign y = a - (b - c);'],
      ['(a - b) - c', 'assign y = a - b - c;'],
      ['-(a + b)', 'assign y = -(a + b);'],
      ['-(-a)', 'assign y = -(-a);'],
      ['~&(a | b)', 'assign y = ~&(a | b);'],
      ['(a ? b : c) ? d : e', 'assign y = (a ? b : c) ? d : e;'],
      ['a ? (b ? c : d) : e', 'assign y = a ? b ? c : d : e;'],
      ['a ? b : (c ? d : e)', 'assign y = a ? b : c ? d : e;'],
      ['(a ? b : c) + d', 'assign y = (a ? b : c) + d;'],
      ['a ** (b ** c)', 'assign y = a ** (b ** c);'],
      ['{2{a, b}}', 'assign y = {2{a, b}};'],
    ];
    for (const [src, want] of cases) {
      expect(pr(src), src).toBe(want);
      expect(stripSpans(parseSource(`module m; ${pr(src)} endmodule`).file), src).toEqual(stripSpans(parseSource(`module m; assign y = ${src}; endmodule`).file));
    }
  });
});

describe('expression shape', () => {
  it('follows the precedence table, all the way from ** to ?:', () => {
    expect(sx(expr('a + b * c ** d'))).toBe('(+ a (* b (** c d)))');
    expect(sx(expr('a || b && c | d ^ e & f == g < h << i + j * k'))).toBe('(|| a (&& b (| c (^ d (& e (== f (< g (<< h (+ i (* j k))))))))))');
    expect(sx(expr('a << b + c'))).toBe('(<< a (+ b c))');
    expect(sx(expr('a < b == c'))).toBe('(== (< a b) c)');
    expect(sx(expr('a & b == c'))).toBe('(& a (== b c))');
    expect(sx(expr('a === b !== c'))).toBe('(!== (=== a b) c)');
    expect(sx(expr('a ~^ b ^~ c ^ d'))).toBe('(^ (^~ (~^ a b) c) d)');
    expect(sx(expr('a >>> 1 <<< 2'))).toBe('(<<< (>>> a 1) 2)');
  });

  it('is left associative everywhere but ?:, including ** (unlike SystemVerilog)', () => {
    expect(sx(expr('a ** b ** c'))).toBe('(** (** a b) c)');
    expect(sx(expr('a - b - c'))).toBe('(- (- a b) c)');
    expect(sx(expr('a / b % c'))).toBe('(% (/ a b) c)');
    expect(sx(expr('a ? b : c ? d : e'))).toBe('(? a b (? c d e))');
    expect(sx(expr('a ? b ? c : d : e'))).toBe('(? a (? b c d) e)');
    expect(sx(expr('a ? b : c + d'))).toBe('(? a b (+ c d))');
    expect(sx(expr('a || b ? c : d'))).toBe('(? (|| a b) c d)');
  });

  it('binds every unary operator, reductions and their negations included, tighter than ** and any binary operator', () => {
    for (const op of ['+', '-', '!', '~', '&', '~&', '|', '~|', '^', '~^', '^~']) expect(sx(expr(`${op}a ** b`))).toBe(`(** (${op} a) b)`);
    expect(sx(expr('-a ** -b'))).toBe('(** (- a) (- b))');
    expect(sx(expr('!a && ~b'))).toBe('(&& (! a) (~ b))');
    expect(sx(expr('~(a & b)'))).toBe('(~ (& a b))');
    expect(sx(expr('&a | &b'))).toBe('(| (& a) (& b))');
  });

  it('reads concatenations, replications and nested replications', () => {
    expect(sx(expr('{a, b[3], c[7:4]}'))).toBe('{a,b[3],c[7:4]}');
    expect(sx(expr('{4{a}}'))).toBe('{4{a}}');
    expect(sx(expr('{2{ {3{a}}, b }}'))).toBe('{2{{3{a}},b}}');
    expect(sx(expr('{n{a, b}}'))).toBe('{n{a,b}}');
    expect(sx(expr('{{2{a}}, {3{b}}}'))).toBe('{{2{a}},{3{b}}}');
    expect(sx(expr('{W{1\'b1}}'))).toBe("{W{1'b1}}");
    const nested = expr('{2{ {3{a}}, b }}') as A.ReplicateExpr;
    expect(nested.kind).toBe('replicate');
    expect(nested.inner.parts[0]!.kind).toBe('replicate');
  });

  it('reads bit, part, +: and -: selects on a name, and several dimensions', () => {
    expect(sx(expr('a[3]'))).toBe('a[3]');
    expect(sx(expr('a[7:0]'))).toBe('a[7:0]');
    expect(sx(expr('a[i +: 4]'))).toBe('a[i+:4]');
    expect(sx(expr('a[i*2 -: W]'))).toBe('a[(* i 2)-:W]');
    expect(sx(expr('m[i][j]'))).toBe('m[i][j]');
    expect(sx(expr('m[i][j][3:0]'))).toBe('m[i][j][3:0]');
    expect(sx(expr('m[i][j][k +: 2]'))).toBe('m[i][j][k+:2]');
    const e = expr('m[1][2][k -: 2]') as A.IndexExpr;
    expect([e.dims.length, e.mode]).toEqual([2, 'minus']);
    expect(sx(expr('top.u1.x[2]'))).toBe('top.u1.x[2]');
    expect(sx(expr('g[1].x'))).toBe('g[1].x');
  });

  it('reads calls, system calls, literals and min:typ:max', () => {
    expect(sx(expr('f(a, b + 1)'))).toBe('f(a,(+ b 1))');
    expect(sx(expr('top.u.f(a)'))).toBe('top.u.f(a)');
    expect(sx(expr('$clog2(N) + $signed(a)'))).toBe('(+ $clog2(N) $signed(a))');
    expect((expr('$time') as A.SysCallExpr).parens).toBe(false);
    expect((expr('$time()') as A.SysCallExpr).parens).toBe(true);
    expect(expr('1.5').kind).toBe('real');
    expect(expr('1e3').kind).toBe('real');
    expect(expr('2.5e-3').kind).toBe('real');
    expect(expr('"a b"').kind).toBe('string');
    for (const lit of ["8'sh7F", "'b1", "4'bx0z?", "'hFF_FF", "4 'd3", "8'o17", '12', '1_000'])
      expect(expr(lit), lit).toMatchObject({ kind: 'number', text: lit });
    expect(sx(expr('(1:2:3)'))).toBe('(1:2:3)');
  });

  it('keeps attributes on the operators and calls they precede', () => {
    const b = expr('a + (* keep *) b') as A.BinaryExpr;
    expect(b.attrs?.map((a) => a.name.name)).toEqual(['keep']);
    const u = expr('- (* x = 1 *) a') as A.UnaryExpr;
    expect(sx(u.attrs![0]!.value)).toBe('1');
    const t = expr('a ? (* p *) b : c') as A.TernaryExpr;
    expect(t.attrs).toHaveLength(1);
    const c = expr('f (* q *) (a)') as A.CallExpr;
    expect(c.attrs).toHaveLength(1);
  });
});

describe('statement shape', () => {
  it('binds else to the nearest if', () => {
    const s = stmtOf('if (a) if (b) x = 1; else y = 1;') as A.IfStmt;
    expect(s.else).toBeUndefined();
    const inner = s.then as A.IfStmt;
    expect(inner.kind).toBe('if');
    expect(inner.else?.kind).toBe('assign');
    const t = stmtOf('if (a) begin if (b) x = 1; end else y = 1;') as A.IfStmt;
    expect(t.else?.kind).toBe('assign');
    expect(t.then.kind).toBe('block');
    const chain = stmtOf('if (a) x = 1; else if (b) x = 2; else x = 3;') as A.IfStmt;
    expect((chain.else as A.IfStmt).else?.kind).toBe('assign');
  });

  it('reads every form of @ as an event control', () => {
    const star = (src: string) => {
      const m = moduleOf(`always ${src} x = y;`);
      return (m.items[0] as A.AlwaysBlock).events;
    };
    for (const form of ['@*', '@(*)', '@( * )', '@ (*)', '@ ( * )', '@(* )', '@( *)']) expect(star(form), form).toBe('star');
    const m = moduleOf('always @(posedge a or negedge b, c) x = y;');
    expect((m.items[0] as A.AlwaysBlock).events).toMatchObject([
      { edge: 'pos', expr: { name: 'a' } },
      { edge: 'neg', expr: { name: 'b' } },
      { edge: 'level', expr: { name: 'c' } },
    ]);
    const single = moduleOf('always @a x = y;');
    expect((single.items[0] as A.AlwaysBlock).events).toMatchObject([{ edge: 'level', expr: { name: 'a' } }]);
    const delay = moduleOf('always #5 x = ~x;').items[0] as A.AlwaysBlock;
    expect(delay.events).toBeUndefined();
    expect(delay.body.kind).toBe('timing');
  });

  it('reads intra-assignment delays and event controls', () => {
    const a = stmtOf('a = #5 b;') as A.AssignStmt;
    expect(a.control).toMatchObject({ kind: 'delay', delay: { values: [{ text: '5' }] } });
    const b = stmtOf('q <= @(posedge clk) d;') as A.AssignStmt;
    expect(b).toMatchObject({ blocking: false, control: { kind: 'event' } });
    const c = stmtOf('a = repeat (3) @(posedge clk) b;') as A.AssignStmt;
    expect(c.control).toMatchObject({ kind: 'repeatEvent', count: { text: '3' } });
  });

  it('reads named blocks with their declarations, and fork/join', () => {
    const s = stmtOf('begin : blk integer i; reg [3:0] r; i = 0; end') as A.BlockStmt;
    expect(s).toMatchObject({ kind: 'block', parallel: false, name: { name: 'blk' } });
    expect(s.decls.map((d) => d.kind)).toEqual(['netDecl', 'netDecl']);
    expect(s.stmts).toHaveLength(1);
    const f = stmtOf('fork : par #1 a = 1; #2 b = 1; join') as A.BlockStmt;
    expect(f).toMatchObject({ parallel: true, name: { name: 'par' } });
    expect(f.stmts.map((x) => x.kind)).toEqual(['timing', 'timing']);
  });

  it('reads case flavours, multiple labels, default with and without a colon, and empty items', () => {
    const s = stmtOf('casez (x) 2\'b1?, 2\'b01: a = 1; 2\'b00: ; default b = 1; endcase') as A.CaseStmt;
    expect(s.flavor).toBe('casez');
    expect(s.items.map((i) => i.labels?.length ?? 'default')).toEqual([2, 1, 'default']);
    expect(s.items[1]!.body.kind).toBe('empty');
    const d = stmtOf('case (x) default: a = 1; endcase') as A.CaseStmt;
    expect(d.items[0]!.labels).toBeUndefined();
  });

  it('reads loops, wait, trigger, disable, procedural continuous assignment and task calls', () => {
    expect(stmtOf('for (i = 0; i < 4; i = i + 1) a = i;')).toMatchObject({ kind: 'for', init: { lhs: { name: 'i' } } });
    expect(stmtOf('while (a < 3) a = a + 1;').kind).toBe('while');
    expect(stmtOf('repeat (4) @(posedge clk);').kind).toBe('repeat');
    expect(stmtOf('forever #5 clk = ~clk;').kind).toBe('forever');
    expect(stmtOf('wait (done) $finish;').kind).toBe('wait');
    expect(stmtOf('-> ev;').kind).toBe('trigger');
    expect(stmtOf('disable blk;')).toMatchObject({ kind: 'disable', target: { name: 'blk' } });
    expect(stmtOf('assign q = 1;')).toMatchObject({ kind: 'procAssign', op: 'assign' });
    expect(stmtOf('deassign q;')).toMatchObject({ kind: 'procAssign', op: 'deassign' });
    expect((stmtOf('deassign q;') as A.ProcAssignStmt).rhs).toBeUndefined();
    expect(stmtOf('force q = 1;')).toMatchObject({ op: 'force' });
    expect(stmtOf('release q;')).toMatchObject({ op: 'release' });
    expect(stmtOf('t;')).toMatchObject({ kind: 'taskCall', parens: false, args: [] });
    expect(stmtOf('t(a, b);')).toMatchObject({ kind: 'taskCall', parens: true, args: [{ name: 'a' }, { name: 'b' }] });
    expect(stmtOf('top.u.t(a);')).toMatchObject({ kind: 'taskCall', callee: { kind: 'hier' } });
    expect(stmtOf('$display("%d", a);')).toMatchObject({ kind: 'sysTask', name: '$display', args: [{ kind: 'string' }, { name: 'a' }] });
    expect((stmtOf('$display(, a);') as A.SysTaskStmt).args.map((a) => a?.kind ?? null)).toEqual([null, 'ident']);
    expect((stmtOf('$finish;') as A.SysTaskStmt).parens).toBe(false);
  });

  it('keeps attributes on statements', () => {
    const s = stmtOf('(* full_case *) case (x) default: ; endcase');
    expect(s.attrs?.map((a) => a.name.name)).toEqual(['full_case']);
  });
});

describe('declaration and item shape', () => {
  it('reads ANSI ports, letting a port inherit direction, type and range', () => {
    const m = moduleOf('', 'module m (input signed [7:0] a, b, output reg [3:0] q, r, inout w);');
    expect(m.portStyle).toBe('ansi');
    expect(m.ports.map((p) => [p.name.name, p.dir, p.net ?? '', p.signed, p.range ? sx(p.range.msb) : ''])).toEqual([
      ['a', 'input', '', true, '7'],
      ['b', 'input', '', true, '7'],
      ['q', 'output', 'reg', false, '3'],
      ['r', 'output', 'reg', false, '3'],
      ['w', 'inout', '', false, ''],
    ]);
  });

  it('reads a non-ANSI header: names, named port expressions, concatenations, empty slots', () => {
    const m = moduleOf('input a; output [3:0] y;', 'module m (a, .p(y[1:0]), {c, d}, );');
    expect(m.portStyle).toBe('nonansi');
    expect(m.portList.map((p) => [p.external?.name ?? '', p.braced, p.refs.map((r) => r.name.name).join('+')])).toEqual([
      ['', false, 'a'],
      ['p', false, 'y'],
      ['', true, 'c+d'],
      ['', false, ''],
    ]);
    expect(m.items.map((i) => i.kind)).toEqual(['portDecl', 'portDecl']);
  });

  it('reads parameter port lists, one assignment per entry, inheriting type and range', () => {
    const m = moduleOf('', 'module m #(parameter integer A = 1, B = 2, parameter [3:0] C = 4, D = (1:2:3)) ();');
    expect(m.paramPorts!.map((p) => [p.assigns[0]!.name.name, p.type ?? '', p.range ? 'range' : ''])).toEqual([
      ['A', 'integer', ''],
      ['B', 'integer', ''],
      ['C', '', 'range'],
      ['D', '', 'range'],
    ]);
    expect(m.paramPorts![3]!.assigns[0]!.value.kind).toBe('mintypmax');
  });

  it('reads net declarations: arrays, strengths, delays, assignments, signed', () => {
    const m = moduleOf(`
      reg signed [7:0] mem [0:3][0:3], one;
      wire (strong1, pull0) vectored [3:0] #(1,2,3) w = a & b, v = c;
      trireg (large) t;
      integer i = 0, j;
      event e1, e2[0:1];`);
    const [mem, w, t, i, ev] = m.items as A.NetDecl[];
    expect([mem!.net, mem!.signed, mem!.declarators.map((d) => d.dims.length)]).toEqual(['reg', true, [2, 0]]);
    expect([w!.drive, w!.vectored, w!.delay!.values.length, w!.declarators.map((d) => sx(d.init))]).toEqual([{ first: 'strong1', second: 'pull0' }, 'vectored', 3, ['(& a b)', 'c']]);
    expect(t!.charge).toBe('large');
    expect(i!.declarators.map((d) => [d.name.name, d.init ? 'init' : ''])).toEqual([['i', 'init'], ['j', '']]);
    expect(ev!.declarators.map((d) => d.dims.length)).toEqual([0, 1]);
  });

  it('reads continuous assignments with strengths and delays, splitting a list', () => {
    const m = moduleOf('assign (strong0, weak1) #3 y = a, z = b;');
    expect(m.items).toHaveLength(2);
    for (const it of m.items as A.ContinuousAssign[]) expect([it.drive, it.delay!.values.length]).toEqual([{ first: 'strong0', second: 'weak1' }, 1]);
  });

  it('reads gate primitives with names, arrays, delays and strengths, one node per instance', () => {
    const m = moduleOf('and (strong0, weak1) #(1,2) g1 (y, a, b), g2[3:0] (z, c, d); pullup (pull1) p (w); not (n, a);');
    const gates = m.items as A.GateInst[];
    expect(gates.map((g) => [g.gate, g.name?.name ?? '', g.range ? 'range' : '', g.terminals.length])).toEqual([
      ['and', 'g1', '', 3],
      ['and', 'g2', 'range', 3],
      ['pullup', 'p', '', 1],
      ['not', '', '', 2],
    ]);
    expect(gates[0]!.delay!.values).toHaveLength(2);
    expect(gates[2]!.drive).toEqual({ first: 'pull1' });
  });

  it('reads module instances: named and positional connections, overrides, arrays', () => {
    const m = moduleOf('sub #(.W(8), .D()) u (.a(x), .b(), .c(y[1:0])); sub #(8, 4) v[3:0] (p, , q), w (r);');
    const [u, v, w] = m.items as A.Instance[];
    expect(u!.params).toMatchObject({ style: 'named', items: [{ name: { name: 'W' } }, { name: { name: 'D' } }] });
    expect((u!.params as { items: A.NamedParamValue[] }).items[1]!.value).toBeUndefined();
    expect(u!.conns.map((c) => [c.port.name, c.expr ? 'expr' : 'none'])).toEqual([['a', 'expr'], ['b', 'none'], ['c', 'expr']]);
    expect([v!.range ? 'range' : '', v!.ordered!.map((c) => (c.expr ? 'e' : '_')), v!.params!.style]).toEqual(['range', ['e', '_', 'e'], 'ordered']);
    expect(w!.params).toEqual(v!.params);
  });

  it('reads generate for/if/case, named blocks and implicit scopes', () => {
    const m = moduleOf(`
      genvar i;
      generate
        for (i = 0; i < 4; i = i + 1) begin : gen
          assign y[i] = a[i];
        end
        if (W > 4) assign z = 1; else begin : tiny assign z = 0; end
        case (W) 1: assign q = 0; default: begin end endcase
      endgenerate
      for (i = 0; i < 2; i = i + 1) sub u (.a(a));`);
    expect(m.items.map((i) => i.kind)).toEqual(['genvarDecl', 'generateRegion', 'generateFor']);
    const region = m.items[1] as A.GenerateRegion;
    const [f, c, k] = region.items as [A.GenerateFor, A.GenerateIf, A.GenerateCase];
    expect([f.body.explicit, f.body.name?.name, f.body.items.length]).toEqual([true, 'gen', 1]);
    expect([c.then.explicit, c.then.items.length, c.else?.explicit, c.else?.name?.name]).toEqual([false, 1, true, 'tiny']);
    expect(k.items.map((i) => [i.labels?.length ?? 'default', i.body.explicit])).toEqual([[1, false], ['default', true]]);
    expect((m.items[2] as A.GenerateFor).body.explicit).toBe(false);
  });

  it('reads functions and tasks in both declaration styles', () => {
    const m = moduleOf(`
      function automatic signed [7:0] f (input [7:0] a, b); f = a; endfunction
      function integer g; input x; reg y; begin y = x; g = y; end endfunction
      function real h (input a); h = 1.0; endfunction
      task automatic t (input a, output [3:0] b, inout c); b = 0; endtask
      task u; input a; output b; begin b = a; end endtask
      task v; ; endtask`);
    const [f, g, h, t, u, v] = m.items as [A.FunctionDecl, A.FunctionDecl, A.FunctionDecl, A.TaskDecl, A.TaskDecl, A.TaskDecl];
    expect([f.automatic, f.signed, f.range ? 'range' : '', f.ansi, f.ports.map((p) => p.name.name)]).toEqual([true, true, 'range', true, ['a', 'b']]);
    expect([g.type, g.ansi, g.decls.map((d) => d.kind)]).toEqual(['integer', false, ['portDecl', 'netDecl']]);
    expect(h.type).toBe('real');
    expect([t.automatic, t.ports.map((p) => p.dir)]).toEqual([true, ['input', 'output', 'inout']]);
    expect([u.ansi, u.decls.map((d) => d.kind)]).toEqual([false, ['portDecl', 'portDecl']]);
    expect(v.body.kind).toBe('empty');
  });

  it('reads specparam and specify blocks, and keeps them', () => {
    const m = moduleOf(`
      specparam tRise = 1, tFall = (2:3:4);
      specify
        specparam d = 5;
        (a => y) = 1;
        (a, b *> y, z) = (1, 2);
        if (en) (posedge clk => (q +: d)) = (1, 2, 3);
        ifnone (a => y) = 2;
        $setup(d, posedge clk &&& en, 1);
        $hold(posedge clk, d, 2, ntf);
        $width(negedge clk, 5);
        $setuphold(posedge clk, d, 1, 2, , , dclk, dd);
        pulsestyle_onevent y;
        showcancelled y;
      endspecify`);
    expect(m.items.map((i) => i.kind)).toEqual(['specparamDecl', 'specify']);
    const sp = m.items[1] as A.SpecifyBlock;
    expect(sp.items.map((i) => i.kind)).toEqual(['specparamDecl', 'path', 'path', 'path', 'path', 'timingCheck', 'timingCheck', 'timingCheck', 'timingCheck', 'pulseStyle', 'pulseStyle']);
    const [, p1, p2, p3, p4, c1, , , c4] = sp.items as [unknown, A.PathDecl, A.PathDecl, A.PathDecl, A.PathDecl, A.TimingCheck, unknown, unknown, A.TimingCheck];
    expect([p1.connection, p1.inputs.length, p1.delays.length]).toEqual(['=>', 1, 1]);
    expect([p2.connection, p2.inputs.length, p2.outputs.length, p2.delays.length]).toEqual(['*>', 2, 2, 2]);
    expect([p3.cond?.kind, p3.edge, p3.outPolarity, sx(p3.dataSource)]).toEqual(['if', 'posedge', '+', 'd']);
    expect(p4.cond).toEqual({ kind: 'ifnone' });
    expect(c1.args[1]).toMatchObject({ edge: 'posedge', cond: { name: 'en' } });
    expect(c4.args.map((a) => a === null)).toEqual([false, false, false, false, true, true, false, false]);
  });

  it('reads user-defined primitives: combinational, sequential level and edge, both header styles', () => {
    const r = parseSource(`
      primitive mux (output y, input a, b, s);
        table
          0 ? 0 : 0;
          1 ? 0 : 1;
          ? 0 1 : 0;
        endtable
      endprimitive
      primitive dff (q, d, clk);
        output q; reg q; input d, clk;
        initial q = 1'b0;
        table
          0 (01) : ? : 0;
          1 (01) : ? : 1;
          ? (1?) : ? : -;
          * ? : ? : -;
          ? r : 0 : x;
        endtable
      endprimitive`);
    expect(r.diags.map(formatDiagnostic)).toEqual([]);
    const [mux, dff] = r.file.units as A.UdpDecl[];
    expect([mux!.ansi, mux!.sequential, mux!.ports.map((p) => p.name.name), mux!.entries.length]).toEqual([true, false, ['y', 'a', 'b', 's'], 3]);
    expect(mux!.entries[2]).toMatchObject({ inputs: ['?', '0', '1'], next: '0' });
    expect([dff!.ansi, dff!.sequential, dff!.names.map((n) => n.name), dff!.decls.map((d) => d.kind), dff!.init?.name.name]).toEqual([false, true, ['q', 'd', 'clk'], ['output', 'reg', 'input'], 'q']);
    expect(dff!.entries.map((e) => [e.inputs, e.current, e.next])).toEqual([
      [['0', '(01)'], '?', '0'],
      [['1', '(01)'], '?', '1'],
      [['?', '(1?)'], '?', '-'],
      [['*', '?'], '?', '-'],
      [['?', 'r'], '0', 'x'],
    ]);
  });

  it('reads configurations', () => {
    const r = parseSource('config cfg; design work.top lib2.other; default liblist l1 l2; instance top.u1 use l3.m:config; cell m liblist l4; cell l5.n use l6.n; endconfig');
    expect(r.diags.map(formatDiagnostic)).toEqual([]);
    const cfg = r.file.units[0] as A.ConfigDecl;
    expect(cfg.design).toHaveLength(2);
    expect(cfg.rules.map((x) => x.kind)).toEqual(['default', 'instance', 'cell', 'cell']);
  });

  it('keeps attributes on modules, ports, items and instances', () => {
    const r = parseSource('(* top, depth = 3 *) module m ((* p *) input a); (* keep *) wire w; (* synth *) assign w = a; (* x *) sub u (.a(a)); endmodule');
    expect(r.diags.map(formatDiagnostic)).toEqual([]);
    const m = r.file.modules[0]!;
    expect(m.attrs!.map((a) => a.name.name)).toEqual(['top', 'depth']);
    expect(m.ports[0]!.attrs!.map((a) => a.name.name)).toEqual(['p']);
    expect(m.items.map((i) => i.attrs?.[0]?.name.name)).toEqual(['keep', 'synth', 'x']);
    expect(parseSource('module m; (* a *) (* b, c *) wire w; endmodule').file.modules[0]!.items[0]!.attrs!.map((a) => a.name.name)).toEqual(['a', 'b', 'c']);
  });

  it('puts the part of a file in module, primitive and config order, with spans on the original text', () => {
    const r = parseSource('module a; endmodule\nprimitive p (output y, input x); table 0 : 1; endtable endprimitive\nmodule b; endmodule');
    expect(r.file.units.map((u) => u.kind)).toEqual(['module', 'udp', 'module']);
    expect(r.file.modules.map((m) => m.name.name)).toEqual(['a', 'b']);
    expect(r.file.modules[1]!.span).toMatchObject({ line: 3, col: 1 });
  });
});

// ---------------------------------------------------------------- errors

describe('invalid input', () => {
  const cases: [string, string, number, number, string][] = [
    ['an operator with no right operand', 'module m; assign y = a +; endmodule', 1, 25, "Expected an expression, but found ';'."],
    ['two unary operators in a row', 'module m; assign y = ~~a; endmodule', 1, 23, 'The operand of a unary operator must be a primary (IEEE 1364-2005 section 5.1.5), not another operator. Write ~(~x) with parentheses.'],
    ['a minus after a reduction', 'module m; assign y = &-a; endmodule', 1, 23, 'The operand of a unary operator must be a primary (IEEE 1364-2005 section 5.1.5), not another operator. Write &(-x) with parentheses.'],
    ['a range that is never closed', 'module m; wire [3:0 w; endmodule', 1, 21, "Expected ']' to close the range, but found 'w'."],
    ['a parenthesis that is never closed', 'module m; assign y = (a + b; endmodule', 1, 28, "Expected ')' to close the parenthesis, but found ';'."],
    ['an event list that is never closed', 'module m; always @(posedge clk begin q <= 1; end endmodule', 1, 32, "Expected ')' to close the event list that starts at line 1, but found 'begin'."],
    ['an else with no if', 'module m; always @(posedge clk) else q <= 1; endmodule', 1, 33, "This 'else' has no matching 'if'."],
    ['a begin that is never closed', 'module m;\n initial begin\n  x = 1;\nendmodule', 2, 10, "This 'begin' is never closed. Add 'end'."],
    ['a case that is never closed', 'module m;\n initial case (a)\n  1: x = 1;\nendmodule', 2, 10, "This 'case' is never closed. Add 'endcase'."],
    ['an end that closes a fork', 'module m;\n initial fork x = 1;\n end\nendmodule', 3, 2, "This 'end' does not close a 'begin'. A 'fork' block ends with 'join'."],
    ['a declaration in an unnamed block', 'module m;\n initial begin\n  integer i;\n  i = 0;\n end\nendmodule', 3, 3, "Declarations inside 'begin' need a block name. Write 'begin : name' before them."],
    ['a number where the module name goes', 'module 1m; endmodule', 1, 8, "Expected a name after 'module', but found '1'."],
    ['a continuous assignment with no target', 'module m; assign = 1; endmodule', 1, 18, "Expected the target of an assignment, but found '='."],
    ['a generate for with a missing semicolon', 'module m; generate for (i = 0; i < 2 i = i + 1) begin end endgenerate endmodule', 1, 38, "Expected ';' after the loop condition, but found 'i'."],
    ['a function that is never closed', 'module m;\n function f; input a; f = a;\nendmodule', 3, 1, "Expected 'endfunction' to end the function 'f', but found 'endmodule'."],
    ['an output port on a function', 'module m; function f(output a); f = 1; endfunction endmodule', 1, 22, "A function can only have 'input' ports, not 'output'."],
    ['a bad next state in a primitive table', 'primitive p (output y, input a);\n table\n 0 : 1 : 2;\n endtable\nendprimitive', 3, 2, "'2' is not a valid next state. Use one of 0 1 x -."],
    ['a declaration before any module', 'wire x;\nmodule m; endmodule', 1, 1, "Expected 'module' at the top level, but found 'wire'."],
    ['a drive strength with two strengths for 0', 'module m; and (strong0, weak0) g (y, a, b); endmodule', 1, 15, 'A drive strength needs one strength for 0 and one for 1, for example (strong0, weak1).'],
    ['a part select with three parts', 'module m; assign y = a[1:2:3]; endmodule', 1, 27, "Expected ']' to close the '[', but found ':'."],
    ['min:typ:max with two parts', 'module m; assign y = (1:2); endmodule', 1, 26, "Expected ':' after the typical value in 'min : typ : max', but found ')'."],
    ['an array with an initial value', 'module m; reg [3:0] mem [0:3] = 0; endmodule', 1, 31, "An array 'mem' cannot be given a value where it is declared."],
    ['an instance with no semicolon', 'module m; sub u (.a(x)) endmodule', 1, 25, "Expected ';' at the end of the instance, but found 'endmodule'."],
    ['a defparam with no equals sign', 'module m; defparam u.W 8; endmodule', 1, 24, "Expected '=' after the parameter name, but found '8'."],
    ['an attribute that is never closed', 'module m; (* a wire w; endmodule', 1, 16, "Expected '*)' to close the attribute that starts at line 1, but found 'wire'."],
    ['a part select followed by another select', 'module m; assign y = a[1:0][2]; endmodule', 1, 24, 'Only the last select of a name can be a part select. Earlier ones must be single indexes.'],
    ['a trailing comma in a port list', 'module m (input a, output y, ); endmodule', 1, 30, "Expected 'input', 'output' or 'inout' to declare a port, but found ')'."],
    ['a ternary with no colon', 'module m; assign a = b ? c; endmodule', 1, 27, "Expected ':' in the '?:' expression, but found ';'."],
    ['a delay with no value', 'module m; initial #; endmodule', 1, 20, "Expected a delay value (a number, a name, or '(...)') after '#', but found ';'."],
  ];
  for (const [what, src, line, col, message] of cases) {
    it(`reports ${what} at ${line}:${col}`, () => {
      const r = parseSource(src);
      expect(r.diags[0], formatDiagnostic(r.diags[0] ?? { severity: 'error', code: 'syntax-error', message: '(no diagnostic)', span: { start: 0, end: 0, line: 0, col: 0 } })).toMatchObject({
        severity: 'error',
        code: 'syntax-error',
        message,
        span: { line, col },
      });
    });
  }

  it('reports a lexer error with its own code, at the character', () => {
    const r = parseSource('module m; initial x = "abc; endmodule');
    expect(r.diags[0]).toMatchObject({ code: 'lex-error', message: 'This string is never closed. Add a closing quote.', span: { line: 1, col: 23 } });
  });

  describe('does not cascade', () => {
    const count = (src: string) => parseSource(src).diags.map(formatDiagnostic);

    it('gives one diagnostic for one mistake, and still parses what follows', () => {
      const r = parseSource(`module m (input a, output y);
  always @(posedge clk) begin
    if (a) q <= 1 +;
    q <= 0;
  end
  assign y = a;
  wire w;
endmodule`);
      expect(r.diags).toHaveLength(1);
      const m = r.file.modules[0]!;
      expect(m.items.map((i) => i.kind)).toEqual(['always', 'continuousAssign', 'netDecl']);
      expect(((m.items[0] as A.AlwaysBlock).body as A.BlockStmt).stmts).toHaveLength(1);
    });

    it('does not report the blocks around an unclosed one again', () => {
      expect(count('module m;\n initial begin\n  case (a)\n   1: x = 1;\nendmodule')).toHaveLength(1);
      expect(count('module m;\n initial fork\n  x = 1;\n end\nendmodule')).toHaveLength(1);
      expect(count('module m;\n initial begin\n integer i;\n i = 0;\n end\nendmodule')).toHaveLength(1);
    });

    it('skips a broken function or task as a unit', () => {
      const r = parseSource('module m;\n function f(output a); f = 1; endfunction\n task t; input; endtask\n assign y = a;\nendmodule');
      expect(r.diags).toHaveLength(2);
      expect(r.file.modules[0]!.items.map((i) => i.kind)).toEqual(['continuousAssign']);
    });

    it('reports nothing after a lexer error that already says what is wrong', () => {
      expect(count('module m;\n initial x = "abc;\nendmodule')).toHaveLength(1);
      expect(count('module m; initial x = $; endmodule')).toHaveLength(1);
    });

    it('reports two mistakes in two places as two diagnostics, in order', () => {
      const d = parseSource('module a (input x);\n assign y = ;\nendmodule\nmodule b (input x);\n wire [1:0 w;\nendmodule').diags;
      expect(d.map((x) => x.span.line)).toEqual([2, 5]);
    });

    it('recovers inside a generate block, a case, a specify block and a primitive table', () => {
      const g = parseSource('module m;\n generate\n  assign a = ;\n  assign b = c;\n endgenerate\n wire w;\nendmodule');
      expect(g.diags).toHaveLength(1);
      expect((g.file.modules[0]!.items[0] as A.GenerateRegion).items).toHaveLength(1);
      expect(g.file.modules[0]!.items).toHaveLength(2);
      const c = parseSource('module m;\n initial case (a)\n  1: x = ;\n  2: x = 1;\n endcase\nendmodule');
      expect(c.diags).toHaveLength(1);
      expect(((c.file.modules[0]!.items[0] as A.InitialBlock).body as A.CaseStmt).items).toHaveLength(1);
      const s = parseSource('module m;\n specify\n  (a => b) = ;\n  (c => d) = 1;\n endspecify\nendmodule');
      expect(s.diags).toHaveLength(1);
      expect((s.file.modules[0]!.items[0] as A.SpecifyBlock).items).toHaveLength(1);
      const t = parseSource('primitive p (output y, input a);\n table\n 0 : 2;\n 1 : 0;\n endtable\nendprimitive\nmodule m; endmodule');
      expect(t.diags).toHaveLength(1);
      expect(t.file.units.map((u) => u.kind)).toEqual(['udp', 'module']);
    });
  });
});

describe('limits and speed', () => {
  it('keeps the depth limit of 500 for nesting, and walks long chains in a loop', () => {
    const deep = parseSource(`module m; assign y = ${'('.repeat(600)}a${')'.repeat(600)}; endmodule`);
    expect(deep.diags.map((d) => d.code)).toEqual(['too-deep']);
    const stmts = parseSource(`module m; initial ${'begin '.repeat(600)} x = 1; ${'end '.repeat(600)} endmodule`);
    expect(stmts.diags.map((d) => d.code)).toEqual(['too-deep']);
    const chain = parseSource(`module m; assign y = ${Array(20000).fill('a').join(' + ')}; endmodule`);
    expect(chain.diags).toEqual([]);
    expect(print(chain.file).length).toBeGreaterThan(40000);
  });

  it('parses 10,000 lines well inside a generous bound', () => {
    const unit = (n: number) => `module m${n} #(parameter W = 8) (input clk, input rst, input [W-1:0] a, b, output reg [W-1:0] q, output [W:0] s);
  wire [W-1:0] t1, t2;
  reg [3:0] state;
  assign s = a + b + {1'b0, t1} - (a & b | ~t2) ^ {W{1'b1}};
  assign t1 = a[W-1:0] & b[3 +: 4];
  always @(posedge clk or negedge rst) begin
    if (!rst) q <= 0;
    else begin
      case (state)
        4'd0: q <= a;
        4'd1: q <= b;
        default: q <= q + 1;
      endcase
      for (i = 0; i < 4; i = i + 1) q[i] <= a[i] ^ b[i];
    end
  end
  sub #(.W(W)) u (.a(a), .b(b), .y(t2));
endmodule
`;
    const src = Array.from({ length: 590 }, (_, i) => unit(i)).join('');
    expect(src.split('\n').length).toBeGreaterThanOrEqual(10000);
    parseSource(src);
    const t0 = performance.now();
    const r = parseSource(src);
    const ms = performance.now() - t0;
    expect(r.diags).toEqual([]);
    expect(r.file.modules).toHaveLength(590);
    expect(ms).toBeLessThan(1000);
  });
});
