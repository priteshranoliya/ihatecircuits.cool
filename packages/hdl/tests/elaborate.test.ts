import { describe, expect, it } from 'vitest';
import { compile, findModule } from '../src';
import { design, sim } from './ir-eval';

const codes = (src: string, top?: string) => compile(src, { top }).diagnostics.map((d) => d.code);

describe('registers from always @(posedge clk)', () => {
  const counter = `module counter (input clk, input rst, input en, output reg [3:0] q);
  always @(posedge clk) begin
    if (rst) q <= 4'd0;
    else if (en) q <= q + 1;
  end
endmodule`;

  it('turns a synchronous reset and enable into next-state logic in front of one register', () => {
    const d = design(counter);
    const m = findModule(d, 'counter')!;
    expect(m.cells.filter((c) => c.kind === 'dff')).toHaveLength(1);
    expect(m.cells.filter((c) => c.kind === 'mux')).toHaveLength(2);
    expect(m.cells.find((c) => c.kind === 'add')).toBeDefined();
  });

  it('counts, holds without enable, and resets', () => {
    const s = sim(counter);
    s.set('rst', 1).tick('clk');
    expect(s.get('q')).toBe(0n);
    s.set('rst', 0).set('en', 1);
    for (let i = 1; i <= 5; i++) {
      s.tick('clk');
      expect(s.get('q')).toBe(BigInt(i));
    }
    s.set('en', 0).tick('clk').tick('clk');
    expect(s.get('q')).toBe(5n);
    s.set('en', 1);
    for (let i = 0; i < 11; i++) s.tick('clk');
    expect(s.get('q')).toBe(0n);
    s.set('rst', 1).tick('clk');
    expect(s.get('q')).toBe(0n);
  });

  it('nonblocking assignments read the values from before the edge', () => {
    const s = sim(`module swap (input clk, input [3:0] x, input [3:0] y, input load, output reg [3:0] a, output reg [3:0] b);
  always @(posedge clk) begin
    if (load) begin
      a <= x;
      b <= y;
    end else begin
      a <= b;
      b <= a;
    end
  end
endmodule`);
    s.set('x', 3).set('y', 9).set('load', 1).tick('clk');
    s.set('load', 0).tick('clk');
    expect([s.get('a'), s.get('b')]).toEqual([9n, 3n]);
    s.tick('clk');
    expect([s.get('a'), s.get('b')]).toEqual([3n, 9n]);
  });

  it('the last assignment in a block wins, and a register not assigned on a path holds', () => {
    const s = sim(`module m (input clk, input c, output reg [3:0] q, output reg [3:0] r);
  always @(posedge clk) begin
    q <= 1;
    if (c) q <= 2;
    if (c) r <= 7;
  end
endmodule`);
    s.set('c', 0).tick('clk');
    expect([s.get('q'), s.get('r')]).toEqual([1n, 0n]);
    s.set('c', 1).tick('clk');
    expect([s.get('q'), s.get('r')]).toEqual([2n, 7n]);
    s.set('c', 0).tick('clk');
    expect([s.get('q'), s.get('r')]).toEqual([1n, 7n]);
  });

  it('a shift register chains through registers without racing', () => {
    const s = sim(`module sr (input clk, input d, output q);
  reg a;
  reg b;
  always @(posedge clk) begin
    a <= d;
    b <= a;
  end
  assign q = b;
endmodule`);
    s.set('d', 1).tick('clk');
    expect(s.get('q')).toBe(0n);
    s.tick('clk');
    expect(s.get('q')).toBe(1n);
  });

  it('several names for one signal become one net', () => {
    const d = design(`module m (input clk, input d, output q, output q2);
  reg r;
  wire w;
  assign w = r;
  assign q = w;
  assign q2 = r;
  always @(posedge clk) r <= d;
endmodule`);
    const m = findModule(d, 'm')!;
    const net = m.ports.find((p) => p.name === 'q')!.net;
    expect(m.ports.find((p) => p.name === 'q2')!.net).toBe(net);
    expect([...m.nets[net]!.names].sort()).toEqual(['q', 'q2', 'r', 'w']);
  });
});

