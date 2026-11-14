// annex: A.5.1 udp-declaration; A.5.2 udp-port-list; A.5.2 udp-declaration-port-list; A.5.3 udp-body; A.5.3 combinational-body; A.5.3 combinational-entry; A.5.3 level-symbol; A.5.3 output-symbol
// iverilog: ok
primitive and2 (y, a, b);
    output y;
    input a, b;
    table
        0 0 : 0;
        0 1 : 0;
        1 0 : 0;
        1 1 : 1;
    endtable
endprimitive

primitive mux2 (y, s, a, b);
    output y;
    input s, a, b;
    table
        0 0 ? : 0;
        0 1 ? : 1;
        1 ? 0 : 0;
        1 ? 1 : 1;
        ? 0 0 : 0;
        ? 1 1 : 1;
    endtable
endprimitive

primitive xor_x (y, a, b);
    output y;
    input a, b;
    table
        0 0 : 0;
        0 1 : 1;
        1 0 : 1;
        1 1 : 0;
        x ? : x;
        ? x : x;
        b b : 0;
    endtable
endprimitive

module udp_comb_use (input a, b, s, output y1, y2, y3);
    and2 u1 (y1, a, b);
    mux2 u2 (y2, s, a, b);
    xor_x u3 (y3, a, b);
endmodule
