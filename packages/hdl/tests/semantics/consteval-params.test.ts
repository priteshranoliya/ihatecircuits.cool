import { describe } from 'vitest';
import { sem } from './helpers';

describe('parameters: type, range and signedness (IEEE 4.10, 12.2)', () => {
  sem(
    'a signed parameter makes a comparison with a signed input signed',
    `module top(input signed [3:0] a, output lt, output [7:0] w);
  parameter signed [3:0] K = -3;
  assign lt = a < K;
  assign w = K;
endmodule`,
    'top',
  );

  sem(
    'a ranged parameter truncates its value to the range',
    `module top(input [7:0] a, output [7:0] y, output [7:0] z);
  parameter [3:0] P = 20;
  parameter integer I = 300;
  assign y = a + P;
  assign z = a ^ I;
endmodule`,
    'top',
  );

  sem(
    'an unsized unranged parameter takes the width of its value, an integer parameter is 32 bit signed',
    `module top(input [3:0] a, output [7:0] y, output neg);
  parameter integer I = -5;
  parameter U = 9;
  localparam signed [7:0] S = 8'shF0;
  assign y = a + U;
  assign neg = (I < 0) & (S < 0);
endmodule`,
    'top',
  );

  sem(
    'a parameter defined from an earlier parameter follows its override',
    `module sub #(parameter A = 4, parameter B = A * 2 + 1) (input [7:0] x, output [7:0] y);
  assign y = x + B;
endmodule
module top(input [7:0] x, output [7:0] y0, output [7:0] y1);
  sub u0 (.x(x), .y(y0));
  sub #(.A(5)) u1 (.x(x), .y(y1));
endmodule`,
    'top',
  );
});

describe('parameter overrides (IEEE 12.2)', () => {
  const add = `module add #(parameter W = 4) (input [W-1:0] a, input [W-1:0] b, output [W:0] s);
  assign s = a + b;
endmodule`;

  sem(
    'override by name, by position and by default in one design',
    `${add}
module top(input [7:0] a, input [7:0] b, output [6:0] s6, output [8:0] s8, output [4:0] s4);
  add #(.W(6)) u6 (.a(a[5:0]), .b(b[5:0]), .s(s6));
  add #(8) u8 (a, b, s8);
  add u4 (a[3:0], b[3:0], s4);
endmodule`,
    'top',
  );

  sem(
    'a parameterised module instantiated at two widths in the same design',
    `module inv #(parameter W = 1) (input [W-1:0] a, output [W-1:0] y);
  localparam MSB = W - 1;
  assign y = {~a[MSB], a[MSB-1:0]};
endmodule
module top(input [2:0] a, input [11:0] b, output [2:0] ya, output [11:0] yb);
  inv #(3) narrow (.a(a), .y(ya));
  inv #(12) wide (.a(b), .y(yb));
endmodule`,
    'top',
  );

  sem(
    'positional overrides fill parameters in declaration order',
    `module sub #(parameter A = 1, parameter B = 2, parameter C = 3) (input [7:0] x, output [7:0] y);
  assign y = x * A + B - C;
endmodule
module top(input [7:0] x, output [7:0] y0, output [7:0] y1, output [7:0] y2);
  sub #(5) u0 (x, y0);
  sub #(5, 7) u1 (x, y1);
  sub #(.C(1), .A(2)) u2 (x, y2);
endmodule`,
    'top',
  );

  sem(
    'defparam to a direct child changes only that instance',
    `module inc #(parameter D = 1) (input [7:0] a, output [7:0] y);
  assign y = a + D;
endmodule
module top(input [7:0] a, output [7:0] y1, output [7:0] y2);
  inc u1 (.a(a), .y(y1));
  inc u2 (.a(a), .y(y2));
  defparam u2.D = 7;
endmodule`,
    'top',
  );

  sem(
    'a parameter in the header of the module with ANSI ports and a localparam derived from it',
    `module sub #(parameter DEPTH = 10) (input [$clog2(DEPTH)-1:0] addr, output [7:0] y);
  localparam AW = $clog2(DEPTH);
  localparam [3:0] AW4 = AW;
  assign y = {addr, AW4};
endmodule
module top(input [3:0] addr, output [7:0] y);
  sub #(.DEPTH(12)) u (.addr(addr), .y(y));
endmodule`,
    'top',
  );

  sem(
    'a generate if on an overridden parameter selects the implementation of each instance',
    `module op #(parameter MODE = 0) (input [3:0] a, input [3:0] b, output [3:0] y);
  generate
    if (MODE == 0) begin : g_add
      assign y = a + b;
    end else if (MODE == 1) begin : g_sub
      assign y = a - b;
    end else begin : g_and
      assign y = a & b;
    end
  endgenerate
endmodule
module top(input [3:0] a, input [3:0] b, output [3:0] y0, output [3:0] y1, output [3:0] y2);
  op #(.MODE(0)) u0 (a, b, y0);
  op #(.MODE(1)) u1 (a, b, y1);
  op #(.MODE(2)) u2 (a, b, y2);
endmodule`,
    'top',
  );
});

