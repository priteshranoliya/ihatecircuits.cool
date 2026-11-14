import type { TraceResult } from '@ihatecircuits/hdl/trace';
import { describe, expect, it } from 'vitest';
import { parseTopPorts } from '../src/header';
import { iverilogAvailable, iverilogRunner } from '../src/iverilog';

describe('parseTopPorts', () => {
  it('reads direction, width and carry-over from an ANSI header', () => {
    const src = `// header
module top (
  input clk, /* clock */
  input [7:0] a, b,
  input [0:0] one,
  output reg [3:0] q,
  output wire y
);
endmodule`;
    expect(parseTopPorts(src, 'top').map(({ name, dir, width }) => [name, dir, width])).toEqual([
      ['clk', 'in', 1],
      ['a', 'in', 8],
      ['b', 'in', 8],
      ['one', 'in', 1],
      ['q', 'out', 4],
      ['y', 'out', 1],
    ]);
  });

  it('picks the named module and rejects non-ANSI headers', () => {
    const src = 'module a(input x, output y); endmodule\nmodule b(input [2:0] p, output q); endmodule';
    expect(parseTopPorts(src, 'b').map((p) => p.width)).toEqual([3, 1]);
    expect(() => parseTopPorts('module c(x, y); input x; output y; endmodule', 'c')).toThrow(/ANSI/);
    expect(() => parseTopPorts(src, 'missing')).toThrow(/not found/);
  });
});

describe.skipIf(!iverilogAvailable())('iverilogRunner', () => {
  const expectOk = (r: TraceResult) => {
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  it('combinational 8-bit add keeps the carry in a 9-bit result', async () => {
    const r = expectOk(
      await iverilogRunner({
        source: 'module add8(input [7:0] a, input [7:0] b, output [8:0] s);\n  assign s = a + b;\nendmodule\n',
        top: 'add8',
        stimulus: [
          { a: '11111111', b: '00000001' },
          { a: '01100100', b: '00011011' },
          { a: '10000000', b: '10000000' },
          { a: '00000000', b: '00000000' },
        ],
      }),
    );
    expect(r.ports).toEqual([
      { name: 'a', width: 8, dir: 'in' },
      { name: 'b', width: 8, dir: 'in' },
      { name: 's', width: 9, dir: 'out' },
    ]);
    const sums = ['100000000', '001111111', '100000000', '000000000'];
    expect(r.cycles).toEqual(sums.map((s) => ({ pre: { s }, post: { s } })));
  });

  it('4-bit counter with synchronous reset: x before the first edge, wraps at 16, resets', async () => {
    const source = `module counter(input clk, input rst, input en, output reg [3:0] q);
  always @(posedge clk) begin
    if (rst) q <= 4'd0;
    else if (en) q <= q + 4'd1;
  end
endmodule
`;
    const stim: Array<[string, string]> = [['1', '0'], ['0', '1'], ['0', '1'], ['0', '0'], ['0', '1']];
    for (let k = 5; k < 18; k++) stim.push(['0', '1']);
    stim.push(['0', '1'], ['1', '1']);
    const r = expectOk(await iverilogRunner({ source, top: 'counter', clock: 'clk', stimulus: stim.map(([rst, en]) => ({ rst, en })) }));
    const hand: Array<[string, string]> = [
      ['xxxx', '0000'], ['0000', '0001'], ['0001', '0010'], ['0010', '0010'], ['0010', '0011'],
      ['0011', '0100'], ['0100', '0101'], ['0101', '0110'], ['0110', '0111'], ['0111', '1000'], ['1000', '1001'],
      ['1001', '1010'], ['1010', '1011'], ['1011', '1100'], ['1100', '1101'], ['1101', '1110'], ['1110', '1111'],
      ['1111', '0000'], ['0000', '0001'], ['0001', '0000'],
    ];
    expect(r.cycles).toEqual(hand.map(([pre, post]) => ({ pre: { q: pre }, post: { q: post } })));
    expect(r.ports.map((p) => p.name)).toEqual(['clk', 'rst', 'en', 'q']);
  });

  it('4:1 mux selects each input; an omitted input holds its previous value', async () => {
    const source = `module mux4(input [1:0] sel, input [3:0] a, input [3:0] b, input [3:0] c, input [3:0] d, output [3:0] y);
  assign y = sel[1] ? (sel[0] ? d : c) : (sel[0] ? b : a);
endmodule
`;
    const data = { a: '0001', b: '0010', c: '0100', d: '1000' };
    const r = expectOk(
      await iverilogRunner({
        source,
        top: 'mux4',
        stimulus: [{ ...data, sel: '00' }, { sel: '01' }, { sel: '10' }, { sel: '11' }, { sel: '11', d: '1111' }],
      }),
    );
    expect(r.cycles.map((c) => c.pre.y)).toEqual(['0001', '0010', '0100', '1000', '1111']);
    expect(r.cycles.map((c) => c.post.y)).toEqual(['0001', '0010', '0100', '1000', '1111']);
  });

  it('keeps x and z in the sampled values', async () => {
    const r = expectOk(
      await iverilogRunner({
        source: 'module xz(input a, output y, output [1:0] z);\n  assign y = 1\'bx;\n  assign z = {a, 1\'bz};\nendmodule\n',
        top: 'xz',
        stimulus: [{ a: '1' }],
      }),
    );
    expect(r.cycles[0]!.pre).toEqual({ y: 'x', z: '1z' });
  });

  it('returns the compiler message for a design that does not compile', async () => {
    const r = await iverilogRunner({ source: 'module bad(input a, output y);\n  assign y = nope;\nendmodule\n', top: 'bad', stimulus: [{ a: '0' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nope/);
  });

  it('rejects stimulus that does not fit the ports', async () => {
    const source = 'module t(input [1:0] a, output y);\n  assign y = a[0];\nendmodule\n';
    const wrongWidth = await iverilogRunner({ source, top: 't', stimulus: [{ a: '1' }] });
    expect(wrongWidth.ok).toBe(false);
    const unknown = await iverilogRunner({ source, top: 't', stimulus: [{ nope: '1' }] });
    expect(unknown.ok).toBe(false);
  });
});
