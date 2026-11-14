import { describe } from 'vitest';
import { sem } from './helpers';

describe('module headers and declarations (IEEE 12.3, 3.2, 3.5)', () => {
  sem(
    'non-ANSI ports: separate input, output and reg declarations behind an ANSI wrapper',
    `module inner(a, b, y, z);
  input [3:0] a;
  input [3:0] b;
  output [3:0] y;
  output z;
  reg [3:0] y;
  wire z;
  always @* y = a & b;
  assign z = ^a;
endmodule
module top(input [3:0] a, input [3:0] b, output [3:0] y, output z);
  inner u (.a(a), .b(b), .y(y), .z(z));
endmodule`,
    'top',
  );

  sem(
    'non-ANSI ports: declaration lists, output reg, and positional connection in header order',
    `module inner(y, c, a, b);
  input [3:0] a, b;
  input c;
  output reg [3:0] y;
  always @* if (c) y = a + b; else y = a - b;
endmodule
module top(input [3:0] a, input [3:0] b, input c, output [3:0] y);
  inner u (y, c, a, b);
endmodule`,
    'top',
  );

  sem(
    'a net declaration assignment: wire w = a & b;',
    `module top(input [3:0] a, input [3:0] b, output [3:0] y, output [3:0] z);
  wire [3:0] w = a & b;
  wire [3:0] v = w + 4'd1;
  assign y = w;
  assign z = v;
endmodule`,
    'top',
  );

  sem(
    'several declarators with initialising assignments on one line',
    `module top(input [3:0] a, output [3:0] y, output [3:0] z);
  wire [3:0] w1 = a, w2 = ~a;
  wire s1, s2;
  assign s1 = a[0];
  assign s2 = a[1];
  assign y = w1 ^ {s1, s2, s1, s2};
  assign z = w2;
endmodule`,
    'top',
  );

  sem(
    'implicit nets: the left side of an assign and an instance port connection',
    `module and2(input a, input b, output y);
  assign y = a & b;
endmodule
module top(input a, input b, input c, output y, output z);
  and2 u1 (.a(a), .b(b), .y(imp));
  assign n = imp | c;
  assign y = n;
  assign z = imp;
endmodule`,
    'top',
  );

  sem(
    '`default_nettype none: a design that declares everything still compiles',
    `\`default_nettype none
module sub(input wire a, input wire b, output wire y);
  assign y = a ^ b;
endmodule
module top(input wire [1:0] a, output wire y);
  wire t;
  sub u (.a(a[0]), .b(a[1]), .y(t));
  assign y = ~t;
endmodule
\`default_nettype wire`,
    'top',
  );

  sem(
    'macros and conditional compilation',
    `\`define W 8
\`define ADD(x, y) ((x) + (y))
\`ifdef FAST
\`define MODE 1
\`else
\`define MODE 2
\`endif
module top(input [7:0] a, input [7:0] b, output [7:0] y);
  wire [\`W-1:0] t;
  assign t = \`ADD(a, b);
  assign y = t + \`MODE;
endmodule`,
    'top',
  );

  sem(
    'integer variables are 32 bit signed',
    `module top(input [3:0] a, output [7:0] y, output neg, output [7:0] big);
  integer k;
  integer n;
  always @* begin
    k = a - 8;
    n = a * 100000;
  end
  assign y = k;
  assign neg = k < 0;
  assign big = n >> 16;
endmodule`,
    'top',
  );
});

describe('net types (IEEE 4.2, 4.3)', () => {
  sem(
    'wand and wor resolve two drivers by AND and OR',
    `module top(input [3:0] a, input [3:0] b, output [3:0] y_and, output [3:0] y_or);
  wand [3:0] wa;
  wor [3:0] wo;
  assign wa = a;
  assign wa = b;
  assign wo = a;
  assign wo = b;
  assign y_and = wa;
  assign y_or = wo;
endmodule`,
    'top',
  );

  sem(
    'tri0 and tri1 read 0 and 1 where nothing drives',
    `module top(input en, input [3:0] a, output [3:0] y0, output [3:0] y1);
  tri0 [3:0] t0;
  tri1 [3:0] t1;
  assign t0 = en ? a : 4'bz;
  assign t1 = en ? a : 4'bz;
  assign y0 = t0;
  assign y1 = t1;
endmodule`,
    'top',
  );

  sem(
    'supply0 and supply1 are constant nets',
    `module top(input [1:0] a, output [3:0] y, output z);
  supply0 gnd;
  supply1 vdd;
  assign y = {vdd, a, gnd};
  and (z, a[0], vdd);
endmodule`,
    'top',
  );

  sem(
    'pullup and pulldown resolve an undriven net',
    `module top(input en, input a, output y_up, output y_down);
  wire up, down;
  pullup (up);
  pulldown (down);
  assign up = en ? a : 1'bz;
  assign down = en ? a : 1'bz;
  assign y_up = up;
  assign y_down = down;
endmodule`,
    'top',
  );

  sem(
    'a net aliased through assign statements',
    `module top(input [3:0] a, output [3:0] y);
  wire [3:0] p, q;
  assign y = q;
  assign q = p;
  assign p = a;
endmodule`,
    'top',
  );

  sem(
    'part-select and concatenation targets of a continuous assignment',
    `module top(input [3:0] a, input [3:0] b, input c, input d, output [3:0] y, output co, output [3:0] s);
  assign y[3:2] = a[1:0];
  assign y[1] = c;
  assign y[0] = d;
  assign {co, s} = a + b;
endmodule`,
    'top',
  );
});

