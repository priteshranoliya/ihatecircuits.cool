import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/diagnostics';
import { compileCheck } from '../../../../tools/hdl-fuzz/src/iverilog';
import { compileResult, diagsWithCode, haveIverilog } from './helpers';

const P = {
  latchIf: `module m(input en, input [3:0] d, output reg [3:0] q);
  always @* begin
    if (en) q = d;
  end
endmodule`,
  latchCase: `module m(input [1:0] s, input [3:0] a, input [3:0] b, output reg [3:0] y);
  always @* begin
    case (s)
      2'd0: y = a;
      2'd1: y = b;
    endcase
  end
endmodule`,
  latchNested: `module m(input c, input e, input [3:0] a, output reg [3:0] y);
  always @* begin
    if (c) begin
      if (e) y = a;
    end else y = 4'd0;
  end
endmodule`,
  noLatchComplete: `module m(input en, input [3:0] d, output reg [3:0] q);
  always @* begin
    if (en) q = d;
    else q = 4'd0;
  end
endmodule`,
  noLatchDefaultFirst: `module m(input en, input [3:0] d, output reg [3:0] q);
  always @* begin
    q = 4'd0;
    if (en) q = d;
  end
endmodule`,
  noLatchCaseDefault: `module m(input [1:0] s, input [3:0] a, output reg [3:0] y);
  always @* begin
    case (s)
      2'd0: y = a;
      default: y = 4'd0;
    endcase
  end
endmodule`,
  noLatchClocked: `module m(input clk, input en, input [3:0] d, output reg [3:0] q);
  always @(posedge clk) begin
    if (en) q <= d;
  end
endmodule`,

  sensMissing: `module m(input [3:0] a, input [3:0] b, output reg [3:0] y);
  always @(a) y = a & b;
endmodule`,
  sensComplete: `module m(input [3:0] a, input [3:0] b, output reg [3:0] y);
  always @(a or b) y = a & b;
endmodule`,
  sensStar: `module m(input [3:0] a, input [3:0] b, output reg [3:0] y);
  always @* y = a & b;
endmodule`,

  unusedWire: `module m(input a, input b, output y);
  wire t;
  assign t = a & b;
  assign y = a;
endmodule`,
  unusedDeclared: `module m(input a, output y);
  wire spare;
  assign y = a;
endmodule`,
  usedAll: `module m(input a, input b, output y);
  wire t;
  assign t = a & b;
  assign y = ~t;
endmodule`,

  truncAssign: `module m(input [7:0] a8, output [3:0] y4);
  assign y4 = a8;
endmodule`,
  truncBlocking: `module m(input [7:0] a8, output reg [3:0] y4);
  always @* y4 = a8;
endmodule`,
  truncNonblocking: `module m(input clk, input [7:0] a8, output reg [3:0] y4);
  always @(posedge clk) y4 <= a8;
endmodule`,
  truncMasked: `module m(input [7:0] a8, output reg [3:0] y4);
  always @* y4 = a8 & 8'h0f;
endmodule`,
  truncCounter: `module m(input clk, input rst, output reg [3:0] q);
  always @(posedge clk) begin
    if (rst) q <= 4'd0;
    else q <= q + 1;
  end
endmodule`,
  truncSameWidthSum: `module m(input [3:0] a, input [3:0] b, output [3:0] y);
  assign y = a + b;
endmodule`,
  truncSelect: `module m(input [7:0] a8, output [3:0] y4);
  assign y4 = a8[3:0];
endmodule`,
  truncWiden: `module m(input [3:0] a4, output [7:0] y8);
  assign y8 = a4;
endmodule`,
  truncLiteral: `module m(output [3:0] y4);
  assign y4 = 8'h05;
endmodule`,

  mixed: `module m(input clk, input [3:0] a, input [3:0] b, output reg [3:0] q);
  always @(posedge clk) begin
    q = a;
    q <= b;
  end
endmodule`,
  notMixed: `module m(input clk, input [3:0] a, input [3:0] b, output reg [3:0] q, output reg [3:0] r);
  reg [3:0] t;
  always @(posedge clk) begin
    t = a;
    q <= t;
    r <= b;
  end
endmodule`,

  loopAssign: `module m(output y);
  wire a, b;
  assign a = ~b;
  assign b = ~a;
  assign y = a;
endmodule`,
  loopNor: `module m(input s, input r, output q);
  wire qn;
  nor (q, r, qn);
  nor (qn, s, q);
endmodule`,
  noLoopRegistered: `module m(input clk, input rst, output reg q);
  always @(posedge clk) begin
    if (rst) q <= 1'b0;
    else q <= ~q;
  end
endmodule`,

  caseAttr: `module m(input [1:0] s, input [3:0] a, input [3:0] b, output reg [3:0] y);
  always @* begin
    (* full_case, parallel_case *)
    case (s)
      2'd0: y = a;
      2'd1: y = b;
      default: y = 4'd0;
    endcase
  end
endmodule`,
  caseNoAttr: `module m(input [1:0] s, input [3:0] a, input [3:0] b, output reg [3:0] y);
  always @* begin
    case (s)
      2'd0: y = a;
      2'd1: y = b;
      default: y = 4'd0;
    endcase
  end
endmodule`,

  asyncBad: `module m(input clk, input rst, input [3:0] a, input [3:0] d, output reg [3:0] q);
  always @(posedge clk or posedge rst) begin
    if (rst) q <= a;
    else q <= d;
  end
endmodule`,
  asyncBadLow: `module m(input clk, input rstn, input [3:0] a, input [3:0] d, output reg [3:0] q);
  always @(posedge clk or negedge rstn) begin
    if (!rstn) q <= a + 4'd1;
    else q <= d;
  end
endmodule`,
  asyncGood: `module m(input clk, input rst, input [3:0] d, output reg [3:0] q);
  always @(posedge clk or posedge rst) begin
    if (rst) q <= 4'd5;
    else q <= d;
  end
endmodule`,

  xcmpAssign: `module m(input [3:0] a, input [3:0] b, output y);
  assign y = (a === b);
endmodule`,
  xcmpNot: `module m(input [3:0] a, input [3:0] b, output y);
  assign y = (a !== b);
endmodule`,
  xcmpProc: `module m(input [3:0] a, output reg y);
  always @* begin
    if (a === 4'b1x0z) y = 1'b1;
    else y = 1'b0;
  end
endmodule`,

  dupAssign: `module m(input [3:0] a, input [3:0] b, output [3:0] y);
  assign y = a;
  assign y = b;
endmodule`,
  dupOverlap: `module m(input [1:0] a, input [1:0] b, output [2:0] y);
  assign y[1:0] = a;
  assign y[2:1] = b;
endmodule`,
  dupReg: `module m(input clk, input [3:0] a, input [3:0] b, output reg [3:0] q);
  always @(posedge clk) q <= a;
  always @(posedge clk) q <= b;
endmodule`,
  dupInstance: `module sub(input [3:0] a, output [3:0] y);
  assign y = ~a;
endmodule
module m(input [3:0] a, input [3:0] b, output [3:0] y);
  sub u (.a(a), .y(y));
  assign y = b;
endmodule`,
  noDupDisjoint: `module m(input [1:0] a, input [1:0] b, output [3:0] y);
  assign y[1:0] = a;
  assign y[3:2] = b;
endmodule`,
  noDupTristate: `module m(input en, input [3:0] a, input [3:0] b, output [3:0] y);
  assign y = en ? a : 4'bz;
  assign y = en ? 4'bz : b;
endmodule`,
  dupTristateNormal: `module m(input en, input [3:0] a, input [3:0] b, output [3:0] y);
  assign y = en ? a : 4'bz;
  assign y = b;
endmodule`,
  noDupPartsInBlocks: `module m(input clk, input [1:0] a, input [1:0] b, output reg [3:0] q);
  always @(posedge clk) q[1:0] <= a;
  always @(posedge clk) q[3:2] <= b;
endmodule`,

  notSynthDelay: `module m(output reg a);
  initial begin
    a = 1'b0;
    #5 a = 1'b1;
  end
endmodule`,
  notSynthDisplay: `module m(input a, output y);
  initial $display("starting");
  assign y = a;
endmodule`,
  notSynthClock: `module m(output reg clk);
  initial clk = 1'b0;
  always #5 clk = ~clk;
endmodule`,
  initMemoryOk: `module m(input [1:0] a, output [7:0] q);
  reg [7:0] mem [0:3];
  initial begin
    mem[0] = 8'h11;
    mem[1] = 8'h22;
    mem[2] = 8'h33;
    mem[3] = 8'h44;
  end
  assign q = mem[a];
endmodule`,

  powVar: `module m(input [3:0] a, input [1:0] b, output [7:0] y);
  assign y = a ** b;
endmodule`,
  inout: `module m(inout [3:0] a, output y);
  assign y = a[0];
endmodule`,
  udp: `primitive p(out, a, b);
  output out;
  input a, b;
  table
    00 : 0;
    01 : 0;
    10 : 0;
    11 : 1;
  endtable
endprimitive
module m(input a, input b, output y);
  p u (y, a, b);
endmodule`,
  config: `module m(input a, output y);
  assign y = a;
endmodule
config cfg;
  design work.m;
  default liblist work;
endconfig`,

  loopVarBound: `module m(input [3:0] n, output reg [7:0] y);
  integer i;
  always @* begin
    y = 8'd0;
    for (i = 0; i < n; i = i + 1) y = y + 8'd1;
  end
endmodule`,
  loopTooLong: `module m(output reg [15:0] y);
  integer i;
  always @* begin
    y = 16'd0;
    for (i = 0; i < 5000; i = i + 1) y = y + 16'd1;
  end
endmodule`,
  loopAtLimit: `module m(output reg [15:0] y);
  integer i;
  always @* begin
    y = 16'd0;
    for (i = 0; i < 4096; i = i + 1) y = y + 16'd1;
  end
endmodule`,
  loopConstant: `module m(output reg [7:0] y);
  parameter N = 5;
  integer i;
  always @* begin
    y = 8'd0;
    for (i = 0; i < N; i = i + 1) y = y + 8'd1;
  end
endmodule`,

  notConstParam: `module m(input [3:0] a, output [3:0] y);
  parameter P = a;
  assign y = P;
endmodule`,
  notConstRange: `module m(input [3:0] a, output y);
  wire [a:0] w;
  assign w = 5'd0;
  assign y = w[0];
endmodule`,
  notConstLocalparam: `module m(input [3:0] a, output [3:0] y);
  wire [3:0] w;
  assign w = a;
  localparam L = w;
  assign y = L;
endmodule`,
  notConstOverride: `module sub #(parameter W = 4) (input [W-1:0] a, output [W-1:0] y);
  assign y = a;
endmodule
module m(input [3:0] a, output [3:0] y);
  sub #(.W(a)) u (.a(a), .y(y));
endmodule`,
  notConstReplication: `module m(input [1:0] n, output [7:0] y);
  assign y = {n{1'b1}};
endmodule`,
  constOk: `module m(input [3:0] a, output [3:0] y);
  parameter D = 10;
  localparam AW = $clog2(D);
  wire [AW-1:0] w;
  assign w = a[AW-1:0];
  assign y = w;
endmodule`,

  cleanCounter: `module m(input clk, input rst, input en, output reg [3:0] cnt);
  always @(posedge clk) begin
    if (rst) cnt <= 4'd0;
    else if (en) cnt <= cnt + 1;
  end
endmodule`,
  cleanAsync: `module m(input clk, input rstn, input [3:0] d, output reg [3:0] q);
  always @(posedge clk or negedge rstn) begin
    if (!rstn) q <= 4'd0;
    else q <= d;
  end
endmodule`,
  cleanAdder: `module m(input [3:0] a, input [3:0] b, output c, output [3:0] s);
  assign {c, s} = a + b;
endmodule`,
  cleanFsm: `module m(input clk, input rst, input go, output busy);
  reg [1:0] state;
  reg [1:0] next;
  always @(posedge clk) begin
    if (rst) state <= 2'd0;
    else state <= next;
  end
  always @* begin
    case (state)
      2'd0: next = go ? 2'd1 : 2'd0;
      2'd1: next = 2'd2;
      default: next = 2'd0;
    endcase
  end
  assign busy = state != 2'd0;
endmodule`,
  cleanTristate: `module m(input en, input [3:0] a, input [3:0] b, output [3:0] y);
  tri [3:0] bus;
  assign bus = en ? a : 4'bz;
  assign bus = en ? 4'bz : b;
  assign y = bus;
endmodule`,
};

