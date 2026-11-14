import { describe, expect, it } from 'vitest';
import { compile, formatDiagnostic } from '../src';
import { parseNumber } from '../src/number';
import { design, sim } from './ir-eval';

const errors = (src: string, top?: string) => compile(src, { top }).diagnostics.filter((d) => d.severity === 'error');
const codes = (src: string, top?: string) => compile(src, { top }).diagnostics.map((d) => d.code);
const messages = (src: string) => compile(src).diagnostics.map((d) => d.message);

describe('if (x) on a reg that has no reset (B1)', () => {
  const unreset = `module m (input clk, input a, output reg [3:0] r, output reg c);
  always @(posedge clk) begin
    c <= a;
    if (c) r <= 4'd1; else r <= 4'd2;
  end
endmodule`;

  it('warns that the circuit and a Verilog simulator can disagree, and still compiles', () => {
    const r = compile(unreset);
    expect(r.design).toBeDefined();
    const w = r.diagnostics.filter((d) => d.code === 'if-unknown-condition');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'warning', span: { line: 4 } });
    expect(w[0]!.message).toBe(
      '`c` has no reset, so until it is first written it is unknown. A Verilog simulator then takes the else branch, but real hardware (and this circuit) could go either way. Give `c` a reset value to make both agree.',
    );
  });

  it('follows the condition through combinational logic in the same module', () => {
    const src = `module m (input clk, input a, input b, output reg y);
  reg c;
  wire t;
  assign t = c & b;
  always @(posedge clk) begin
    c <= a;
    if (t) y <= 1'b1; else y <= 1'b0;
  end
endmodule`;
    expect(compile(src).diagnostics.filter((d) => d.code === 'if-unknown-condition').map((d) => d.message.split(' ')[0])).toEqual(['`c`']);
  });

  it('is quiet when the reg is reset under an if, or reset through ?:', () => {
    const viaIf = `module m (input clk, input rst, input a, output reg [3:0] r, output reg c);
  always @(posedge clk) begin
    if (rst) c <= 1'b0; else c <= a;
    if (c) r <= 4'd1; else r <= 4'd2;
  end
endmodule`;
    const viaTernary = `module m (input clk, input rst, input a, output reg [3:0] r, output reg c);
  always @(posedge clk) begin
    c <= rst ? 1'b0 : a;
    if (c) r <= 4'd1; else r <= 4'd2;
  end
endmodule`;
    expect(codes(viaIf)).not.toContain('if-unknown-condition');
    expect(codes(viaTernary)).not.toContain('if-unknown-condition');
  });

  it('is quiet when the condition depends only on inputs, and for ?: conditions', () => {
    const src = `module m (input clk, input a, output reg [3:0] r, output reg [3:0] s);
  reg c;
  always @(posedge clk) begin
    c <= a;
    if (a) r <= 4'd1; else r <= 4'd2;
    s <= c ? 4'd1 : 4'd2;
  end
endmodule`;
    expect(codes(src)).not.toContain('if-unknown-condition');
  });
});

describe('an expression on an instance input port is self-determined (B2)', () => {
  const sub = 'module sub8 (input [7:0] a, output [7:0] y);\n assign y = a;\nendmodule\n';
  const run = (expr: string, p: number, q: number, c = 0) => {
    const s = sim(`${sub}module m (input [3:0] p, input [3:0] q, input c, output [7:0] y);\n sub8 u (.a(${expr}), .y(y));\nendmodule`, 'm');
    return s.set('p', p).set('q', q).set('c', c).get('y');
  };

  it('p + q loses the carry before it is zero-extended', () => {
    expect(run('p + q', 15, 6)).toBe(5n);
  });

  it('~p is complemented at its own width, so the upper bits are 0', () => {
    expect(run('~p', 5, 0)).toBe(10n);
  });

  it('c ? p + q : q picks self-determined branches', () => {
    expect(run('c ? p + q : q', 15, 6, 1)).toBe(5n);
    expect(run('c ? p + q : q', 15, 6, 0)).toBe(6n);
  });

  it('truncates when the port is narrower than the expression', () => {
    const s = sim(`module sub2 (input [1:0] a, output [1:0] y);\n assign y = a;\nendmodule\nmodule m (input [3:0] p, output [1:0] y);\n sub2 u (.a(p), .y(y));\nendmodule`, 'm');
    expect(s.set('p', 0b1110).get('y')).toBe(0b10n);
  });
});

