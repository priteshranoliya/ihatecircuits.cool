// annex: A.5.3 edge-input-list; A.5.3 edge-indicator; A.5.3 edge-symbol; A.5.3 level-symbol; A.5.3 next-state; A.5.3 sequential-entry; A.5.3 udp-initial-statement
// iverilog: ok
primitive dff (q, d, clk);
    output q;
    reg q;
    input d, clk;
    table
        0 (01) : ? : 0;
        1 (01) : ? : 1;
        ? (1?) : ? : -;
        ? (?0) : ? : -;
        * ?    : ? : -;
    endtable
endprimitive

primitive dff_edges (q, d, clk);
    output q;
    reg q;
    input d, clk;
    initial q = 1'b0;
    table
        0 r : ? : 0;
        1 r : ? : 1;
        ? f : ? : -;
        ? n : ? : -;
        * b : ? : -;
        ? (x1) : ? : -;
        ? (0x) : ? : -;
        ? (bx) : ? : -;
    endtable
endprimitive

primitive tff (q, t, clk, rst);
    output q;
    reg q;
    input t, clk, rst;
    table
        ? ? 1 : ? : 0;
        0 p 0 : ? : -;
        1 p 0 : 0 : 1;
        1 p 0 : 1 : 0;
        ? n 0 : ? : -;
        * ? 0 : ? : -;
        ? ? * : ? : 0;
        ? (01) 0 : ? : -;
    endtable
endprimitive

primitive jkff (q, j, k, clk);
    output q;
    reg q;
    input j, k, clk;
    table
        0 0 r : ? : -;
        0 1 r : ? : 0;
        1 0 r : ? : 1;
        1 1 r : 0 : 1;
        1 1 r : 1 : 0;
        ? ? f : ? : -;
        (?0) ? ? : ? : -;
        ? (?0) ? : ? : -;
    endtable
endprimitive

module udp_edge_use (input d, clk, t, rst, j, k, output q1, q2, q3, q4);
    dff u1 (q1, d, clk);
    dff_edges u2 (q2, d, clk);
    tff u3 (q3, t, clk, rst);
    jkff u4 (q4, j, k, clk);
endmodule