const diag = (src: string, code: string): Diagnostic[] => diagsWithCode(src, code);
const warnings = (src: string) => compileResult(src).diagnostics.filter((d) => d.severity === 'warning');

function expectWarning(src: string, code: string): Diagnostic {
  const r = compileResult(src);
  const ds = r.diagnostics.filter((d) => (d.code as string) === code);
  expect(ds.map((d) => `${d.code}:${d.severity}`), `diagnostics ${JSON.stringify(r.diagnostics.map((d) => d.code))}`).toEqual([`${code}:warning`]);
  expect(r.design, 'a warning does not stop compilation').toBeDefined();
  return ds[0]!;
}

function expectError(src: string, code: string): Diagnostic {
  const r = compileResult(src);
  const ds = r.diagnostics.filter((d) => (d.code as string) === code);
  expect(ds.length, `diagnostics ${JSON.stringify(r.diagnostics.map((d) => d.code))}`).toBeGreaterThanOrEqual(1);
  expect(ds[0]!.severity).toBe('error');
  expect(r.design, 'an error means no design').toBeUndefined();
  return ds[0]!;
}

const noCode = (src: string, code: string) => expect(diag(src, code).map((d) => d.message)).toEqual([]);

describe("warning 'latch-inferred'", () => {
  it('an if without else names the signal and the missing else branch', () => {
    const d = expectWarning(P.latchIf, 'latch-inferred');
    expect(d.message).toMatch(/\bq\b/);
    expect(d.message).toMatch(/else/i);
  });

  it('a case without default names the signal and the missing default branch', () => {
    const d = expectWarning(P.latchCase, 'latch-inferred');
    expect(d.message).toMatch(/\by\b/);
    expect(d.message).toMatch(/default/i);
  });

  it('an inner if without else is found inside an outer if', () => {
    const d = expectWarning(P.latchNested, 'latch-inferred');
    expect(d.message).toMatch(/\by\b/);
    expect(d.message).toMatch(/else/i);
  });

  it.each(['noLatchComplete', 'noLatchDefaultFirst', 'noLatchCaseDefault', 'noLatchClocked'] as const)('%s: no latch is reported', (name) => {
    noCode(P[name], 'latch-inferred');
  });
});

