// annex: A.1.3 module-declaration; A.9.3 identifier; A.2.1.3 net-declaration; A.6.5 delay-control
// iverilog: ok
`timescale 1ns / 1ps
`default_nettype none
module ts_design (input wire clk, input wire d, output reg q);
    wire dd;
    assign #1 dd = d;
    always @(posedge clk) q <= #2 dd;
    initial begin
        #1.5;
        q = 1'b0;
    end
endmodule
`default_nettype wire