describe('multiple drivers are found per net, whatever the order (B3)', () => {
  const driverErrors = (body: string) => errors(`module m (input clk, input a, input d, output w);\n reg r;\n${body}\nendmodule`).filter((e) => e.code === 'multiple-drivers');

  it('assign w = a; assign w = r; with r written in an always block', () => {
    const e = driverErrors(' assign w = a;\n assign w = r;\n always @(posedge clk) r <= d;');
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain("'w'");
  });

  it('the mirror order', () => {
    const e = driverErrors(' always @(posedge clk) r <= d;\n assign w = r;\n assign w = a;');
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain("'w'");
  });

  it('two regs aliased to one wire', () => {
    const e = errors(`module m (input clk, input d, output w);
 reg r1;
 reg r2;
 always @(posedge clk) begin r1 <= d; r2 <= d; end
 assign w = r1;
 assign w = r2;
endmodule`).filter((x) => x.code === 'multiple-drivers');
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain("'w'");
  });

  it('a reg aliased with an instance output', () => {
    const e = errors(`module sub (output y);\n assign y = 1'b1;\nendmodule
module m (input clk, input d, output w);
 reg r;
 always @(posedge clk) r <= d;
 sub u (.y(w));
 assign w = r;
endmodule`, 'm').filter((x) => x.code === 'multiple-drivers');
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain("'w'");
  });

  it('an identical duplicate assign is an error too', () => {
    const e = driverErrors(' assign w = a;\n assign w = a;');
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain("'w'");
  });

  it('two instances driving one wire', () => {
    const e = errors(`module sub (output y);\n assign y = 1'b1;\nendmodule
module m (output w);\n sub u1 (.y(w));\n sub u2 (.y(w));\nendmodule`, 'm').filter((x) => x.code === 'multiple-drivers');
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain("'w'");
  });

  it('two always blocks assigning one reg says each reg needs exactly one always block', () => {
    const e = errors(`module m (input clk, input d, output reg q);
 always @(posedge clk) q <= d;
 always @(posedge clk) q <= ~d;
endmodule`);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ code: 'multiple-drivers' });
    expect(e[0]!.message).toContain('exactly one always block');
    expect(e[0]!.message).toContain("'q'");
  });

  it('several assigns reading one source are fine', () => {
    expect(errors('module m (input a, output x, output y);\n assign x = a;\n assign y = a;\nendmodule')).toEqual([]);
  });
});

describe('deep or long input never overflows the stack (B7)', () => {
  const wrap = (expr: string) => `module m (input [3:0] a, output [3:0] y);\n assign y = ${expr};\nendmodule`;

  it('5,000 nested parentheses give too-deep, not an exception', () => {
    const r = compile(wrap(`${'('.repeat(5000)}a${')'.repeat(5000)}`));
    expect(r.design).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toEqual(['too-deep']);
    expect(r.diagnostics[0]!.message).toContain('500');
  });

  it('nesting just under the limit still compiles', () => {
    expect(errors(wrap(`${'('.repeat(400)}a${')'.repeat(400)}`))).toEqual([]);
  });

  it('a 10,000-term a+a+... chain compiles', () => {
    const r = compile(wrap(Array(10000).fill('a').join(' + ')));
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.design!.modules[0]!.cells.filter((c) => c.kind === 'add')).toHaveLength(9999);
  });

  it('a long chain keeps its meaning', () => {
    const s = sim(wrap(Array(2000).fill('a').join(' + ')));
    expect(s.set('a', 3).get('y')).toBe(BigInt((3 * 2000) % 16));
  }, 30_000);

  it('a long chain of mixed operators with a trailing comparison compiles', () => {
    const src = `module m (input [3:0] a, input [3:0] b, output y);\n assign y = ${Array(3000).fill('a ^ b').join(' | ')} == 4'd0;\nendmodule`;
    expect(errors(src)).toEqual([]);
  });

  it('a 600-long == chain and 600 nested ternaries give too-deep', () => {
    expect(codes(wrap(`${Array(600).fill('a').join(' == ')}`))).toEqual(['too-deep']);
    expect(codes(wrap(`${Array(600).fill('a ? a :').join(' ')} a`))).toEqual(['too-deep']);
  });

  it('5,000 nested begin blocks and a 2,000-long else-if chain give too-deep', () => {
    const blocks = `module m (input clk, input a, output reg y);\n always @(posedge clk) ${'begin '.repeat(5000)}y <= a;${' end'.repeat(5000)}\nendmodule`;
    expect(codes(blocks)).toEqual(['too-deep']);
    const chain = `module m (input clk, input a, output reg y);\n always @(posedge clk) ${Array(2000).fill('if (a) y <= 1\'b1; else').join(' ')} y <= 1'b0;\nendmodule`;
    expect(codes(chain)).toEqual(['too-deep']);
  });

  it('an internal failure becomes an internal-error diagnostic, never an exception', () => {
    const hostile = {
      get top(): string {
        throw new Error('boom');
      },
    };
    const r = compile(wrap('a'), hostile);
    expect(r.design).toBeUndefined();
    expect(r.diagnostics).toMatchObject([{ severity: 'error', code: 'internal-error' }]);
    expect(r.diagnostics[0]!.message).toContain('boom');
  });
});