describe('instances and the top module', () => {
  const twice = `module inv (input [3:0] a, output [3:0] y);
  assign y = ~a;
endmodule
module top (input [3:0] x, output [3:0] y);
  wire [3:0] w;
  inv u1 (.a(x), .y(w));
  inv u2 (.a(w), .y(y));
endmodule`;

  it('finds the module nobody instantiates and orders callees first', () => {
    const d = design(twice);
    expect(d.top).toBe('top');
    expect(d.modules.map((m) => m.name)).toEqual(['inv', 'top']);
  });

  it('instantiates a module twice', () => {
    const d = design(twice);
    const top = findModule(d, 'top')!;
    expect(top.cells.flatMap((c) => (c.kind === 'instance' ? [c.name] : []))).toEqual(['u1', 'u2']);
    const s = sim(twice);
    s.set('x', 0b0110);
    expect(s.get('y')).toBe(0b0110n);
  });

  it('honours opts.top and reports an unknown top', () => {
    expect(design(twice, 'inv').top).toBe('inv');
    expect(codes(twice, 'nope')).toEqual(['top-not-found']);
  });

  it('says so when several modules are never instantiated', () => {
    expect(codes('module a (input x, output y); assign y = x; endmodule\nmodule b (input x, output y); assign y = x; endmodule')).toEqual(['ambiguous-top']);
  });

  it('reports recursion, direct and indirect', () => {
    expect(codes('module a (input x, output y); a u (.x(x), .y(y)); endmodule')).toContain('recursive-instantiation');
    const r = compile('module a (input x, output y); b u (.x(x), .y(y)); endmodule\nmodule b (input x, output y); a u (.x(x), .y(y)); endmodule');
    expect(r.diagnostics.filter((d) => d.code === 'recursive-instantiation')).toHaveLength(1);
    expect(r.design).toBeUndefined();
  });

  it('checks instance connections', () => {
    const base = 'module sub (input [3:0] a, output [3:0] y); assign y = a; endmodule\n';
    expect(codes(base + 'module t (input [3:0] x, output [3:0] w); sub u (.a(x), .nope(w)); endmodule')).toEqual(['bad-connection']);
    expect(codes(base + 'module t (input [3:0] x, output [3:0] w); sub u (.a(x), .a(x), .y(w)); endmodule')).toContain('bad-connection');
    expect(codes(base + 'module t (input [3:0] x, output [3:0] w); other u (.a(x), .y(w)); endmodule')).toEqual(['unknown-module']);
    expect(codes(base + 'module t (input [3:0] x, output [3:0] w); sub u (.a(x), .y(x)); endmodule')).toContain('bad-connection');
  });

  it('sizes an input connection like an assignment to the port', () => {
    const s = sim(`module add1 (input [4:0] a, output [4:0] y);
  assign y = a + 1;
endmodule
module top (input [3:0] x, output [4:0] y);
  add1 u (.a(x), .y(y));
endmodule`);
    s.set('x', 15);
    expect(s.get('y')).toBe(16n);
  });

  it('leaves unconnected ports out of the instance', () => {
    const d = design(`module sub (input a, input b, output y, output z); assign y = a; assign z = b; endmodule
module top (input a, output y);
  sub u (.a(a), .b(), .y(y));
endmodule`);
    const inst = findModule(d, 'top')!.cells.find((c) => c.kind === 'instance')!;
    expect(inst.kind === 'instance' && [Object.keys(inst.inputs), Object.keys(inst.outputs)]).toEqual([['a'], ['y']]);
  });

  it('registers inside a submodule keep their own state per instance', () => {
    const s = sim(`module bit1 (input clk, input d, output q);
  reg r;
  always @(posedge clk) r <= d;
  assign q = r;
endmodule
module top (input clk, input a, input b, output qa, output qb);
  bit1 u1 (.clk(clk), .d(a), .q(qa));
  bit1 u2 (.clk(clk), .d(b), .q(qb));
endmodule`);
    s.set('a', 1).set('b', 0).tick('clk');
    expect([s.get('qa'), s.get('qb')]).toEqual([1n, 0n]);
    s.set('a', 0).set('b', 1).tick('clk');
    expect([s.get('qa'), s.get('qb')]).toEqual([0n, 1n]);
  });
});