describe('instances (IEEE 12.1, 12.3.5, 7.1.5)', () => {
  const sub = `module sub(input [3:0] a, input [3:0] b, output [3:0] y);
  assign y = a - b;
endmodule`;

  sem(
    'positional and named connections of the same module',
    `${sub}
module top(input [3:0] a, input [3:0] b, output [3:0] y1, output [3:0] y2);
  sub u1 (a, b, y1);
  sub u2 (.b(a), .a(b), .y(y2));
endmodule`,
    'top',
  );

  sem(
    'an unconnected output port',
    `module two(input [3:0] a, output [3:0] y, output z);
  assign y = ~a;
  assign z = ^a;
endmodule
module top(input [3:0] a, output [3:0] y);
  two u (.a(a), .y(y), .z());
endmodule`,
    'top',
  );

  sem(
    'connection widths: a narrow actual is zero-extended, a wide actual truncated',
    `module sub4(input [3:0] a, output [3:0] y);
  assign y = a + 4'd1;
endmodule
module top(input [1:0] n, input [5:0] w, output [3:0] y1, output [1:0] y2);
  sub4 u1 (.a(n), .y(y1));
  sub4 u2 (.a(w), .y(y2));
endmodule`,
    'top',
  );

  sem(
    'three levels of hierarchy with a module used twice at each level',
    `module leaf(input [3:0] a, output [3:0] y);
  assign y = a + 4'd3;
endmodule
module mid(input [3:0] a, output [3:0] y);
  wire [3:0] t;
  leaf l1 (.a(a), .y(t));
  leaf l2 (.a(t), .y(y));
endmodule
module top(input [3:0] a, output [3:0] y, output [3:0] z);
  wire [3:0] t;
  mid m1 (.a(a), .y(t));
  mid m2 (.a(t), .y(y));
  assign z = t;
endmodule`,
    'top',
  );

  sem(
    'a module defined after the module that instantiates it',
    `module top(input [3:0] a, output [3:0] y);
  later u (.a(a), .y(y));
endmodule
module later(input [3:0] a, output [3:0] y);
  assign y = a << 1;
endmodule`,
    'top',
  );

  sem(
    'an instance array of a one bit module over a four bit bus',
    `module inv(input a, output y);
  assign y = ~a;
endmodule
module top(input [3:0] a, output [3:0] y);
  inv u [3:0] (.a(a), .y(y));
endmodule`,
    'top',
  );

  sem(
    'an instance array broadcasts a scalar connection to every instance',
    `module and2(input a, input b, output y);
  assign y = a & b;
endmodule
module top(input [3:0] a, input en, output [3:0] y);
  and2 g [3:0] (.a(a), .b(en), .y(y));
endmodule`,
    'top',
  );

  sem(
    'an instance array of a vector module slices the bus',
    `module inc(input [1:0] a, output [1:0] y);
  assign y = a + 2'd1;
endmodule
module top(input [5:0] a, output [5:0] y);
  inc u [2:0] (.a(a), .y(y));
endmodule`,
    'top',
  );
});

describe('gate primitives (IEEE 7)', () => {
  sem(
    'and or nand nor xor xnor with two inputs',
    `module top(input a, input b, output y_and, output y_or, output y_nand, output y_nor, output y_xor, output y_xnor);
  and g1 (y_and, a, b);
  or g2 (y_or, a, b);
  nand g3 (y_nand, a, b);
  nor g4 (y_nor, a, b);
  xor g5 (y_xor, a, b);
  xnor g6 (y_xnor, a, b);
endmodule`,
    'top',
  );

  sem(
    'gates with three and four inputs, xor is parity',
    `module top(input a, input b, input c, input d, output y_and4, output y_nand4, output y_nor3, output y_xor3, output y_xnor3, output y_or4);
  and g1 (y_and4, a, b, c, d);
  nand g2 (y_nand4, a, b, c, d);
  nor g3 (y_nor3, a, b, c);
  xor g4 (y_xor3, a, b, c);
  xnor g5 (y_xnor3, a, b, c);
  or g6 (y_or4, a, b, c, d);
endmodule`,
    'top',
  );

  sem(
    'buf and not, including several outputs and unnamed gates',
    `module top(input a, output y_buf, output b1, output b2, output y_not, output n1, output n2);
  buf (y_buf, a);
  buf (b1, b2, a);
  not (y_not, a);
  not (n1, n2, a);
endmodule`,
    'top',
  );

  sem(
    'bufif0 bufif1 notif0 notif1 drive z while disabled',
    `module top(input a, input en, output y_bufif1, output y_bufif0, output y_notif1, output y_notif0);
  bufif1 (y_bufif1, a, en);
  bufif0 (y_bufif0, a, en);
  notif1 (y_notif1, a, en);
  notif0 (y_notif0, a, en);
endmodule`,
    'top',
  );

  sem(
    'gate arrays over a vector',
    `module top(input [3:0] a, input [3:0] b, output [3:0] y_and, output [3:0] y_not);
  and ga [3:0] (y_and, a, b);
  not gn [3:0] (y_not, a);
endmodule`,
    'top',
  );

  sem(
    'gates wired into a small network through internal nets',
    `module top(input a, input b, input c, output y);
  wire t1, t2;
  nand (t1, a, b);
  nor (t2, b, c);
  xor (y, t1, t2);
endmodule`,
    'top',
  );
});

