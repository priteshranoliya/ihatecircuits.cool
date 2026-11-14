// annex: A.5.3 sequential-body; A.5.3 udp-initial-statement; A.5.3 sequential-entry; A.5.3 seq-input-list; A.5.3 level-input-list; A.5.3 current-state; A.5.3 next-state; A.5.3 output-symbol; A.5.2 udp-output-declaration; A.5.2 udp-reg-declaration
// iverilog: ok
primitive dlatch (q, d, en);
    output q;
    reg q;
    input d, en;
    table
        1 1 : ? : 1;
        0 1 : ? : 0;
        ? 0 : ? : -;
    endtable
endprimitive

primitive dlatch_init (q, d, en);
    output q;
    reg q;
    input d, en;
    initial q = 1'b0;
    table
        1 1 : ? : 1;
        0 1 : ? : 0;
        ? 0 : ? : -;
        x 1 : ? : x;
    endtable
endprimitive

primitive srlatch (q, s, r);
    output q;
    reg q;
    input s, r;
    initial q = 1'bx;
    table
        1 0 : ? : 1;
        0 1 : ? : 0;
        0 0 : ? : -;
        1 1 : ? : x;
    endtable
endprimitive

module udp_seq_level_use (input d, en, s, r, output q1, q2, q3);
    dlatch u1 (q1, d, en);
    dlatch_init u2 (q2, d, en);
    srlatch u3 (q3, s, r);
endmodule
