/** Designs used by several test files. Each is inside the supported slice. */
export const COUNTER = `module counter (input clk, input rst, input en, output reg [3:0] q);
  always @(posedge clk) begin
    if (rst) q <= 4'd0;
    else if (en) q <= q + 1;
  end
endmodule`;

export const ADDER = `module add (input [7:0] a, input [7:0] b, output [8:0] y);
  assign y = a + b;
endmodule`;

export const TWICE = `module add4 (input [3:0] a, input [3:0] b, output [4:0] s);
  assign s = a + b;
endmodule
module top (input [3:0] a, input [3:0] b, input [3:0] c, output [4:0] ab, output [4:0] bc, output [5:0] all);
  add4 u1 (.a(a), .b(b), .s(ab));
  add4 u2 (.a(b), .b(c), .s(bc));
  assign all = ab + c;
endmodule`;

export const MUX = `module mux (input [7:0] a, input [7:0] b, input s, input [1:0] t, output [7:0] y, output [7:0] z);
  assign y = s ? a : b;
  assign z = t ? (t == 2'd3 ? a : b) : 8'hAA;
endmodule`;

/** Wide values, slices, concatenation and a registered submodule, to stress layout and export. */
export const BUSY = `module acc (input clk, input rst, input [15:0] d, output reg [15:0] sum, output big);
  wire [15:0] next;
  assign next = sum + d;
  assign big = next[15];
  always @(posedge clk) begin
    if (rst) sum <= 16'd0;
    else sum <= next;
  end
endmodule
module top (input clk, input rst, input [31:0] x, input [31:0] y, output [31:0] mix, output same, output zero, output [16:0] wide, output [15:0] total, output flag, output [7:0] mid);
  wire [15:0] lo;
  wire [15:0] hi;
  assign lo = x[15:0] ^ y[15:0];
  assign hi = x[31:16] & ~y[31:16];
  assign mix = {hi, lo};
  assign same = x == y;
  assign zero = x[7:0] != 8'd0 ? 1'b0 : 1'b1;
  assign wide = {1'b0, x[15:0]} + y[15:0];
  assign mid = x[23:16] | y[7:0];
  acc u (.clk(clk), .rst(rst), .d(lo), .sum(total), .big(flag));
endmodule`;

/** Odd shapes: wide comparisons, a wide condition, repeated parts in a concatenation, constants, three levels of hierarchy, a shift register, an unused input and an unconnected port. */
export const EDGY = `module leaf (input [3:0] a, output [3:0] y, output p);
  assign y = ~a;
  assign p = a[0];
endmodule
module mid (input [3:0] a, input [3:0] b, output [3:0] y, output q);
  wire [3:0] t;
  wire pl;
  leaf l1 (.a(a), .y(t), .p(pl));
  leaf l2 (.a(t ^ b), .y(y), .p());
  assign q = pl;
endmodule
module edgy (input clk, input [16:0] u, input [16:0] v, input [19:0] w, input one, input unused, output [3:0] y, output q, output same17, output diff17, output any20, output [7:0] twin, output [4:0] k, output [0:0] bit1, output reg [3:0] sh, output [31:0] wide);
  wire [3:0] m;
  mid m1 (.a(u[3:0]), .b(v[7:4]), .y(m), .q(q));
  assign y = m + 4'd1;
  assign same17 = u == v;
  assign diff17 = u != 17'd0;
  assign any20 = w ? 1'b1 : 1'b0;
  assign twin = {u[3:0], u[3:0]};
  assign k = 5'd21;
  assign bit1 = one;
  always @(posedge clk) sh <= {sh[2:0], one};
  assign wide = {u[14:0], v};
endmodule`;

export const ALL: Record<string, { source: string; top: string }> = {
  counter: { source: COUNTER, top: 'counter' },
  adder: { source: ADDER, top: 'add' },
  twice: { source: TWICE, top: 'top' },
  mux: { source: MUX, top: 'mux' },
  busy: { source: BUSY, top: 'top' },
  edgy: { source: EDGY, top: 'edgy' },
};