describe("warning 'incomplete-sensitivity'", () => {
  it('a signal read but missing from the list is reported by name', () => {
    const d = expectWarning(P.sensMissing, 'incomplete-sensitivity');
    expect(d.message).toMatch(/\bb\b/);
  });

  it.each(['sensComplete', 'sensStar', 'noLatchClocked'] as const)('%s: nothing is reported', (name) => {
    noCode(P[name], 'incomplete-sensitivity');
  });
});

describe("warning 'unused-signal'", () => {
  it('a wire that is driven but never read is reported by name', () => {
    const d = expectWarning(P.unusedWire, 'unused-signal');
    expect(d.message).toMatch(/\bt\b/);
  });

  it('a wire that is declared and never used is reported by name', () => {
    const d = expectWarning(P.unusedDeclared, 'unused-signal');
    expect(d.message).toMatch(/\bspare\b/);
  });

  it('signals that are read, and output ports, are not reported', () => {
    noCode(P.usedAll, 'unused-signal');
  });
});

describe("warning 'width-truncation': only when significant bits of a non-literal are lost", () => {
  it.each(['truncAssign', 'truncBlocking', 'truncNonblocking'] as const)('%s: an 8 bit signal into 4 bits warns', (name) => {
    const d = expectWarning(P[name], 'width-truncation');
    expect(d.message).toMatch(/\by4\b/);
  });

  it.each(['truncMasked', 'truncCounter', 'truncSameWidthSum', 'truncSelect', 'truncWiden', 'truncLiteral'] as const)('%s: no warning', (name) => {
    noCode(P[name], 'width-truncation');
  });
});

