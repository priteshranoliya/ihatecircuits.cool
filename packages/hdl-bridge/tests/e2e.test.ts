import { describe, expect, it } from 'vitest';
import { bin, trace } from './helpers';

describe('4-bit counter with synchronous reset and enable', () => {
  const source = `module counter (input clk, input rst, input en, output reg [3:0] q);
  always @(posedge clk) begin
    if (rst) q <= 4'd0;
    else if (en) q <= q + 1;
  end
endmodule`;

  it('matches a reference model cycle by cycle, including unknown power-on state', () => {
    const steps: [number, number][] = [[0, 1], [1, 0], ...Array.from({ length: 6 }, (): [number, number] => [0, 1]), [0, 0], [0, 0], ...Array.from({ length: 12 }, (): [number, number] => [0, 1]), [1, 1], [0, 1]];
    const res = trace({
      source,
      top: 'counter',
      clock: 'clk',
      stimulus: steps.map(([rst, en]) => ({ rst: String(rst), en: String(en) })),
    });
    expect(res.ports).toEqual([
      { name: 'clk', width: 1, dir: 'in' },
      { name: 'rst', width: 1, dir: 'in' },
      { name: 'en', width: 1, dir: 'in' },
      { name: 'q', width: 4, dir: 'out' },
    ]);
    let q: number | null = null;
    steps.forEach(([rst, en], k) => {
      const pre = q === null ? 'xxxx' : bin(q, 4);
      if (rst) q = 0;
      else if (en) q = q === null ? null : (q + 1) & 15;
      const post = q === null ? 'xxxx' : bin(q, 4);
      expect(res.cycles[k], `cycle ${k}`).toEqual({ pre: { q: pre }, post: { q: post } });
    });
    expect(res.cycles[0]!.pre.q).toBe('xxxx');
    expect(q).toBe(1);
  });
});

describe('adder with a 9-bit result', () => {
  const source = `module add (input [7:0] a, input [7:0] b, output [8:0] y);
  assign y = a + b;
endmodule`;

  it('keeps the carry', () => {
    const cases: [number, number][] = [[255, 1], [255, 255], [0, 0], [128, 128], [100, 27]];
    let seed = 12345;
    for (let i = 0; i < 40; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      cases.push([seed & 255, (seed >> 8) & 255]);
    }
    const res = trace({ source, top: 'add', stimulus: cases.map(([a, b]) => ({ a: bin(a, 8), b: bin(b, 8) })) });
    cases.forEach(([a, b], k) => {
      expect(res.cycles[k]!.pre.y, `${a}+${b}`).toBe(bin(a + b, 9));
      expect(res.cycles[k]!.post.y).toBe(bin(a + b, 9));
    });
    expect(res.cycles[0]!.pre.y).toBe('100000000');
  });
});

describe('a module used as a submodule twice', () => {
  const source = `module add4 (input [3:0] a, input [3:0] b, output [4:0] s);
  assign s = a + b;
endmodule
module top (input [3:0] a, input [3:0] b, input [3:0] c, output [4:0] ab, output [4:0] bc, output [5:0] all);
  add4 u1 (.a(a), .b(b), .s(ab));
  add4 u2 (.a(b), .b(c), .s(bc));
  assign all = ab + c;
endmodule`;

  it('computes both instances independently', () => {
    const vectors: [number, number, number][] = [[15, 15, 15], [1, 2, 3], [0, 0, 0], [9, 7, 12], [15, 0, 15]];
    const res = trace({ source, top: 'top', stimulus: vectors.map(([a, b, c]) => ({ a: bin(a, 4), b: bin(b, 4), c: bin(c, 4) })) });
    vectors.forEach(([a, b, c], k) => {
      expect(res.cycles[k]!.pre).toEqual({ ab: bin(a + b, 5), bc: bin(b + c, 5), all: bin(a + b + c, 6) });
    });
  });
});

