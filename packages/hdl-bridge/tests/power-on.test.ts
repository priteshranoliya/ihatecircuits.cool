import { compile } from '@ihatecircuits/hdl';
import { describe, expect, it } from 'vitest';
import { agreeWithIcarus, haveIcarus } from './against';

/**
 * Register power-on values (IEEE 1364-2005: a variable declaration assignment and an `initial` assignment both set the
 * value at time 0). Each form is run against Icarus on every back end; the first two samples show the value before any
 * clock edge, so a wrong power-on state cannot hide behind a later load.
 */

const stim = (n: number, d = '0000') => Array.from({ length: n }, (_, k) => ({ d: ((k * 3 + Number.parseInt(d, 2)) & 15).toString(2).padStart(4, '0') }));
const run = (source: string, n = 4) => agreeWithIcarus(source, stim(n), { clock: 'clk' });

describe.skipIf(!haveIcarus)('register power-on values against Icarus', () => {
  it('reg q = 4\'d5 in the body', async () => {
    const { ref } = await run('module top(input clk, input [3:0] d, output [3:0] o); reg [3:0] q = 4\'d5; always @(posedge clk) q <= d; assign o = q; endmodule');
    expect(ref[0]!.pre.o).toBe('0101');
    expect(ref[0]!.post.o).toBe('0000');
  });

  it('reg [3:0] q = 0 starts at 0, not x', async () => {
    const { ref } = await run('module top(input clk, input [3:0] d, output [3:0] o); reg [3:0] q = 0; always @(posedge clk) q <= q + d + 1; assign o = q; endmodule');
    expect(ref[0]!.pre.o).toBe('0000');
    expect(ref[0]!.post.o).toBe('0001');
  });

  it('an output reg with an initial value in the port list', async () => {
    const { ref } = await run('module top(input clk, input [3:0] d, output reg [3:0] q = 4\'d9); always @(posedge clk) q <= q ^ d; endmodule');
    expect(ref[0]!.pre.q).toBe('1001');
  });

  it('initial q = const;', async () => {
    const { ref } = await run('module top(input clk, input [3:0] d, output [3:0] o); reg [3:0] q; initial q = 4\'hA; always @(posedge clk) q <= q + d; assign o = q; endmodule');
    expect(ref[0]!.pre.o).toBe('1010');
  });

  it('initial begin ... end with several registers, bit and part selects, and a parameter', async () => {
    const { ref } = await run(
      `module top(input clk, input [3:0] d, output [3:0] o, output [3:0] p, output [3:0] r);
         parameter P = 3;
         reg [3:0] q, s, t;
         initial begin q = P + 1; s = 4'b0000; s[2] = 1'b1; t[3:2] = 2'b10; t[1:0] = 2'b01; end
         always @(posedge clk) begin q <= q + d; s <= s ^ d; t <= t + 1; end
         assign o = q; assign p = s; assign r = t;
       endmodule`,
    );
    expect([ref[0]!.pre.o, ref[0]!.pre.p, ref[0]!.pre.r]).toEqual(['0100', '0100', '1001']);
  });

  it('a declaration initial value and an initial block on the same reg: the block, which comes later, wins', async () => {
    const { ref } = await run('module top(input clk, input [3:0] d, output [3:0] o); reg [3:0] q = 4\'d1; initial q[3] = 1\'b1; always @(posedge clk) q <= d; assign o = q; endmodule');
    expect(ref[0]!.pre.o).toBe('1001');
  });

  it('an initial value with unknown bits keeps them unknown', async () => {
    const { ref } = await run('module top(input clk, input [3:0] d, output [3:0] o); reg [3:0] q = 4\'b1x01; always @(posedge clk) q <= d; assign o = q; endmodule');
    expect(ref[0]!.pre.o).toBe('1x01');
  });

  it('the constant is cut to the width of the reg, and a signed one is extended', async () => {
    const { ref } = await run(
      'module top(input clk, input [3:0] d, output [3:0] o, output [7:0] s); reg [3:0] q = 8\'hAB; reg [7:0] t = 4\'sb1000; always @(posedge clk) begin q <= d; t <= {4\'b0, d}; end assign o = q; assign s = t; endmodule',
    );
    expect([ref[0]!.pre.o, ref[0]!.pre.s]).toEqual(['1011', '11111000']);
  });

  it('a register with an asynchronous reset that is not active at power-on', async () => {
    const { ref } = await agreeWithIcarus(
      'module top(input clk, input rst, input [3:0] d, output reg [3:0] q = 4\'d5); always @(posedge clk or posedge rst) if (rst) q <= 4\'d0; else q <= d; endmodule',
      [{ rst: '0', d: '0011' }, { rst: '0', d: '0100' }, { rst: '1', d: '0101' }, { rst: '0', d: '0110' }],
      { clock: 'clk' },
    );
    expect(ref[0]!.pre.q).toBe('0101');
    expect(ref[2]!.pre.q).toBe('0000');
  });

  it('a register that reads itself starts from its initial value (a counter that does not need a reset)', async () => {
    const { ref } = await run('module top(input clk, input [3:0] d, output [3:0] o); reg [3:0] c = 0; always @(posedge clk) c <= c + 1; assign o = c; endmodule', 5);
    expect(ref.map((c) => c.post.o)).toEqual(['0001', '0010', '0011', '0100', '0101']);
  });
});

