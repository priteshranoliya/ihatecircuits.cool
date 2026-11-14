// annex: A.8.6 unary-operator; A.8.3 expression; A.8.4 primary; A.8.6 binary-operator
// iverilog: ok
module ops_un (input [7:0] a, b, input signed [7:0] sa, output [7:0] y1, y2, y3, y4, output r1, r2, r3, r4, r5, r6, r7, r8, r9);
    assign y1 = +a;
    assign y2 = -a;
    assign y3 = ~a;
    assign y4 = -(-a);
    assign r1 = !a;
    assign r2 = &a;
    assign r3 = ~&a;
    assign r4 = |a;
    assign r5 = ~|a;
    assign r6 = ^a;
    assign r7 = ~^a;
    assign r8 = ^~a;
    assign r9 = !(!a);
    wire [7:0] z1 = a - -b;
    wire [7:0] z2 = a + +b;
    wire [7:0] z3 = a & ~b;
    wire [7:0] z4 = a | -b;
    wire [7:0] z5 = ~(~a);
    wire [7:0] z6 = -sa;
    wire [7:0] z7 = a * -b;
    wire [7:0] z8 = a ^ ~^b;
    wire q1 = &a & |b;
    wire q2 = ^a ^ ^b;
    wire q3 = ~&a | ~|b;
    wire q4 = !a && !b || !(a ^ b);
    wire q5 = &{a, b};
    wire q6 = |{a[3:0], b[7:4]};
    wire q7 = ^a[3:0];
    wire q8 = &(a);
endmodule
