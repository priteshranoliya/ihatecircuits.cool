// annex: A.1.4 list-of-ports; A.1.4 port; A.1.4 port-expression; A.1.4 port-reference; A.1.4 port-identifier
// iverilog: ok
module pe1 (.a(x[1:0]), .b({c, d}), e, .f(g));
    input [3:0] x;
    input c, d;
    input e;
    output g;
    assign g = x[0] ^ c ^ d ^ e;
endmodule

module pe2 (.p(w[3]), .q(w[2:1]), .r(w[0]));
    output [3:0] w;
    assign w = 4'b1010;
endmodule

module pe3 (a, .sel(s), {m, n});
    input a, s;
    input m, n;
    wire t = a & s & m & n;
endmodule

module pe4 (, y);
    input y;
endmodule

module pe_inst;
    wire [3:0] xv;
    wire cc, dd, ee, gg;
    pe1 u1 (.a(xv[1:0]), .b({cc, dd}), .e(ee), .f(gg));
    wire [3:0] wv;
    pe2 u2 (.p(wv[3]), .q(wv[2:1]), .r(wv[0]));
endmodule
