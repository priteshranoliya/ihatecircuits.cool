// annex: A.6.5 delay-control; A.2.2.3 delay3; A.3.1 gate-instantiation; A.1.3 module-declaration; A.6.2 always-construct
// iverilog: ok
`timescale 10ps / 1ps
module ts_delay (input a, b, output y, z);
    wire t;
    nand #(1.5, 2.5) g1 (t, a, b);
    not #1.25 g2 (y, t);
    assign #3.75 z = a ^ b;
    reg clk;
    initial clk = 0;
    always #2.5 clk = ~clk;
endmodule
