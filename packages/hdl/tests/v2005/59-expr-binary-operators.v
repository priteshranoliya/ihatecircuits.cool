// annex: A.8.3 expression; A.8.6 binary-operator; A.8.6 unary-operator; A.8.3 constant-expression; A.8.4 primary
// iverilog: ok
module ops_bin (input [7:0] a, b, c, input signed [7:0] sa, sb, output [7:0] y1, y2, y3, y4, y5, y6, y7, y8);
    wire r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12;
    assign y1 = a + b - c;
    assign y2 = a * b / c % 8'd3;
    assign y3 = a << 1 >> 2;
    assign y4 = sa <<< 1 >>> 2;
    assign y5 = a & b | c ^ a ~^ b ^~ c;
    assign y6 = a ** 2 ** 2;
    assign y7 = a + b * c;
    assign y8 = (a + b) * c;
    assign r1 = a == b;
    assign r2 = a != b;
    assign r3 = a === b;
    assign r4 = a !== b;
    assign r5 = a < b;
    assign r6 = a <= b;
    assign r7 = a > b;
    assign r8 = a >= b;
    assign r9 = a && b;
    assign r10 = a || b;
    assign r11 = a < b == b > c;
    assign r12 = a && b || c && a || b;
endmodule
