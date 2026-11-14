import { describe, expect, it } from 'vitest';
import { agreeWithIcarus, haveIcarus } from './against';

/**
 * A floating (z) bit passes through wiring: widening, narrowing, bit and part selects, concatenation and instance
 * ports. Each case is run against Icarus on every back end, and the standard's answer is pinned. (A register or an
 * operator reads z as x, which these cases do not touch.)
 */

const once = (source: string) => agreeWithIcarus(source, [{}]);

describe.skipIf(!haveIcarus)('z passes through wiring, against Icarus', () => {
  it('assign o1 = w1 widens a floating bit to 00000z', async () => {
    const { ref } = await once('module top(output [5:0] o1); wire w1; assign o1 = w1; endmodule');
    expect(ref[0]!.pre.o1).toBe('00000z');
  });

  it('a narrower target keeps the low floating bits', async () => {
    const { ref } = await once('module top(output [1:0] o); wire [3:0] w; assign o = w; endmodule');
    expect(ref[0]!.pre.o).toBe('zz');
  });

  it('bit and part selects of a floating bus', async () => {
    const { ref } = await once('module top(output b, output [2:0] p, output [5:0] q, output [1:0] r); wire [5:0] w; assign b = w[3]; assign p = w[4:2]; assign q = {w[1:0], w[5:2]}; assign r = w[0 +: 2]; endmodule');
    expect([ref[0]!.pre.b, ref[0]!.pre.p, ref[0]!.pre.q, ref[0]!.pre.r]).toEqual(['z', 'zzz', 'zzzzzz', 'zz']);
  });

  it('concatenations mix driven and floating parts', async () => {
    const { ref } = await once('module top(input [1:0] a, output [6:0] o, output [3:0] p); wire [1:0] w; wire u; assign o = {a, w, 3\'b101}; assign p = {u, a, u}; endmodule');
    expect([ref[0]!.pre.o, ref[0]!.pre.p]).toEqual(['00zz101', 'z00z']);
  });

  it('replication and a sign-extended signed net', async () => {
    const { ref } = await once('module top(output [3:0] o, output [5:0] s); wire w; wire signed [1:0] t; assign o = {4{w}}; assign s = t; endmodule');
    expect(ref[0]!.pre.o).toBe('zzzz');
    expect(ref[0]!.pre.s).toBe('zzzzzz');
  });

  it('through an instance port of a different width', async () => {
    const { ref } = await once(
      'module sub(input [1:0] x, output [3:0] y); assign y = {x, x}; endmodule module top(output [5:0] o); wire w; wire [3:0] r; sub u(.x(w), .y(r)); assign o = r; endmodule',
    );
    expect(ref[0]!.pre.o).toBe('000z0z');
  });

  it('a tri-state driver that is off, widened', async () => {
    const { ref } = await agreeWithIcarus('module top(input en, input [1:0] d, output [3:0] o); wire [1:0] t; assign t = en ? d : 2\'bz; assign o = t; endmodule', [{ en: '0', d: '10' }, { en: '1', d: '10' }]);
    expect([ref[0]!.pre.o, ref[1]!.pre.o]).toEqual(['00zz', '0010']);
  });
});
