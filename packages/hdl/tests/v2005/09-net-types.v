// annex: A.2.1.3 net-declaration; A.2.2.1 net-type; A.2.3 list-of-net-identifiers; A.2.3 list-of-net-decl-assignments; A.2.5 range
// iverilog: ok
module nets (input a, b, c, output y);
    wire w1;
    wire [7:0] w8, w8b;
    wire signed [3:0] ws;
    tri t1;
    tri [3:0] t4;
    wand wa;
    wor wo;
    triand ta;
    trior to;
    tri0 t0;
    tri1 t1x;
    supply0 gnd;
    supply1 vdd;
    uwire uw;
    wand [1:0] wa2 = {a, b};
    wire x1, x2, x3;
    wire w_a = a & b, w_b = b | c;
    wire [3:0] #2 dly = {4{a}};
    assign wa = a;
    assign wa = b;
    assign wo = a;
    assign wo = c;
    assign y = w_a ^ w_b ^ wa ^ wo;
endmodule
