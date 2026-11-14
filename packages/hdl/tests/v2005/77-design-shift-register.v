// annex: A.1.3 module-declaration; A.6.2 always-construct; A.6.7 case-statement; A.8.1 concatenation; A.8.4 primary; A.4.2 loop-generate-construct
// iverilog: ok
module shift_reg #(parameter N = 8) (
    input clk, rst, load, left, sin,
    input [N-1:0] pin,
    output reg [N-1:0] q,
    output sout
);
    assign sout = left ? q[N-1] : q[0];
    always @(posedge clk) begin
        if (rst) q <= 0;
        else begin
            case ({load, left})
                2'b10, 2'b11: q <= pin;
                2'b01: q <= {q[N-2:0], sin};
                2'b00: q <= {sin, q[N-1:1]};
            endcase
        end
    end
endmodule

module lfsr (input clk, rst, output reg [7:0] r);
    wire fb = r[7] ^ r[5] ^ r[4] ^ r[3];
    always @(posedge clk or posedge rst)
        if (rst) r <= 8'h01;
        else r <= {r[6:0], fb};
endmodule

module sipo_chain (input clk, d, output [3:0] taps);
    genvar i;
    wire [4:0] c;
    assign c[0] = d;
    generate
        for (i = 0; i < 4; i = i + 1) begin : stage
            reg q;
            always @(posedge clk) q <= c[i];
            assign c[i + 1] = q;
            assign taps[i] = q;
        end
    endgenerate
endmodule
