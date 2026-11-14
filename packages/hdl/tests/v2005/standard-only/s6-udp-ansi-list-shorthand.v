// annex: A.5.1 udp-ansi-declaration; A.5.3 udp-initial-statement; A.5.2 udp-declaration-port-list; A.5.2 udp-input-declaration; A.2.3 list-of-port-identifiers
// iverilog: rejects (syntax error on `input a, b` in an ANSI primitive header; also on an `initial` statement in an ANSI primitive)
primitive p_and3 (output y, input a, b, c);
    table
        0 ? ? : 0;
        ? 0 ? : 0;
        ? ? 0 : 0;
        1 1 1 : 1;
    endtable
endprimitive

primitive p_dff2 (output reg q, input d, clk);
    table
        0 r : ? : 0;
        1 r : ? : 1;
        ? f : ? : -;
        * ? : ? : -;
    endtable
endprimitive

primitive p_latch_init (output reg q, input d, input en);
    initial q = 1'b0;
    table
        1 1 : ? : 1;
        0 1 : ? : 0;
        ? 0 : ? : -;
    endtable
endprimitive
