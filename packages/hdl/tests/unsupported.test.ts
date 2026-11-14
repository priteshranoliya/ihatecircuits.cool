import { describe, expect, it } from 'vitest';
import { compile, formatDiagnostic } from '../src';

/**
 * What the compiler says for what it does not build: "not supported yet" for a construct that is deferred or has
 * no form in the IR, and "not synthesizable; a testbench feature" for what only a simulator can run.
 */

const first = (src: string, code: string) => {
  const r = compile(src);
  const d = r.diagnostics.find((x) => x.code === code);
  expect(d, `no ${code} for ${JSON.stringify(src)}: ${r.diagnostics.map(formatDiagnostic).join(' | ')}`).toBeDefined();
  return { r, d: d!, text: src.slice(d!.span.start, d!.span.end) };
};

/** [line placed in a module with a reg output q, the source the diagnostic points at, the code, the message]. */
const IN_MODULE: [string, string, string, string][] = [
  ['initial begin #5 q = 1; end', '#5 q = 1;', 'not-synthesizable', "A delay or event control here is not synthesizable; a testbench feature (coming with the simulator)."],
  ['initial $display("x");', '$display("x");', 'not-synthesizable', 'The system task $display is not synthesizable; a testbench feature (coming with the simulator).'],
  ['always #5 q = ~q;', 'always #5 q = ~q;', 'not-synthesizable', "An 'always' block without an event list such as @(posedge clk) or @* is not synthesizable; a testbench feature (coming with the simulator)."],
  ['always @(posedge clk) forever q <= 1;', "forever q <= 1;", 'not-synthesizable', "A 'forever' loop is not synthesizable; a testbench feature (coming with the simulator)."],
  ['always @(posedge clk) wait (a) q <= 1;', 'wait (a) q <= 1;', 'not-synthesizable', "A 'wait' statement is not synthesizable; a testbench feature (coming with the simulator)."],
  ['always @(posedge clk) fork q <= 1; join', 'fork q <= 1; join', 'not-synthesizable', "A 'fork' block is not synthesizable; a testbench feature (coming with the simulator)."],
  ['always @(posedge clk) @(a) q <= 1;', '@(a) q <= 1;', 'not-synthesizable', 'An event control inside a block is not synthesizable; a testbench feature (coming with the simulator).'],
  ['always @(posedge clk) force q = 1;', 'force q = 1;', 'not-synthesizable', 'A procedural assign, deassign, force or release is not synthesizable; a testbench feature (coming with the simulator).'],
  ['event ev;', 'event ev;', 'not-synthesizable', "An 'event' declaration is not synthesizable; a testbench feature (coming with the simulator)."],
  ['real r;', 'real r;', 'not-supported', "'real' declarations are not supported yet: real numbers have no hardware form here."],
  ['trireg t;', 'trireg t;', 'not-supported', "'trireg' declarations are not supported yet: a net that stores charge has no word-level form."],
  ['nmos g (q, a, a);', 'nmos g (q, a, a);', 'not-supported', "The 'nmos' switch primitive is not supported yet; only and/or/xor-style gates, buf/not and bufif/notif are."],
  ['reg [3:0] m [0:3][0:3];', '[0:3]', 'not-supported', 'Arrays with more than one dimension are not supported yet.'],
  ['inout z;', 'inout z;', 'bad-declaration', 'A port declaration (input/output/inout) is only allowed directly in a module that lists its ports by name.'],
  ['defparam u.v.W = 2;', 'u.v.W = 2', 'not-supported', 'A defparam below a direct child instance, such as "defparam m.u.D = 2;", is not supported yet; use "defparam u.D = 2;" or a #(...) override.'],
];

/** [expression assigned to a 4-bit wire, the source the diagnostic points at, the code, the message]. */
const IN_EXPRESSION: [string, string, string, string][] = [
  ['a ** a', 'a ** a', 'not-supported', "The '**' operator with an exponent that is not constant is not supported yet. Write the exponent as a number or parameter."],
  ['1.5', '1.5', 'not-supported', 'Real numbers are not supported yet.'],
  ['$random', '$random', 'not-supported', 'The system function $random is not supported yet.'],
  ['a === a', 'a === a', 'x-comparison', "'===' compares x and z bits, which hardware cannot see: a wire is only ever 0 or 1. Use '==' instead, or remove the x/z comparison."],
  ['a !== a', 'a !== a', 'x-comparison', "'!==' compares x and z bits, which hardware cannot see: a wire is only ever 0 or 1. Use '!=' instead, or remove the x/z comparison."],
];