describe('huge literals (B8)', () => {
  it('caps the size at 65,536 bits before building anything', () => {
    expect(parseNumber("65536'd1").ok).toBe(true);
    expect(parseNumber("65537'd1")).toMatchObject({ ok: false, kind: 'too-large' });
    expect(parseNumber("99999999999999999999'b1")).toMatchObject({ ok: false, kind: 'too-large' });
  });

  it('caps the digits of an unsized or sized number without expanding them', () => {
    const t0 = performance.now();
    expect(parseNumber('1'.repeat(2_000_000))).toMatchObject({ ok: false, kind: 'too-large' });
    expect(parseNumber(`4'h${'F'.repeat(1_000_000)}`)).toMatchObject({ ok: false, kind: 'too-large' });
    expect(parseNumber(`4'd${'9'.repeat(1_000_000)}`)).toMatchObject({ ok: false, kind: 'too-large' });
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('reports a diagnostic with a short message', () => {
    const r = compile("module m (output y);\n assign y = 4000000000'd1;\nendmodule");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ code: 'literal-too-large' });
    expect(r.diagnostics[0]!.message.length).toBeLessThan(160);
  });
});

describe('diagnostics (B9)', () => {
  it('replication inside a concatenation builds the repeated bits', () => {
    const y = (e: string, a: number) => sim(`module m (input [3:0] a, output [7:0] y);\n assign y = ${e};\nendmodule`).set('a', a).get('y');
    expect(y('{2{a}}', 0x9)).toBe(0x99n);
    expect(y('{a, {1{a}}}', 0x5)).toBe(0x55n);
    expect(y('{4{a[1:0]}}', 0x6)).toBe(0xaan);
  });

  describe('a literal with more digits than 32 bits hold', () => {
    const wide = (cmp: string) => `module m (input [3:0] a, output y);\n assign y = ${cmp};\nendmodule`;

    it('is accepted in a comparison when its value fits', () => {
      expect(errors(wide("a == 'h000000000"))).toEqual([]);
      const s = sim(wide("a == 'h000000000"));
      expect(s.set('a', 0).get('y')).toBe(1n);
      expect(s.set('a', 5).get('y')).toBe(0n);
      expect(sim(wide("'h000000007 != a")).set('a', 7).get('y')).toBe(0n);
    });

    it('is compared at its full width, so a value needing more than 32 bits is never equal to a narrower operand', () => {
      expect(errors(wide("a == 'h100000000"))).toEqual([]);
      expect(sim(wide("a == 'h100000000")).set('a', 15).get('y')).toBe(0n);
      expect(sim(wide("a != 'h100000000")).set('a', 15).get('y')).toBe(1n);
    });

    it('lets ~ put ones above bit 31, because the literal widens the whole comparison', () => {
      const s = sim(wide("~a == 'h000000000"));
      for (const v of [0, 5, 15]) expect(s.set('a', v).get('y')).toBe(0n);
      const t = sim(wide("a + a == 'h000000000"));
      expect(t.set('a', 0).get('y')).toBe(1n);
      expect(t.set('a', 8).get('y')).toBe(0n);
    });

    it('carries out of bit 31 into the upper half', () => {
      const s = sim("module m (input [31:0] a, input [31:0] b, output y);\n assign y = a + b == 'h100000000;\nendmodule");
      expect(s.set('a', 0xffffffff).set('b', 1).get('y')).toBe(1n);
      expect(s.set('a', 1).set('b', 1).get('y')).toBe(0n);
      expect(s.set('a', 0x80000000).set('b', 0x80000000).get('y')).toBe(1n);
    });

    it('is rejected beyond 64 bits', () => {
      expect(codes(wide("a == 'h00000000000000000"))).toEqual(['width-limit']);
    });
  });

  it('declares a signal whose range failed, so later uses are not reported as undeclared', () => {
    const r = compile(`module m (input a, output y, output z);
 wire [40:0] big;
 assign y = big[2];
 assign z = big;
endmodule`);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['width-limit']);
    const port = compile('module m (input [40:0] a, output y);\n assign y = a[0];\nendmodule');
    expect(port.diagnostics.map((d) => d.code)).toEqual(['width-limit']);
  });

  it('an instance of a module with a rejected port is not reported twice', () => {
    const r = compile(`module sub (input [40:0] a, output y);\n assign y = 1'b1;\nendmodule
module m (input x, output y);\n sub u (.a(x), .y(y));\nendmodule`);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['width-limit']);
  });

  it('posedge clk[0] is a one-bit clock, and attributes are accepted', () => {
    const sel = compile('module m (input [1:0] clk, input d, output reg q);\n always @(posedge clk[0]) q <= d;\nendmodule');
    expect(sel.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(sel.diagnostics.map((d) => d.code)).not.toContain('gated-clock');
    const attr = compile('module m (input a, output y);\n (* keep *) wire w;\n assign w = a;\n assign y = w;\nendmodule');
    expect(attr.diagnostics).toEqual([]);
    expect(codes('(* top *) module m (input a, output y);\n assign y = a;\nendmodule')).toEqual([]);
  });

  it('keeps @(*) and (*) readable as an event list', () => {
    const r = compile('module m (input a, output reg y);\n always @(*) y = a;\nendmodule');
    expect(r.diagnostics).toEqual([]);
    const s = sim('module m (input a, output reg y);\n always @(*) y = ~a;\nendmodule');
    expect(s.set('a', 0).get('y')).toBe(1n);
  });

  describe('a mistake in one module does not hide the others', () => {
    const good = 'module good (input a, output y);\n assign y = nope;\nendmodule\n';

    it('a syntax error elsewhere', () => {
      const r = compile(`module bad (input a, output y);\n assign y = ;\nendmodule\n${good}`);
      expect(r.diagnostics.map((d) => [d.code, d.span.line])).toEqual([
        ['syntax-error', 2],
        ['undeclared', 5],
      ]);
    });

    it('a "not supported yet" elsewhere', () => {
      const r = compile(`module bad (input a, output y);\n real r;\n assign y = a;\nendmodule\n${good}`);
      expect(r.diagnostics.map((d) => [d.code, d.span.line])).toEqual([
        ['not-supported', 2],
        ['undeclared', 6],
      ]);
    });

    it('an unsupported module header, whose instance is not "unknown"', () => {
      const r = compile(`module old (inout a, output y);\n assign y = 1'b1;\nendmodule\nmodule top (input a, output y);\n old u (.a(a), .y(y));\n assign y = nope;\nendmodule`);
      expect(r.diagnostics.map((d) => d.code)).toEqual(['not-supported', 'undeclared']);
    });

    it('a module that does not parse is still usable by its instances', () => {
      const r = compile(`module bad (input a, output y);\n assign y = ;\nendmodule\nmodule top (input a, output y);\n bad u (.a(a), .y(y));\nendmodule`);
      expect(r.diagnostics.map((d) => d.code)).toEqual(['syntax-error']);
    });
  });

  it('a byte order mark is skipped', () => {
    const r = compile('﻿module m (input a, output y);\n assign y = a;\nendmodule');
    expect(r.diagnostics).toEqual([]);
    expect(r.design).toBeDefined();
    const bad = (prefix: string) => compile(`${prefix}module m (input a, output y);\n assign y = nope;\nendmodule`).diagnostics[0]!.span;
    expect(bad('\uFEFF')).toMatchObject({ line: bad('').line, col: bad('').col });
    const first = (prefix: string) => compile(`${prefix}module m (input a, output y, output y);\nendmodule`).diagnostics[0]!.span;
    expect(first('\uFEFF').col).toBe(first('').col);
  });

  it('a lone carriage return ends a line for spans, as does CRLF', () => {
    const line = (eol: string) => compile(`module m (input a, output y);${eol} assign y = ;${eol}endmodule`).diagnostics[0]!.span.line;
    expect(line('\r')).toBe(2);
    expect(line('\r\n')).toBe(2);
    expect(line('\n')).toBe(2);
    const comment = compile('module m (input a, output y); // note\r assign y = ;\rendmodule');
    expect(comment.diagnostics.map((d) => d.span.line)).toEqual([2]);
  });

  it('shortens a long literal in messages', () => {
    const lit = `4'h${'F'.repeat(500)}`;
    const m = messages(`module m (output [3:0] y);\n assign y = ${lit};\nendmodule`);
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('…');
    expect(m[0]!.length).toBeLessThan(120);
    const bad = messages(`module m (output [3:0] y);\n assign y = 4'${'q'.repeat(500)};\nendmodule`);
    expect(bad.join('').length).toBeLessThan(300);
  });

  it('formatDiagnostic still works on the new codes', () => {
    const r = compile('module m (input a, output y);\n assign y = ~~a;\nendmodule');
    expect(formatDiagnostic(r.diagnostics[0]!)).toMatch(/^2:\d+: error \[syntax-error\]/);
  });
});

