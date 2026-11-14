import { describe, expect, it } from 'vitest';
import { compileDiags, sem } from './helpers';

describe('tri-state drivers and resolution (IEEE 4.3, 7.9)', () => {
  sem(
    'assign y = en ? a : 4\'bz drives z while disabled',
    `module top(input en, input [3:0] a, output [3:0] y);
  assign y = en ? a : 4'bz;
endmodule`,
    'top',
  );

  sem(
    'a bus with two tri-state drivers and complementary enables',
    `module top(input en, input [3:0] a, input [3:0] b, output [3:0] y);
  tri [3:0] bus;
  assign bus = en ? a : 4'bz;
  assign bus = en ? 4'bz : b;
  assign y = bus;
endmodule`,
    'top',
  );

  sem(
    'three drivers: equal values agree, different values give x, no driver gives z',
    `module top(input [2:0] en, input [1:0] a, input [1:0] b, input [1:0] c, output [1:0] y);
  wire [1:0] bus;
  assign bus = en[0] ? a : 2'bz;
  assign bus = en[1] ? b : 2'bz;
  assign bus = en[2] ? c : 2'bz;
  assign y = bus;
endmodule`,
    'top',
    { minKnown: 0.5 },
  );

  sem(
    'a pull-up resolves an undriven bit of a bus',
    `module top(input en, input [2:0] a, output [3:0] y);
  wire [3:0] w;
  assign w[2:0] = en ? a : 3'bz;
  assign w[3] = 1'bz;
  pullup (w[3]);
  assign y = w;
endmodule`,
    'top',
    { zAsX: true },
  );

  sem(
    'a pull-down resolves a disabled driver',
    `module top(input en, input [1:0] a, output [1:0] y);
  wire [1:0] w;
  assign w = en ? a : 2'bz;
  pulldown (w[0]);
  assign y = w;
endmodule`,
    'top',
    { zAsX: true },
  );

  sem(
    'different bits of one vector driven by different tri-state expressions',
    `module top(input en, input [1:0] a, input [1:0] b, output [3:0] y);
  assign y[1:0] = en ? a : 2'bz;
  assign y[3:2] = en ? 2'bz : b;
endmodule`,
    'top',
    { zAsX: true },
  );

  sem(
    'bufif1 gates as the two drivers of a bus',
    `module top(input en, input a, input b, output y);
  wire bus;
  bufif1 (bus, a, en);
  bufif0 (bus, b, en);
  assign y = bus;
endmodule`,
    'top',
  );

  sem(
    'z assigned in a combinational always block',
    `module top(input en, input [3:0] a, output reg [3:0] y);
  always @* begin
    if (en) y = a;
    else y = 4'bz;
  end
endmodule`,
    'top',
  );

  sem(
    'z passes through a module output and a continuous assignment',
    `module drv(input en, input [3:0] a, output [3:0] y);
  assign y = en ? a : 4'bz;
endmodule
module top(input en, input [3:0] a, output [3:0] y);
  wire [3:0] t;
  drv u (.en(en), .a(a), .y(t));
  assign y = t;
endmodule`,
    'top',
  );

  it('two instance outputs on one bus are a multiple-drivers error: an instance output is an ordinary driver, only tri-state cells may share a net', () => {
    const src = `module drv(input en, input [3:0] a, output [3:0] y);
  assign y = en ? a : 4'bz;
endmodule
module top(input sel, input [3:0] a, input [3:0] b, output [3:0] y);
  wire [3:0] bus;
  drv u1 (.en(sel), .a(a), .y(bus));
  drv u2 (.en(~sel), .a(b), .y(bus));
  assign y = bus;
endmodule`;
    const errs = compileDiags(src).filter((d) => d.severity === 'error');
    expect(errs.map((d) => d.code)).toEqual(['multiple-drivers']);
    expect(errs[0]!.message).toContain('bus');
  });
});