describe("warning 'mixed-assignment'", () => {
  it('a reg assigned with both = and <= is reported', () => {
    expectWarning(P.mixed, 'mixed-assignment');
  });

  it('a blocking temporary next to nonblocking outputs is not mixed', () => {
    noCode(P.notMixed, 'mixed-assignment');
  });
});

describe("warning 'comb-loop'", () => {
  it('assign a = ~b; assign b = ~a; is a combinational loop', () => {
    expectWarning(P.loopAssign, 'comb-loop');
  });

  it('cross-coupled nor gates are a combinational loop', () => {
    expectWarning(P.loopNor, 'comb-loop');
  });

  it('feedback through a register is not a combinational loop', () => {
    noCode(P.noLoopRegistered, 'comb-loop');
  });
});

describe("warning 'case-attribute'", () => {
  it('(* full_case, parallel_case *) on a case is reported', () => {
    expectWarning(P.caseAttr, 'case-attribute');
  });

  it('a case without attributes is not', () => {
    noCode(P.caseNoAttr, 'case-attribute');
  });
});

describe("error 'bad-async-reset'", () => {
  it('a reset branch that assigns a non-constant is an error', () => {
    expectError(P.asyncBad, 'bad-async-reset');
  });

  it('an active-low reset branch that assigns an expression is an error', () => {
    expectError(P.asyncBadLow, 'bad-async-reset');
  });

  it('a constant reset value compiles', () => {
    const r = compileResult(P.asyncGood);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.design).toBeDefined();
  });
});