describe('as strict as the standard (B10)', () => {
  it('~~a is rejected with a hint to write ~(~a)', () => {
    for (const e of ['~~a', '~-a', '!~a', '- -a']) {
      const r = compile(`module m (input [3:0] a, output [3:0] y);\n assign y = ${e};\nendmodule`);
      expect(r.diagnostics[0], e).toMatchObject({ code: 'syntax-error' });
      expect(r.diagnostics[0]!.message, e).toContain('must be a primary');
    }
    expect(compile('module m (input [3:0] a, output [3:0] y);\n assign y = ~~a;\nendmodule').diagnostics[0]!.message).toContain('Write ~(~x)');
    expect(errors('module m (input [3:0] a, output [3:0] y);\n assign y = ~(~a);\nendmodule')).toEqual([]);
    expect(errors('module m (input [3:0] a, input [3:0] b, output [3:0] y);\n assign y = a & ~b;\nendmodule')).toEqual([]);
  });

  it('a bit-select of a scalar is an error, of a one-bit vector is not', () => {
    const scalar = compile('module m (input a, output y);\n assign y = a[0];\nendmodule');
    expect(scalar.diagnostics).toMatchObject([{ code: 'bad-select' }]);
    expect(scalar.diagnostics[0]!.message).toContain('scalar');
    expect(codes('module m (input a, output y);\n wire w;\n assign w = a;\n assign y = w[0];\nendmodule')).toEqual(['bad-select']);
    expect(errors('module m (input [0:0] a, output y);\n assign y = a[0];\nendmodule')).toEqual([]);
  });

  it('a net used before its declaration is an error', () => {
    const r = compile('module m (input a, output y);\n assign y = w;\n wire w;\n assign w = a;\nendmodule');
    expect(r.diagnostics).toMatchObject([{ code: 'use-before-declaration', span: { line: 2 } }]);
    expect(r.diagnostics[0]!.message).toContain('line 3');
    expect(codes('module m (input clk, input d, output q);\n always @(posedge clk) r <= d;\n reg r;\n assign q = r;\nendmodule')).toContain('use-before-declaration');
    expect(errors('module m (input a, output y);\n wire w;\n assign w = a;\n assign y = w;\nendmodule')).toEqual([]);
  });
});

