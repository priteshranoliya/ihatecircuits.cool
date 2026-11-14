// annex: A.2.1.1 specparam-declaration; A.2.4 specparam-assignment; A.2.3 list-of-specparam-assignments; A.2.5 range; A.7.1 specify-block
// iverilog: ok
module sp1 (input a, output y);
    specparam tr = 1, tf = 2;
    specparam [7:0] big = 8'd200;
    specparam delay_a = 3, delay_b = delay_a + 1;
    assign y = a;
    specify
        specparam tpd = 4, tpd2 = 5;
        specparam [3:0] sh = 4'd7;
        (a => y) = (tr, tf);
    endspecify
endmodule

module sp2 (input a, b, output y);
    specparam d_ab = 1;
    specparam d_ba = d_ab * 2;
    assign y = a & b;
    specify
        specparam d3 = d_ab + d_ba;
        (a => y) = d_ab;
        (b => y) = d_ba;
    endspecify
endmodule