describe("error 'x-comparison'", () => {
  it.each(['xcmpAssign', 'xcmpNot', 'xcmpProc'] as const)('%s: === and !== are not synthesizable', (name) => {
    expectError(P[name], 'x-comparison');
  });
});

describe("error 'multiple-drivers'", () => {
  it.each(['dupAssign', 'dupOverlap', 'dupReg', 'dupInstance'] as const)('%s: two drivers of the same bits', (name) => {
    expectError(P[name], 'multiple-drivers');
  });

  it('a tri-state driver and a normal driver of one net is an error', () => {
    expectError(P.dupTristateNormal, 'multiple-drivers');
  });

  it.each(['noDupDisjoint', 'noDupTristate', 'noDupPartsInBlocks'] as const)('%s: legal, no error', (name) => {
    const r = compileResult(P[name]);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.design).toBeDefined();
  });
});

describe("error 'not-synthesizable'", () => {
  it.each(['notSynthDelay', 'notSynthDisplay', 'notSynthClock'] as const)('%s: the message says it is not synthesizable and what it is for', (name) => {
    const d = expectError(P[name], 'not-synthesizable');
    expect(d.message).toContain('not synthesizable');
    expect(d.message).toContain('testbench');
  });

  it('an initial block that only fills a memory is not an error', () => {
    const r = compileResult(P.initMemoryOk);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.design).toBeDefined();
  });
});