describe('mux built from ?:', () => {
  const source = `module mux (input [7:0] a, input [7:0] b, input s, input [1:0] t, output [7:0] y, output [7:0] z);
  assign y = s ? a : b;
  assign z = t ? (t == 2'd3 ? a : b) : 8'hAA;
endmodule`;

  it('selects by a 1-bit and by a multi-bit condition', () => {
    const vectors: [number, number, number, number][] = [];
    for (const s of [0, 1]) for (const t of [0, 1, 2, 3]) vectors.push([0x3c, 0xc3, s, t]);
    const res = trace({ source, top: 'mux', stimulus: vectors.map(([a, b, s, t]) => ({ a: bin(a, 8), b: bin(b, 8), s: bin(s, 1), t: bin(t, 2) })) });
    vectors.forEach(([a, b, s, t], k) => {
      expect(res.cycles[k]!.pre.y).toBe(bin(s ? a : b, 8));
      expect(res.cycles[k]!.pre.z).toBe(bin(t ? (t === 3 ? a : b) : 0xaa, 8));
    });
  });
});

describe('unknown values follow Verilog', () => {
  const source = `module m (input clk, output [3:0] v, output eq_known, output eq_unknown, output [3:0] mixed, output [3:0] masked, output [3:0] inv);
  reg [3:0] r;
  wire [3:0] part;
  assign part = {r[0], 3'b101};
  assign v = part;
  assign eq_known = part == 4'b0111;
  assign eq_unknown = part == 4'b0101;
  assign mixed = r[0] ? 4'b1100 : 4'b1010;
  assign masked = r & 4'b0000;
  assign inv = ~r;
endmodule`;

  it('keeps a known result where Verilog does and reports x where it must', () => {
    const res = trace({ source, top: 'm', clock: 'clk', stimulus: [{}] });
    // `r` is never assigned, so it is a floating net here (the `undriven` warning says so): its z bit now passes through the bit select and the splitter as z.
    expect(res.cycles[0]!.pre).toEqual({ v: 'z101', eq_known: '0', eq_unknown: 'x', mixed: '1xx0', masked: '0000', inv: 'xxxx' });
  });
});

describe('known difference from Verilog', () => {
  it('an if on an unknown condition merges both branches, where Verilog takes the else branch', () => {
    const source = `module m (input clk, output [3:0] cnt);
  reg r;
  reg [3:0] c;
  always @(posedge clk) if (r) c <= 1; else c <= 2;
  assign cnt = c;
endmodule`;
    const res = trace({ source, top: 'm', clock: 'clk', stimulus: [{}] });
    // Verilog gives 0010 here. No library part turns an unknown select into 0, so the circuit keeps what both branches agree on.
    expect(res.cycles[0]!.post.cnt).toBe('00xx');
  });
});

describe('errors', () => {
  it('returns the diagnostics when the source does not compile', () => {
    expect(() => trace({ source: 'module m (input a, output y); real r; assign y = a; endmodule', top: 'm', stimulus: [] })).toThrow(/not supported yet/);
  });

  it('rejects stimulus for unknown inputs or with the wrong width', async () => {
    const { runSimulator } = await import('../src');
    const src = 'module m (input [3:0] a, output [3:0] y); assign y = a; endmodule';
    expect(runSimulator({ source: src, top: 'm', stimulus: [{ nope: '1' }] })).toMatchObject({ ok: false });
    expect(runSimulator({ source: src, top: 'm', stimulus: [{ a: '11' }] })).toMatchObject({ ok: false });
    expect(runSimulator({ source: src, top: 'm', clock: 'zzz', stimulus: [] })).toMatchObject({ ok: false });
  });

  it('a combinational loop that settles reads as unknown, as in Verilog', () => {
    const res = trace({ source: 'module m (input a, output y); assign y = ~y; endmodule', top: 'm', stimulus: [{ a: '0' }] });
    expect(res.cycles[0]!.pre.y).toBe('x');
  });
});
