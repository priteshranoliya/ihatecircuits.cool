// annex: A.4.2 generate-block; A.4.1 module-instantiation; A.6.2 always-construct; A.2.1.3 net-declaration; A.4.2 loop-generate-construct; A.4.2 if-generate-construct
// iverilog: ok
module leafc (input a, b, output y);
    assign y = a & b;
endmodule

module gen_inst #(parameter N = 4, parameter REG = 1) (input clk, input [N-1:0] a, b, output [N-1:0] y, output reg [N-1:0] qy);
    genvar i;
    generate
        for (i = 0; i < N; i = i + 1) begin : g
            wire out;
            leafc u (.a(a[i]), .b(b[i]), .y(out));
            assign y[i] = out;
            if (REG) begin : r
                always @(posedge clk) qy[i] <= out;
            end
        end
    endgenerate
    reg [N-1:0] dbg;
    generate
        for (i = 0; i < N; i = i + 1) begin : h
            always @* dbg[i] = g[i].out;
        end
    endgenerate
    wire hx = g[0].out;
    wire hy = g[N-1].out;
endmodule