describe('what the compiler says about an initial value', () => {
  const diag = (source: string) => compile(source, { top: 'top' }).diagnostics;
  const wrap = (body: string) => `module top(input clk, input [3:0] d, output [3:0] o); ${body} endmodule`;

  it('no longer reports the value as ignored', () => {
    for (const body of [
      "reg [3:0] q = 4'd5; always @(posedge clk) q <= d; assign o = q;",
      'reg [3:0] q; initial q = 5; always @(posedge clk) q <= d; assign o = q;',
      'reg [3:0] q; initial begin q = 5; end always @(posedge clk) q <= d; assign o = q;',
    ]) {
      expect(diag(wrap(body)).filter((x) => x.code === 'ignored')).toEqual([]);
    }
  });

  it('puts the value on the register cell', () => {
    const design = compile(wrap("reg [3:0] q = 4'b1x01; always @(posedge clk) q <= d; assign o = q;"), { top: 'top' }).design!;
    const dff = design.modules[0]!.cells.find((c) => c.kind === 'dff');
    expect(dff).toMatchObject({ kind: 'dff', init: '1x01' });
  });

  it('a register with a known initial value is not unknown in an if condition', () => {
    const body = (init: string) => `reg [3:0] c ${init}; reg [3:0] r; always @(posedge clk) begin if (c[0]) r <= d; else r <= ~d; c <= c + 1; end assign o = r;`;
    expect(diag(wrap(body(''))).map((x) => x.code)).toContain('if-unknown-condition');
    expect(diag(wrap(body('= 0'))).map((x) => x.code)).not.toContain('if-unknown-condition');
  });

  it('refuses an initial value that is not a constant, and an initial block that sets a wire', () => {
    const e1 = diag(wrap('wire [3:0] w = d; reg [3:0] q = w; always @(posedge clk) q <= d; assign o = q;')).find((x) => x.severity === 'error');
    expect(e1?.code).toBe('not-constant');
    const e2 = diag(wrap("wire [3:0] w; assign w = d; initial w = 4'd1; assign o = w;")).find((x) => x.severity === 'error');
    expect(e2?.code).toBe('bad-assignment');
    const e3 = diag(wrap('reg [3:0] q; initial q = d; always @(posedge clk) q <= d; assign o = q;')).find((x) => x.severity === 'error');
    expect(e3?.code).toBe('not-synthesizable');
  });

  it('warns when an initial value has no clocked block to live in', () => {
    for (const body of ["reg [3:0] q = 4'd5; always @* q = d; assign o = q;", "reg [3:0] q = 4'd5; assign o = q;"]) {
      expect(diag(wrap(body)).filter((x) => x.code === 'ignored')).toHaveLength(1);
    }
  });
});