describe('constant system functions and constant functions (IEEE 17.11, 10.3.5)', () => {
  sem(
    '$clog2 rounds up to the next power of two exponent',
    `module top(input [1:0] sel, output [7:0] y);
  localparam A = $clog2(1);
  localparam B = $clog2(2);
  localparam C = $clog2(9);
  localparam D = $clog2(1025);
  assign y = sel == 0 ? A : sel == 1 ? B : sel == 2 ? C : D;
endmodule`,
    'top',
  );

  sem(
    '$clog2 of a parameter sizes a vector',
    `module top(input [7:0] a, output [7:0] y);
  parameter DEPTH = 10;
  localparam AW = $clog2(DEPTH);
  wire [AW-1:0] idx;
  assign idx = a[AW-1:0];
  assign y = {4'b0, idx};
endmodule`,
    'top',
  );

  sem(
    'a constant function with a for loop',
    `module top(input [3:0] a, output [15:0] y);
  function integer fact(input integer n);
    integer i;
    begin
      fact = 1;
      for (i = 2; i <= n; i = i + 1) fact = fact * i;
    end
  endfunction
  localparam F5 = fact(5);
  localparam F3 = fact(3);
  assign y = a * F3 + F5;
endmodule`,
    'top',
  );

  sem(
    'a constant function with a while loop sizes a range',
    `module top(input [7:0] a, output [10:0] y);
  function integer clog2(input integer v);
    integer t;
    begin
      t = v - 1;
      clog2 = 0;
      while (t > 0) begin
        clog2 = clog2 + 1;
        t = t >> 1;
      end
    end
  endfunction
  localparam W = clog2(100);
  localparam [3:0] W4 = W;
  wire [W-1:0] low;
  assign low = a[W-1:0];
  assign y = {W4, 1'b0, low[W-2:0]};
endmodule`,
    'top',
  );

  sem(
    'a recursive automatic constant function',
    `module top(input [3:0] a, output [15:0] y);
  function automatic integer fib(input integer n);
    begin
      if (n < 2) fib = n;
      else fib = fib(n - 1) + fib(n - 2);
    end
  endfunction
  localparam FB = fib(10);
  assign y = a + (FB << 8);
endmodule`,
    'top',
  );

  sem(
    'a constant function picks a parameter value from a table',
    `module top(input [3:0] a, output [7:0] y);
  function [7:0] pick(input [1:0] i);
    case (i)
      0: pick = 8'd10;
      1: pick = 8'd20;
      2: pick = 8'd30;
      default: pick = 8'd40;
    endcase
  endfunction
  localparam P = pick(2);
  localparam Q = pick(7);
  assign y = a + P + Q;
endmodule`,
    'top',
  );
});

describe('constant expressions in ranges, replications and generate conditions (IEEE 4.1.3, 12.4)', () => {
  sem(
    'range bounds, replication counts and a generate if are constant expressions',
    `module top(input [3:0] a, output [7:0] y, output z);
  localparam N = 2 + 1;
  wire [N*2-1:0] w;
  assign w = {N{a[1:0]}};
  assign y = {2'b0, w};
  generate
    if (N > 2) begin : big
      assign z = a[0];
    end else begin : tiny
      assign z = a[1];
    end
  endgenerate
endmodule`,
    'top',
  );

  sem(
    'constant operators: ternary, shifts, comparison, logical, bitwise and modulo',
    `module top(input [7:0] a, output [7:0] y);
  parameter X = (3 > 2) ? 10 : 20;
  parameter Y = X % 4 + (1 << 4 | 3);
  parameter Z = (Y >= 20 && X != 11) ? 7 : 9;
  parameter V = ~0 & 8'hF0;
  assign y = a + X + Y + Z + V;
endmodule`,
    'top',
  );

  sem(
    'a parameter used as a bit index and a part-select base',
    `module top(input [15:0] a, output [3:0] y, output b);
  parameter LO = 6;
  parameter HI = LO + 3;
  assign y = a[HI:LO];
  assign b = a[LO + 2];
endmodule`,
    'top',
  );

  sem(
    'a generate for whose bound is a parameter expression',
    `module top(input [7:0] a, output [7:0] y);
  parameter N = 4;
  genvar i;
  generate
    for (i = 0; i < N * 2; i = i + 1) begin : g
      assign y[i] = a[N * 2 - 1 - i];
    end
  endgenerate
endmodule`,
    'top',
  );
});

describe('constants wider than 32 bits (IEEE 4.1, 5.1.5)', () => {
  sem(
    '64 bit parameter arithmetic wraps at 64 bits and feeds narrow results',
    `module top(input [7:0] a, output [7:0] y, output [7:0] z);
  localparam [63:0] BIG = 64'hDEAD_BEEF_0123_4567;
  localparam [63:0] P = BIG * 3 + 64'd12345;
  localparam [7:0] LO = P >> 24;
  localparam [7:0] HI = P >> 56;
  assign y = a ^ LO;
  assign z = a + HI;
endmodule`,
    'top',
  );

  sem(
    '96 bit parameter division and shift',
    `module top(input [7:0] a, output [7:0] y);
  localparam [95:0] W96 = {32'h1, 64'h0};
  localparam [7:0] D3 = (W96 / 3) >> 16;
  localparam [7:0] M7 = W96 % 7;
  assign y = a + D3 + M7;
endmodule`,
    'top',
  );

  sem(
    'a power in a wide constant context',
    `module top(input [7:0] a, output [7:0] y);
  localparam [63:0] E = 64'd2 ** 40;
  localparam [7:0] LO = E >> 36;
  assign y = a ^ LO;
endmodule`,
    'top',
  );
});
