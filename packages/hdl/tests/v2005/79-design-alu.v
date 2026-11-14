// annex: A.1.3 module-declaration; A.2.1.1 local-parameter-declaration; A.6.7 case-statement; A.8.1 concatenation; A.8.3 expression; A.2.1.3 reg-declaration
// iverilog: ok
module alu #(parameter W = 8) (
    input  [W-1:0] a, b,
    input  [3:0]   op,
    output reg [W-1:0] y,
    output reg         carry, zero, neg, ovf
);
    localparam ADD = 4'd0, SUB = 4'd1, AND = 4'd2, OR = 4'd3, XOR = 4'd4,
               NOT = 4'd5, SHL = 4'd6, SHR = 4'd7, SAR = 4'd8, SLT = 4'd9,
               MUL = 4'd10, EQ = 4'd11;
    reg [W:0] t;
    wire signed [W-1:0] sa = a;
    wire signed [W-1:0] sb = b;
    always @* begin
        t = {1'b0, {W{1'b0}}};
        carry = 1'b0;
        ovf = 1'b0;
        case (op)
            ADD: begin t = a + b; ovf = (a[W-1] == b[W-1]) && (t[W-1] != a[W-1]); end
            SUB: begin t = a - b; ovf = (a[W-1] != b[W-1]) && (t[W-1] != a[W-1]); end
            AND: t = a & b;
            OR:  t = a | b;
            XOR: t = a ^ b;
            NOT: t = ~a;
            SHL: t = a << b[2:0];
            SHR: t = a >> b[2:0];
            SAR: t = sa >>> b[2:0];
            SLT: t = (sa < sb) ? 1 : 0;
            MUL: t = a * b;
            EQ:  t = (a == b);
            default: t = {W+1{1'bx}};
        endcase
        y = t[W-1:0];
        carry = t[W];
        zero = (y == 0);
        neg = y[W-1];
    end
endmodule
