// annex: A.5.4 udp-instantiation; A.5.4 udp-instance; A.5.4 name-of-udp-instance; A.2.2.2 drive-strength; A.2.2.3 delay2; A.2.5 range
// iverilog: rejects (syntax error / Invalid module instantiation for a drive strength on a UDP instance; sorry: UDPs with a range (u [1:0]) are not supported.)
primitive nand2 (y, a, b);
    output y;
    input a, b;
    table
        0 ? : 1;
        ? 0 : 1;
        1 1 : 0;
    endtable
endprimitive

module udp_inst_std (input [3:0] a, b, input c, output [3:0] t, output z);
    nand2 (strong0, weak1) ns (z, c, a[0]);
    nand2 (pull0, pull1) #3 ns2 (z, c, a[1]);
    nand2 n[3:0] (t, a, b);
endmodule
