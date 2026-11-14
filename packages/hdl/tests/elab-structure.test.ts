import { describe, expect, it } from 'vitest';
import { type Cell, compile, findModule } from '../src';
import { design } from './ir-eval';

const diag = (src: string, opts = {}) => compile(src, opts).diagnostics;
const kinds = (src: string, top?: string) => {
  const d = design(src, top);
  return findModule(d, d.top)!.cells.map((c) => c.kind);
};
const cellsOf = <K extends Cell['kind']>(src: string, kind: K, top?: string) => {
  const d = design(src, top);
  return findModule(d, d.top)!.cells.filter((c): c is Extract<Cell, { kind: K }> => c.kind === kind);
};

describe('one IR module per parameter binding', () => {
  const adder = `module adder #(parameter W = 4) (input [W-1:0] a, input [W-1:0] b, output [W-1:0] s);
  assign s = a + b;
endmodule`;

  it('names a binding after the parameters it changes, and shares equal bindings', () => {
    const d = design(`${adder}
module top (input [7:0] a, input [7:0] b, input [15:0] c, input [15:0] e, output [7:0] s8, output [15:0] s16, output [15:0] t16, output [3:0] s4);
  adder #(.W(8)) u8 (a, b, s8);
  adder #(16) u16 (c, e, s16);
  adder #(.W(16)) v16 (c, e, t16);
  adder u4 (a[3:0], b[3:0], s4);
endmodule`);
    expect(d.modules.map((m) => m.name)).toEqual(['adder_W8', 'adder_W16', 'adder', 'top']);
    expect(findModule(d, 'adder_W16')!.ports.map((p) => p.width)).toEqual([16, 16, 16]);
  });

  it('only elaborates a module under the parameters that instances give it', () => {
    const r = compile(`module inv #(parameter W = 1) (input [W-1:0] a, output [W-1:0] y);
  localparam MSB = W - 1;
  assign y = {~a[MSB], a[MSB-1:0]};
endmodule
module top (input [3:0] a, output [3:0] y);
  inv #(4) u (a, y);
endmodule`);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.design!.modules.map((m) => m.name)).toEqual(['inv_W4', 'top']);
  });

  it('a defparam to a direct child binds like an override', () => {
    const d = design(`${adder}
module top (input [7:0] a, input [7:0] b, output [7:0] s);
  adder u (a, b, s);
  defparam u.W = 8;
endmodule`);
    expect(d.modules.map((m) => m.name)).toEqual(['adder_W8', 'top']);
  });

  it('overriding something that is not a parameter is an error', () => {
    expect(diag(`${adder}\nmodule top (input [3:0] a, output [3:0] s);\n adder #(.NOPE(1)) u (a, a, s);\nendmodule`).map((d) => d.code)).toContain('bad-parameter');
  });
});

describe('generate scopes become net names', () => {
  it('a wire in an iteration of a named loop is gen[2].x', () => {
    const d = design(`module top (input [3:0] a, output [3:0] y);
  genvar i;
  generate
    for (i = 0; i < 4; i = i + 1) begin : gen
      wire x;
      assign x = ~a[i];
      assign y[i] = x;
    end
  endgenerate
endmodule`);
    const names = findModule(d, 'top')!.nets.flatMap((n) => n.names);
    expect(names).toContain('gen[2].x');
    expect(names).toContain('gen[0].x');
  });

  it('an unnamed generate if gets the name genblk1', () => {
    const d = design(`module top #(parameter ON = 1) (input a, output y);
  generate
    if (ON) begin
      wire t;
      assign t = ~a;
      assign y = t;
    end
  endgenerate
endmodule`);
    expect(findModule(d, 'top')!.nets.flatMap((n) => n.names)).toContain('genblk1.t');
  });

  it('a ripple-carry adder from a generate loop of full adders', () => {
    const d = design(`module fa (input a, input b, input c, output s, output co);
  assign s = a ^ b ^ c;
  assign co = (a & b) | (c & (a ^ b));
endmodule
module rca #(parameter N = 4) (input [N-1:0] a, input [N-1:0] b, output [N-1:0] s, output co);
  wire [N:0] c;
  assign c[0] = 1'b0;
  genvar i;
  generate
    for (i = 0; i < N; i = i + 1) begin : stage
      fa u (.a(a[i]), .b(b[i]), .c(c[i]), .s(s[i]), .co(c[i+1]));
    end
  endgenerate
  assign co = c[N];
endmodule`);
    const rca = findModule(d, 'rca')!;
    expect(rca.cells.filter((c) => c.kind === 'instance').map((c) => (c.kind === 'instance' ? c.name : ''))).toEqual(['stage[0].u', 'stage[1].u', 'stage[2].u', 'stage[3].u']);
  });
});

