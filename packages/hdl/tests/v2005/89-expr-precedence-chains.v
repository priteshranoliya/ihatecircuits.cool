// annex: A.8.3 expression; A.8.6 binary-operator; A.8.6 unary-operator; A.8.3 conditional-expression; A.8.4 primary
// iverilog: ok
module prec (input [7:0] a, b, c, d, input s, t, output [7:0] y1, y2, y3, y4, y5, y6, y7, y8, y9, y10, y11, y12);
    assign y1 = a - b - c - d;
    assign y2 = a / b / c;
    assign y3 = a << 1 << 2 >> 1;
    assign y4 = a | b & c ^ d;
    assign y5 = a + b << c;
    assign y6 = a & b == c;
    assign y7 = s ? a : t ? b : c;
    assign y8 = s ? t ? a : b : c;
    assign y9 = -a ** 2;
    assign y10 = a ** -b;
    assign y11 = ~a & b | ~c ^ d;
    assign y12 = !s === t;
    wire w1 = a < b == c > d;
    wire w2 = a < b < c;
    wire w3 = a == b != c;
    wire w4 = a && b || c && d || a;
    wire w5 = a || b && c;
    wire w6 = s ? a == b : c != d;
    wire w7 = a == b ? s : t;
    wire [7:0] w8 = a + b ? c : d;
    wire [7:0] w9 = s ? a : b + c;
    wire [7:0] w10 = (s ? a : b) + c;
    wire [7:0] w11 = a * b + c * d - a / b % c;
    wire [7:0] w12 = a ^ b ^~ c ~^ d;
    wire [7:0] w13 = a >> 1 + 1;
    wire [7:0] w14 = (a >> 1) + 1;
    wire w15 = &a | &b & &c;
    wire w16 = a[0] ? b[0] : c[0] ? d[0] : s;
    wire w17 = ~|a & ~&b | ^c;
    wire [7:0] w18 = a ** b ** c;
    wire [7:0] w19 = a ** 2 * b ** 2;
    wire w20 = a <= b == c >= d;
    wire w21 = s & t | s ^ t && s || t;
    wire [7:0] w22 = a ? b : c ? d : a ? b : c;
    wire [7:0] w23 = a === b ? c : d !== a ? b : c;
endmodule