describe("error 'not-supported'", () => {
  it('a ** b with a non-constant exponent', () => {
    const d = expectError(P.powVar, 'not-supported');
    expect(d.message).toContain('not supported yet');
    expect(d.span.line).toBe(2);
  });

  it('an inout port', () => {
    const d = expectError(P.inout, 'not-supported');
    expect(d.message).toContain('not supported yet');
    expect(d.span.line).toBe(1);
  });

  it('a user-defined primitive', () => {
    const d = expectError(P.udp, 'not-supported');
    expect(d.message).toContain('not supported yet');
    expect(d.span.line).toBeGreaterThanOrEqual(1);
  });

  it('a config block', () => {
    const d = expectError(P.config, 'not-supported');
    expect(d.message).toContain('not supported yet');
    expect(d.span.line).toBeGreaterThanOrEqual(1);
  });
});

describe("error 'bad-loop'", () => {
  it('a for loop whose bound is a signal', () => {
    expectError(P.loopVarBound, 'bad-loop');
  });

  it('a for loop of more than 4096 iterations', () => {
    expectError(P.loopTooLong, 'bad-loop');
  });

  it('a for loop of exactly 4096 iterations compiles', () => {
    const r = compileResult(P.loopAtLimit);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.design).toBeDefined();
  });

  it('a for loop bounded by a parameter compiles', () => {
    const r = compileResult(P.loopConstant);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.design).toBeDefined();
  });
});

describe("error 'not-constant'", () => {
  it.each([
    ['a parameter value', 'notConstParam'],
    ['a range bound', 'notConstRange'],
    ['a localparam value', 'notConstLocalparam'],
    ['a parameter override', 'notConstOverride'],
    ['a replication count', 'notConstReplication'],
  ] as const)('a non-constant expression as %s', (_what, name) => {
    expectError(P[name], 'not-constant');
  });

  it('$clog2 of a parameter in a range is constant', () => {
    const r = compileResult(P.constOk);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('clean designs produce no warnings', () => {
  it.each(['cleanCounter', 'cleanAsync', 'cleanAdder', 'cleanFsm', 'cleanTristate'] as const)('%s', (name) => {
    const r = compileResult(P[name]);
    expect(r.diagnostics.map((d) => `${d.severity} ${d.code}: ${d.message}`)).toEqual([]);
    expect(r.design).toBeDefined();
  });
});

describe('every diagnostic carries a span with a line', () => {
  const everything = Object.entries(P).filter(([name]) => !/^(clean|noLatch|noLoop|noDup|caseNo|sensComplete|sensStar|usedAll|asyncGood|initMemoryOk|loopAtLimit|loopConstant|constOk|notMixed|trunc(Masked|Counter|SameWidthSum|Select|Widen|Literal))/.test(name));

  it.each(everything)('%s', (_name, src) => {
    const ds = compileResult(src).diagnostics;
    expect(ds.length).toBeGreaterThan(0);
    for (const d of ds) {
      expect(d.span.line, `${d.code} line`).toBeGreaterThanOrEqual(1);
      expect(d.span.col, `${d.code} col`).toBeGreaterThanOrEqual(1);
      expect(d.span.end, `${d.code} extent`).toBeGreaterThanOrEqual(d.span.start);
    }
  });

  it('warnings alone leave a design behind', () => {
    for (const name of ['latchIf', 'sensMissing', 'unusedWire', 'truncAssign', 'mixed', 'loopAssign', 'caseAttr'] as const) {
      const r = compileResult(P[name]);
      expect(warnings(P[name]).length, name).toBeGreaterThan(0);
      expect(r.design, name).toBeDefined();
    }
  });
});

describe('the programs that are meant to be valid Verilog 2005 are accepted by Icarus', () => {
  const invalidOnPurpose = /^(config|notConst(Param|Range|Localparam|Override|Replication))$/;
  const valid = Object.entries(P).filter(([name]) => !invalidOnPurpose.test(name));

  it.skipIf(!haveIverilog).each(valid)('%s', async (_name, src) => {
    const r = await compileCheck(src, 'm');
    expect(r.ok ? 'ok' : r.stderr).toBe('ok');
  });
});
