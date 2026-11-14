// annex: A.1.3 module-declaration; A.4.2 generate-region; A.4.2 loop-generate-construct; A.4.2 conditional-generate-construct; A.2.6 function-declaration; A.6.2 always-construct; A.4.1 module-instantiation
// iverilog: ok
module fifo #(parameter DEPTH = 4, parameter WIDTH = 8) (
    input clk, rst, wr, rd,
    input [WIDTH-1:0] din,
    output [WIDTH-1:0] dout,
    output full, empty
);
    function integer clogb2 (input integer v);
        integer i;
        begin
            clogb2 = 0;
            for (i = v - 1; i > 0; i = i >> 1) clogb2 = clogb2 + 1;
        end
    endfunction

    localparam AW = clogb2(DEPTH);
    reg [AW:0] wptr, rptr;
    reg [WIDTH-1:0] mem [0:DEPTH-1];
    assign empty = (wptr == rptr);
    assign full = (wptr[AW-1:0] == rptr[AW-1:0]) && (wptr[AW] != rptr[AW]);
    assign dout = mem[rptr[AW-1:0]];

    always @(posedge clk) begin
        if (rst) begin
            wptr <= 0;
            rptr <= 0;
        end else begin
            if (wr && !full) begin
                mem[wptr[AW-1:0]] <= din;
                wptr <= wptr + 1;
            end
            if (rd && !empty) rptr <= rptr + 1;
        end
    end
endmodule

module sync_ff (input clk, d, output reg q);
    always @(posedge clk) q <= d;
endmodule

module fifo_sync_ptr #(parameter N = 3, parameter SYNC = 2) (input clk, input [N-1:0] d, output [N-1:0] q);
    genvar b, s;
    generate
        for (b = 0; b < N; b = b + 1) begin : bits
            wire [SYNC:0] chain;
            assign chain[0] = d[b];
            for (s = 0; s < SYNC; s = s + 1) begin : stages
                sync_ff ff (.clk(clk), .d(chain[s]), .q(chain[s + 1]));
            end
            assign q[b] = chain[SYNC];
        end
    endgenerate
endmodule
