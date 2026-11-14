// annex: A.4.2 generate-block; A.4.2 module-or-generate-item; A.2.1.1 local-parameter-declaration; A.4.2 loop-generate-construct; A.4.2 conditional-generate-construct; A.2.1.3 net-declaration; A.2.1.3 reg-declaration
// iverilog: ok
module gen_nested #(parameter N = 4, parameter M = 2) (input clk, input [N*M-1:0] d, output reg [N*M-1:0] q);
    genvar i, j;
    generate
        for (i = 0; i < N; i = i + 1) begin : row
            localparam BASE = i * M;
            localparam EVEN = (i % 2 == 0);
            wire [M-1:0] slice = d[BASE +: M];
            reg [M-1:0] r;
            for (j = 0; j < M; j = j + 1) begin : col
                localparam IDX = BASE + j;
                if (EVEN) begin : e
                    always @(posedge clk) q[IDX] <= slice[j];
                end else begin : o
                    always @(posedge clk) q[IDX] <= ~slice[j];
                end
            end
            always @(posedge clk) r <= slice;
        end
    endgenerate
    wire probe = row[0].slice[0] & row[1].slice[1];
    wire [M-1:0] rd;
    assign rd = row[2].slice;
endmodule