describe('gated clocks and undriven regs (B4, B5)', () => {
  it('warns once, in one sentence, when a clock passes through logic', () => {
    const src = `module m (input clk, input en, input d, output reg q);
  wire g;
  assign g = clk & en;
  always @(posedge g) q <= d;
endmodule`;
    const w = compile(src).diagnostics.filter((d) => d.code === 'gated-clock');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'warning', span: { line: 4 } });
    expect(w[0]!.message).toContain('clock skew');
    expect(w[0]!.message.match(/\./g)).toHaveLength(1);
  });

  it('is quiet for a clock straight from an input, even through a plain alias', () => {
    const src = `module m (input clk, input d, output reg q);\n wire c;\n assign c = clk;\n always @(posedge c) q <= d;\nendmodule`;
    expect(codes(src)).toEqual([]);
  });

  it('warns that a never-assigned output reg floats in hardware', () => {
    const r = compile('module m (input a, output reg y);\n wire w = a;\nendmodule');
    const undriven = r.diagnostics.filter((d) => d.code === 'undriven');
    expect(undriven).toMatchObject([{ severity: 'warning', code: 'undriven' }]);
    expect(undriven[0]!.message).toContain('float');
  });
});

describe('the design stays valid for the other consumers', () => {
  it('a design with warnings still has a design', () => {
    expect(design('module m (input clk, input a, output reg y);\n always @(posedge clk) begin y <= a; if (y) y <= 1\'b1; end\nendmodule')).toBeDefined();
  });
});
