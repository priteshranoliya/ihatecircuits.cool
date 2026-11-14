// annex: A.8.3 conditional-expression; A.8.1 concatenation; A.8.1 multiple-concatenation; A.8.1 constant-concatenation; A.8.1 constant-multiple-concatenation; A.8.4 primary
// iverilog: ok
module ops_misc #(parameter N = 3) (input [3:0] a, b, c, input s, t, u, output [3:0] y1, y2, y3, output [11:0] y4, output [15:0] y5, output [7:0] y6);
    assign y1 = s ? a : b;
    assign y2 = s ? t ? a : b : c;
    assign y3 = s ? a : t ? b : u ? c : 4'h0;
    assign y4 = {a, b, c};
    assign y5 = {4{a}};
    assign y6 = {2{a}};
    wire [23:0] w1 = {2{ {3{s}}, a, b[1:0] }};
    wire [7:0] w2 = {{4{s}}, {4{t}}};
    wire [N*4-1:0] w3 = {N{a}};
    wire [3:0] w4 = {{{s}}, t, u, 1'b0};
    wire [8:0] w5 = {s, 8'hFF};
    wire [9:0] w6 = {2'b10, 4'hF, a[3:2]};
    wire [3:0] w7 = (s ? a : b) & (t ? b : c);
    wire [3:0] w8 = (s) ? ((t) ? a : b) : ((u) ? c : a);
    wire w9 = s ? 1'b1 : 1'b0;
    wire [3:0] w10 = s ? {a[1:0], b[1:0]} : {2{c[1:0]}};
    wire [3:0] w11 = {a[0], a[1], a[2], a[3]};
    wire [3:0] w12 = s ? a : s ? b : s ? c : a;
    wire [3:0] w13 = s && t ? a : b;
    wire [3:0] w14 = s ? a + b : a - b;
endmodule