describe('registers, latches and the diagnostics that come with them', () => {
  it('an asynchronous reset becomes one adff with the reset value and level', () => {
    const [a] = cellsOf(
      `module top (input clk, input rn, input [3:0] d, output reg [3:0] q);
  always @(negedge clk or negedge rn) if (!rn) q <= 4'd9; else q <= d;
endmodule`,
      'adff',
    );
    expect(a).toMatchObject({ edge: 'neg', arstLevel: 0, arstValue: '1001' });
  });

  it('a reset branch that assigns a signal is an error that says so', () => {
    const d = diag(`module top (input clk, input rst, input [3:0] d, output reg [3:0] q);
  always @(posedge clk or posedge rst) if (rst) q <= d; else q <= d + 1;
endmodule`).find((x) => x.code === 'bad-async-reset')!;
    expect(d.severity).toBe('error');
    expect(d.message).toContain('constants');
    expect(d.message).toContain("'q'");
  });

  it('an incomplete assignment in always @* is a latch, and the warning names the signal and the branch', () => {
    const src = `module top (input en, input [3:0] d, output reg [3:0] q);
  always @* if (en) q = d;
endmodule`;
    const [l] = cellsOf(src, 'latch');
    expect(l).toMatchObject({ enLevel: 1 });
    const w = diag(src).find((x) => x.code === 'latch-inferred')!;
    expect(w.severity).toBe('warning');
    expect(w.message).toContain("'q'");
    expect(w.message).toMatch(/no 'else' branch/);
  });

  it('a case without default names the missing item', () => {
    const w = diag(`module top (input [1:0] s, output reg y);
  always @* case (s) 2'd0: y = 1; 2'd1: y = 0; endcase
endmodule`).find((x) => x.code === 'latch-inferred')!;
    expect(w.message).toMatch(/default/);
  });

  it('a default at the top of the block gives plain logic and no latch', () => {
    const src = `module top (input en, input [3:0] d, output reg [3:0] q);
  always @* begin q = 4'd0; if (en) q = d; end
endmodule`;
    expect(kinds(src)).not.toContain('latch');
    expect(diag(src).filter((x) => x.code === 'latch-inferred')).toEqual([]);
  });

  it('an incomplete sensitivity list warns and still builds the logic', () => {
    const src = `module top (input a, input b, output reg y);
  always @(a) y = a & b;
endmodule`;
    const w = diag(src).find((x) => x.code === 'incomplete-sensitivity')!;
    expect(w.message).toContain("'b'");
    expect(kinds(src)).toContain('and');
  });

  it('full_case and parallel_case are honoured, with a warning', () => {
    const src = `module top (input [1:0] s, output reg y);
  always @* (* full_case, parallel_case *) case (s) 2'd0: y = 1; 2'd1: y = 0; 2'd2: y = 1; endcase
endmodule`;
    expect(kinds(src)).not.toContain('latch');
    expect(diag(src).map((x) => x.code)).toContain('case-attribute');
  });

  it('a blocking temporary in a clocked block builds no register of its own', () => {
    const src = `module top (input clk, input [3:0] a, input [3:0] b, output reg [3:0] q);
  reg [3:0] t;
  always @(posedge clk) begin t = a + b; q <= t ^ a; end
endmodule`;
    expect(cellsOf(src, 'dff')).toHaveLength(1);
  });

  it('a loop variable reused by two blocks is not driven', () => {
    const src = `module top (input clk, input [3:0] a, output reg [3:0] p, output reg [3:0] q);
  integer i;
  always @(posedge clk) begin p = 0; for (i = 0; i < 4; i = i + 1) p = p + a[i]; end
  always @(posedge clk) begin q = 0; for (i = 0; i < 4; i = i + 1) q = q ^ a[i]; end
endmodule`;
    expect(diag(src).filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('a loop that does not end in a constant is an error, and so is one that is too long', () => {
    const open = diag(`module top (input clk, input [3:0] n, output reg [3:0] q);
  integer i;
  always @(posedge clk) for (i = 0; i < n; i = i + 1) q <= q + 1;
endmodule`);
    expect(open.map((x) => x.code)).toContain('bad-loop');
    const long = diag(`module top (input clk, output reg [3:0] q);
  integer i;
  always @(posedge clk) for (i = 0; i < 5000; i = i + 1) q <= q + 1;
endmodule`);
    expect(long.map((x) => x.code)).toContain('bad-loop');
  });

  it('mixing = and <= on a reg warns', () => {
    const w = diag(`module top (input clk, input a, output reg q);
  always @(posedge clk) begin q = a; q <= ~a; end
endmodule`).find((x) => x.code === 'mixed-assignment')!;
    expect(w.message).toContain("'q'");
  });
});

describe('memories and tri-state', () => {
  it('a write port, an async read port, and an initial word from $readmemh', () => {
    const src = `module top (input clk, input we, input [2:0] a, input [7:0] d, output [7:0] q);
  reg [7:0] mem [0:7];
  initial $readmemh("m.hex", mem);
  always @(posedge clk) if (we) mem[a] <= d;
  assign q = mem[a];
endmodule`;
    const d = compile(src, { files: { 'm.hex': '01 02\n@5 ff\n' } }).design!;
    const [m] = findModule(d, 'top')!.cells.filter((c): c is Extract<Cell, { kind: 'memory' }> => c.kind === 'memory');
    expect(m!.depth).toBe(8);
    expect(m!.init!.map((w) => w.replace(/x/g, '?'))).toEqual(['00000001', '00000010', '????????', '????????', '????????', '11111111', '????????', '????????']);
    expect(m!.writePorts).toHaveLength(1);
    expect(m!.readPorts).toHaveLength(1);
    expect(m!.readPorts[0]!.clk).toBeUndefined();
  });

  it('a register fed straight from a memory read becomes a synchronous read port', () => {
    const d = design(`module top (input clk, input we, input [2:0] a, input [7:0] d, output reg [7:0] q);
  reg [7:0] mem [0:7];
  always @(posedge clk) begin if (we) mem[a] <= d; q <= mem[a]; end
endmodule`);
    const top = findModule(d, 'top')!;
    const [m] = top.cells.filter((c): c is Extract<Cell, { kind: 'memory' }> => c.kind === 'memory');
    expect(m!.readPorts[0]).toMatchObject({ edge: 'pos' });
    expect(m!.readPorts[0]!.clk).toBeDefined();
    expect(top.cells.filter((c) => c.kind === 'dff')).toHaveLength(0);
  });

  it('en ? a : z is a tribuf, and two drivers of one net are fine', () => {
    const src = `module top (input e1, input e2, input [3:0] a, input [3:0] b, output [3:0] y);
  assign y = e1 ? a : 4'bz;
  assign y = e2 ? b : 4'bz;
endmodule`;
    expect(cellsOf(src, 'tribuf')).toHaveLength(2);
    expect(diag(src).filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('a tri-state driver and an ordinary driver on one net is a multiple-drivers error', () => {
    expect(diag(`module top (input e, input [3:0] a, input [3:0] b, output [3:0] y);
  assign y = e ? a : 4'bz;
  assign y = b;
endmodule`).map((x) => x.code)).toContain('multiple-drivers');
  });

  it('net kinds reach the IR', () => {
    const d = design(`module top (input a, input b, output y, output z);
  wand w;
  tri1 p;
  assign w = a;
  assign w = b;
  assign y = w;
  assign z = p;
endmodule`);
    const kinds = findModule(d, 'top')!.nets.filter((n) => n.kind).map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(['wand', 'pull1']));
  });
});

describe('lints', () => {
  it('unused signals, truncation and combinational loops are warned about, in plain words', () => {
    const w = diag(`module top (input [7:0] a, input [3:0] spare, output [3:0] y, output q, output r);
  wire t;
  assign y = a;
  assign q = ~r;
  assign r = ~q;
endmodule`);
    const by = (code: string) => w.filter((x) => x.code === code);
    expect(by('unused-signal').map((x) => x.message).join('|')).toMatch(/spare[\s\S]*|t/);
    expect(by('unused-signal').length).toBe(2);
    expect(by('width-truncation')).toHaveLength(1);
    expect(by('comb-loop')).toHaveLength(1);
    for (const x of w) expect(x.severity).toBe('warning');
  });

  it('a clean design says nothing', () => {
    expect(diag(`module top (input clk, input rst, input [3:0] d, output reg [3:0] q);
  always @(posedge clk) if (rst) q <= 0; else q <= q + d;
endmodule`)).toEqual([]);
  });

  it('`default_nettype none turns an implicit net into an error', () => {
    const src = (nt: string) => `\`default_nettype ${nt}\nmodule top (input a, output y);\n  assign w = a;\n  assign y = w;\nendmodule`;
    expect(diag(src('wire')).filter((x) => x.severity === 'error')).toEqual([]);
    expect(diag(src('none')).map((x) => x.code)).toContain('undeclared');
  });
});

describe('the IR is deterministic', () => {
  it('compiling twice gives the same design', () => {
    const src = `module sub #(parameter N = 2) (input [N-1:0] a, output [N-1:0] y);
  genvar i;
  generate for (i = 0; i < N; i = i + 1) begin : g assign y[i] = ~a[i]; end endgenerate
endmodule
module top (input clk, input [3:0] a, output reg [3:0] q, output [3:0] y);
  sub #(4) u (a, y);
  always @(posedge clk) case (a[1:0]) 0: q <= 1; 1: q <= 2; default: q <= a; endcase
endmodule`;
    expect(JSON.stringify(compile(src).design)).toBe(JSON.stringify(compile(src).design));
  });
});
