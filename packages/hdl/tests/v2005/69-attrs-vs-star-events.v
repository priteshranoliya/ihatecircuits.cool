// annex: A.9.1 attribute-instance; A.6.5 event-control; A.6.5 event-expression; A.8.6 binary-operator; A.8.3 expression
// iverilog: ok
module star_vs_attr (input [3:0] a, b, output reg [3:0] y1, y2, y3, y4, y5, y6, y7, y8, y9);
    always @(*) y1 = a & b;
    always @ (*) y2 = a | b;
    always @( * ) y3 = a ^ b;
    always @ ( * ) y4 = a + b;
    always @* y5 = a - b;
    always @ * y6 = ~a;
    always@(*) y7 = a;
    always @(* ) y8 = b;
    always @( *) y9 = a & ~b;
    reg [3:0] t;
    initial begin
        t = a *(b);
        t = a * (b);
        t = a * (* attr *) b;
        t = a *b;
        t = a * b;
        t = a ** b;
        t = a **b;
        t = (a)*(b);
        t = (a) * (* x *) (b);
        t = a*b*(a)*(b);
        t = a ** (b);
        @(*) t = a;
        @ (*) t = b;
        @* t = a;
    end
endmodule
