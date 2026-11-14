// annex: A.9.4 white-space; A.1.3 module-declaration; A.6.2 always-construct; A.2.1.3 reg-declaration; A.6.6 conditional-statement
// iverilog: ok
module crlf1 (input clk, input rst, input [3:0] d, output reg [3:0] q);
    // CRLF line endings throughout
    always @(posedge clk) begin
        if (rst)
            q <= 4'd0;
        else
            q <= d;
    end
    /* block comment
       over two lines */
    wire w = q[0];
endmodule