describe('semantic diagnostics', () => {
  it('undeclared names', () => {
    const r = compile('module m (input a, output y);\n  assign y = a & nope;\nendmodule');
    expect(r.diagnostics[0]).toMatchObject({ code: 'undeclared', span: { line: 2, col: 18 } });
    expect(r.diagnostics[0]!.message).toContain("'nope'");
  });

  it('reports one error per bad item, several per file', () => {
    const r = compile(`module m (input a, output y, output z);
  assign y = nope1;
  assign z = nope2;
endmodule`);
    expect(r.diagnostics.map((d) => [d.code, d.span.line])).toEqual([['undeclared', 2], ['undeclared', 3]]);
  });

  it('redeclarations and duplicate modules', () => {
    expect(codes('module m (input a, output y);\n wire a;\n assign y = a;\nendmodule')).toContain('redeclared');
    expect(codes('module m (input a, input a, output y); assign y = a; endmodule')).toContain('redeclared');
    expect(codes('module m (input a, output y); assign y = a; endmodule\nmodule m (input a, output y); assign y = a; endmodule')).toContain('duplicate-module');
  });

  it('driver rules', () => {
    expect(codes('module m (input a, output y);\n assign a = y;\nendmodule')).toContain('bad-assignment');
    expect(codes('module m (input a, output reg y);\n assign y = a;\nendmodule')).toContain('bad-assignment');
    expect(codes('module m (input clk, input a, output y);\n always @(posedge clk) y <= a;\nendmodule')).toContain('bad-assignment');
    expect(codes('module m (input a, input b, output y);\n assign y = a;\n assign y = b;\nendmodule')).toContain('multiple-drivers');
    expect(codes('module m (input clk, input a, output reg y);\n always @(posedge clk) y <= a;\n always @(posedge clk) y <= ~a;\nendmodule')).toContain('multiple-drivers');
  });

  it('range and width checks on declarations', () => {
    expect(codes('module m (input [33:0] a, output y); assign y = a[0]; endmodule')).toContain('width-limit');
    expect(codes('module m (input [7:1] a, output y); assign y = a[1]; endmodule')).toEqual([]);
    expect(codes('module m (input [0:7] a, output y); assign y = a[1]; endmodule')).toEqual([]);
  });

  it('a clock is a plain 1-bit signal; two edges make an asynchronous reset', () => {
    const body = (ev: string) => `module m (input clk, input [1:0] bus, input a, output reg y);\n always ${ev} y <= a ^ bus[0] ^ clk;\nendmodule`;
    expect(codes(body('@(posedge clk)'))).toEqual([]);
    expect(codes(body('@(negedge clk)'))).toEqual([]);
    expect(codes(body('@(posedge clk or posedge a)'))).toEqual(['bad-async-reset']);
    expect(codes(body('@(*)'))).toEqual([]);
    expect(codes(body('@(posedge bus)'))).toEqual(['bad-clock']);
  });

  it('blocking assignments and assignments to selects build logic', () => {
    const m = (stmt: string) => `module m (input clk, input a, output reg [1:0] y);\n always @(posedge clk) ${stmt}\nendmodule`;
    expect(codes(m('y = {a, a};'))).toEqual([]);
    expect(codes(m('y[0] <= a;'))).toEqual([]);
  });

  it('x and z digits and signed numbers are built', () => {
    for (const lit of ["4'b1x00", "4'bzzzz", "4'sd3"]) {
      const r = compile(`module m (output [3:0] y);\n assign y = ${lit};\nendmodule`);
      expect(r.diagnostics.filter((d) => d.severity === 'error'), lit).toEqual([]);
      expect(r.design, lit).toBeDefined();
    }
  });

  it('warns about undriven outputs and still produces a design', () => {
    const r = compile('module m (input a, output y, output z);\n assign y = a;\nendmodule');
    expect(r.design).toBeDefined();
    expect(r.diagnostics).toMatchObject([{ severity: 'warning', code: 'undriven', span: { line: 1 } }]);
  });

  it('warns when a literal is cut to fit', () => {
    const r = compile("module m (output [3:0] y);\n assign y = 4'hFF;\nendmodule");
    expect(r.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'literal-truncated' });
    expect(r.design).toBeDefined();
  });

  it('an empty file has no module', () => {
    expect(codes('// nothing here')).toEqual(['no-modules']);
  });

  it('diagnostics carry full spans in source order', () => {
    const src = 'module m (input a, output y, output z);\n  assign z = nope;\n  assign y = a +;\nendmodule';
    const r = compile(src);
    for (const d of r.diagnostics) {
      expect(d.span.end).toBeGreaterThanOrEqual(d.span.start);
      expect(d.span.line).toBeGreaterThan(0);
      expect(d.span.col).toBeGreaterThan(0);
    }
    expect(r.diagnostics.map((d) => d.span.start)).toEqual([...r.diagnostics.map((d) => d.span.start)].sort((a, b) => a - b));
  });
});

describe('the design IR', () => {
  it('is deterministic: the same source gives the same design', () => {
    const src = `module top (input [7:0] a, input [7:0] b, input clk, output reg [8:0] q);
  wire [8:0] s;
  assign s = a + b;
  always @(posedge clk) q <= s == 0 ? 9'd1 : s;
endmodule`;
    expect(JSON.stringify(design(src))).toBe(JSON.stringify(design(src)));
  });

  it('keeps every cell operand width consistent with its operator', () => {
    const d = design(`module top (input [7:0] a, input [7:0] b, input clk, output reg [8:0] q, output e);
  assign e = (a + b) == q;
  always @(posedge clk) q <= {a[0], b} ^ (a + b);
endmodule`);
    for (const m of d.modules) {
      const w = (n: number) => m.nets[n]!.width;
      for (const c of m.cells) {
        switch (c.kind) {
          case 'and':
          case 'or':
          case 'xor':
          case 'xnor':
          case 'add':
            expect([w(c.a), w(c.b)]).toEqual([w(c.out), w(c.out)]);
            break;
          case 'eq':
          case 'ne':
            expect(w(c.a)).toBe(w(c.b));
            expect(w(c.out)).toBe(1);
            break;
          case 'mux':
            expect([w(c.sel), w(c.onFalse), w(c.onTrue)]).toEqual([1, w(c.out), w(c.out)]);
            break;
          case 'concat':
            expect(c.parts.reduce((s, p) => s + w(p), 0)).toBe(w(c.out));
            break;
          case 'dff':
            expect([w(c.clk), w(c.d)]).toEqual([1, w(c.q)]);
            break;
          default:
        }
      }
    }
  });

  it('shares identical sub-expressions', () => {
    const d = design(`module m (input [3:0] a, input [3:0] b, output [3:0] y, output [3:0] z);
  assign y = a & b;
  assign z = a & b;
endmodule`);
    expect(findModule(d, 'm')!.cells.filter((c) => c.kind === 'and')).toHaveLength(1);
  });
});
