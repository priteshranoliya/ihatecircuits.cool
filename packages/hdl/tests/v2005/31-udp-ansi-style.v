// annex: A.5.2 udp-declaration-port-list; A.5.2 udp-output-declaration; A.5.2 udp-input-declaration; A.5.1 udp-ansi-declaration; A.5.3 udp-body
// iverilog: ok
primitive p_and (output y, input a, input b);
    table
        0 0 : 0;
        0 1 : 0;
        1 0 : 0;
        1 1 : 1;
    endtable
endprimitive

primitive p_latch (output reg q, input d, input en);
    table
        1 1 : ? : 1;
        0 1 : ? : 0;
        ? 0 : ? : -;
    endtable
endprimitive

primitive p_dff (output reg q, input d, input clk);
    table
        0 r : ? : 0;
        1 r : ? : 1;
        ? f : ? : -;
        * ? : ? : -;
    endtable
endprimitive

primitive p_or3 (output y, input a, input b, input c);
    table
        1 ? ? : 1;
        ? 1 ? : 1;
        ? ? 1 : 1;
        0 0 0 : 0;
    endtable
endprimitive

module udp_ansi_use (input a, b, c, d, clk, output y1, y2, y3, y4);
    p_and u1 (y1, a, b);
    p_latch u2 (y2, d, clk);
    p_dff u3 (y3, d, clk);
    p_or3 u4 (y4, a, b, c);
endmodule
