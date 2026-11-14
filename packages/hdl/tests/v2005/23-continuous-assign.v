// annex: A.6.1 continuous-assign; A.6.1 list-of-net-assignments; A.6.1 net-assignment; A.2.2.2 drive-strength; A.2.2.3 delay3; A.8.5 net-lvalue
// iverilog: ok
module cassign (input a, b, c, input [3:0] v, output y, z, output [3:0] w);
    wire t0, t1, t2, t3, t4, t5, t6;
    wire [1:0] p;
    wire [3:0] q;
    wire [7:0] big;
    assign t0 = a;
    assign (strong0, weak1) #3 t1 = a;
    assign (pull0, pull1) t2 = b;
    assign (highz1, strong0) t3 = c;
    assign #(1, 2) t4 = a & b;
    assign #(1, 2, 3) t5 = a | b;
    assign (weak0, supply1) #2 t6 = ~a;
    assign y = t0, z = t1;
    assign t2 = 1'b1, t3 = 1'b0;
    assign {t0, t1} = {a, b};
    assign {p, t4} = {v[2:0]};
    assign q[3:2] = v[1:0];
    assign q[1] = a;
    assign q[0] = b;
    assign big[7:4] = v;
    assign big[3 +: 2] = p;
    assign big[1 -: 2] = 2'b11;
    assign {big[0], w[3:1]} = v;
    assign w[0] = c;
endmodule