describe('generate constructs (IEEE 12.4)', () => {
  sem(
    'generate for with a genvar and a named scope reverses a vector',
    `module top(input [7:0] a, output [7:0] y);
  genvar i;
  generate
    for (i = 0; i < 8; i = i + 1) begin : rev
      assign y[i] = a[7 - i];
    end
  endgenerate
endmodule`,
    'top',
  );

  sem(
    'generate for containing a generate if on the genvar',
    `module top(input [7:0] a, output [7:0] y);
  genvar i;
  generate
    for (i = 0; i < 8; i = i + 1) begin : g
      if (i % 2 == 0) begin : even
        assign y[i] = a[i];
      end else begin : odd
        assign y[i] = ~a[i];
      end
    end
  endgenerate
endmodule`,
    'top',
  );

  sem(
    'nested generate for loops build an outer product',
    `module top(input [1:0] a, input [1:0] b, output [3:0] y);
  genvar i, j;
  generate
    for (i = 0; i < 2; i = i + 1) begin : outer
      for (j = 0; j < 2; j = j + 1) begin : inner
        assign y[i * 2 + j] = a[i] & b[j];
      end
    end
  endgenerate
endmodule`,
    'top',
  );

  sem(
    'generate case selects one implementation per instance',
    `module pick #(parameter W = 2) (input [3:0] a, output [3:0] y);
  generate
    case (W)
      1: begin : one
        assign y = a;
      end
      2: begin : two
        assign y = ~a;
      end
      default: begin : other
        assign y = 4'b0101;
      end
    endcase
  endgenerate
endmodule
module top(input [3:0] a, output [3:0] y1, output [3:0] y2, output [3:0] y3);
  pick #(1) p1 (a, y1);
  pick #(2) p2 (a, y2);
  pick #(3) p3 (a, y3);
endmodule`,
    'top',
  );

  sem(
    'a generate ripple-carry adder from full adder instances',
    `module fa(input a, input b, input ci, output s, output co);
  assign s = a ^ b ^ ci;
  assign co = (a & b) | (ci & (a ^ b));
endmodule
module top(input [7:0] a, input [7:0] b, input cin, output [7:0] s, output cout);
  parameter N = 8;
  wire [N:0] c;
  assign c[0] = cin;
  genvar i;
  generate
    for (i = 0; i < N; i = i + 1) begin : stage
      fa u (.a(a[i]), .b(b[i]), .ci(c[i]), .s(s[i]), .co(c[i + 1]));
    end
  endgenerate
  assign cout = c[N];
endmodule`,
    'top',
  );

  sem(
    'a genvar drives a parameter override of each generated instance',
    `module addk #(parameter K = 0) (input [3:0] a, output [3:0] y);
  assign y = a + K;
endmodule
module top(input [3:0] a, output [15:0] ys);
  genvar i;
  generate
    for (i = 0; i < 4; i = i + 1) begin : g
      addk #(.K(i * 3)) u (.a(a), .y(ys[i * 4 +: 4]));
    end
  endgenerate
endmodule`,
    'top',
  );

  sem(
    'generate for creating registers',
    `module top(input clk, input rst, input [3:0] d, output reg [3:0] q);
  genvar i;
  generate
    for (i = 0; i < 4; i = i + 1) begin : bit_reg
      always @(posedge clk) begin
        if (rst) q[i] <= 1'b0;
        else q[i] <= d[i] ^ q[(i + 1) % 4];
      end
    end
  endgenerate
endmodule`,
    'top',
    { ones: { rst: 0.2 }, prefix: [{ rst: '1', d: '0000' }] },
  );

  sem(
    'hierarchical reference to a name inside a generate for scope: gen[2].x',
    `module top(input [3:0] a, input [3:0] b, output y, output z);
  genvar i;
  generate
    for (i = 0; i < 4; i = i + 1) begin : gen
      wire x;
      assign x = a[i] ^ b[i];
    end
  endgenerate
  assign y = gen[2].x & gen[0].x;
  assign z = gen[3].x | ~gen[1].x;
endmodule`,
    'top',
  );

  sem(
    'hierarchical reference to a name inside a generate if scope',
    `module top(input [3:0] a, output [3:0] y);
  parameter FLIP = 1;
  generate
    if (FLIP) begin : blk
      wire [3:0] w;
      assign w = ~a;
    end else begin : alt
      wire [3:0] w;
      assign w = a;
    end
  endgenerate
  assign y = blk.w + 4'd1;
endmodule`,
    'top',
  );
});
