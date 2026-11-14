// annex: A.2.2.3 delay3; A.2.2.3 delay2; A.2.2.3 delay-value; A.8.4 mintypmax-expression; A.2.1.3 net-declaration; A.6.1 continuous-assign
// iverilog: ok
module netdelays (input a, b);
    parameter D = 2;
    wire w, w2, w3, w4, w5;
    wire [3:0] #2 x = {4{a}};
    wire #3 y = a & b;
    wire #(1, 2) z = a | b;
    wire #(1.5) rd = a;
    wire #1.5 rd2 = b;
    wire #(D, D * 2, D * 3) dd = a ^ b;
    wire #D dp = a;
    wire #(D + 1) de = b;
    wire #(1, 2, 3) d3 = a, d3b = b;
    assign #4 w = a;
    assign #(1, 2, 3) w2 = b;
    assign #(1, 2) w3 = a;
    assign #D w4 = a;
    assign #(D + 1) w5 = b;
endmodule