describe('constructs that are deferred, have no IR form, or are for a simulator', () => {
  for (const [line, pointsAt, code, message] of IN_MODULE) {
    it(`says "${message.slice(0, 60)}" for \`${line.slice(0, 50)}\`, at the construct`, () => {
      const src = `module m (input a, input clk, output reg q);\n  sub u (.a(a));\n  ${line}\nendmodule\nmodule sub (input a); endmodule`;
      const { r, d, text } = first(src, code);
      expect(d).toMatchObject({ severity: 'error', code, message });
      expect(text).toBe(pointsAt);
      expect(d.span.line).toBe(3);
      expect(r.design).toBeUndefined();
    });
  }

  for (const [e, pointsAt, code, message] of IN_EXPRESSION) {
    it(`says "${message.slice(0, 60)}" for \`${e}\`, at the expression`, () => {
      const src = `module m (input [3:0] a, output [3:0] y);\n  assign y = ${e};\nendmodule`;
      const { d, text } = first(src, code);
      expect(d.message).toBe(message);
      expect(text).toBe(pointsAt);
      expect(d.span.line).toBe(2);
    });
  }

  const HEADERS: [string, string, string, string][] = [
    ['module m (inout a, output q); assign q = 1\'b1; endmodule', 'inout a', 'not-supported', "'inout' ports are not supported yet."],
    ['primitive p (output y, input a);\n table 0 : 1; endtable\nendprimitive', 'primitive p (output y, input a);\n table 0 : 1; endtable\nendprimitive', 'not-supported', "'primitive' blocks are not supported yet."],
    ['config c; design m; endconfig', 'config c; design m; endconfig', 'not-supported', "'config' blocks are not supported yet."],
    ['module m (.p(a[3:0]), q); input [7:0] a; output q; assign q = a[0]; endmodule', '.p(a[3:0])', 'not-supported', 'A port that is a part of a vector or a concatenation, such as ".p(a[3:0])" or "{a, b}", is not supported yet. List the whole signal.'],
  ];
  for (const [src, pointsAt, code, message] of HEADERS) {
    it(`says "${message.slice(0, 60)}" for ${JSON.stringify(src.slice(0, 40))}`, () => {
      const { d, text } = first(src, code);
      expect(d.message).toBe(message);
      expect(text).toBe(pointsAt);
      expect(d.span.line).toBe(1);
    });
  }

  it('reports each of several unsupported constructs once, and still reports a mistake in another module', () => {
    const r = compile(`module m (input a, input clk, output reg q);
  initial begin #5 q = 1; end
  real r;
  always @(posedge clk) q <= a;
endmodule
module b (input a, output y);
  wire [3:0 broken;
  assign y = a;
endmodule`);
    expect(r.diagnostics.map((d) => [d.code, d.span.line])).toEqual([
      ['not-synthesizable', 2],
      ['not-supported', 3],
      ['syntax-error', 7],
    ]);
  });

  it('compiles a design that uses only what is built, with the full parser in front', () => {
    const r = compile(`module count (input clk, input rst, output reg [3:0] q);
  always @(posedge clk) begin
    if (rst) q <= 4'd0;
    else q <= q + 4'd1;
  end
endmodule`);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.design).toBeDefined();
  });

  it('compiles through macros and includes, and says which macro a problem is in', () => {
    const files = { 'defs.v': '`define HI 3\n`define BAD_ASSIGN(x) assign y = x + ;\n' };
    const ok = compile('`include "defs.v"\nmodule m (input [`HI:0] a, output [`HI:0] y);\n  assign y = a;\nendmodule', { files });
    expect(ok.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(ok.design!.modules[0]!.ports.map((p) => p.width)).toEqual([4, 4]);
    const bad = compile('`include "defs.v"\nmodule m (input [`HI:0] a, output [`HI:0] y);\n  `BAD_ASSIGN(a)\nendmodule', { files });
    const err = bad.diagnostics.find((d) => d.code === 'syntax-error')!;
    expect(err.message).toBe("Expected an expression, but found ';'. (in macro BAD_ASSIGN, expanded at line 3)");
    expect(err.span).toMatchObject({ line: 2, col: 38, file: 'defs.v' });
    expect(formatDiagnostic(err)).toMatch(/^defs\.v:2:38: error \[syntax-error\]:/);
  });

  it('reports an unterminated or unknown directive through compile()', () => {
    expect(compile('module m; endmodule\n`bogus\n').diagnostics.map((d) => [d.code, d.span.line])).toEqual([['preprocess-error', 2]]);
  });
});
