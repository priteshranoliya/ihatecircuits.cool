// annex: A.4.2 loop-generate-construct; A.4.2 conditional-generate-construct; A.4.2 generate-block; A.2.1.1 local-parameter-declaration; A.1.4 module-parameter-port-list; A.4.1 module-instantiation; A.2.6 function-declaration
// iverilog: ok
module add2 #(parameter W = 8) (input [W-1:0] a, b, output [W:0] s);
    assign s = a + b;
endmodule

module adder_tree #(parameter N = 8, parameter W = 8) (
    input  [N*W-1:0] in,
    output [W+3:0]   sum
);
    function integer log2 (input integer v);
        integer k;
        begin
            log2 = 0;
            for (k = v - 1; k > 0; k = k >> 1) log2 = log2 + 1;
        end
    endfunction

    localparam L = log2(N);
    wire [W+L:0] stage [0:L][0:N-1];
    genvar lvl, i;
    generate
        for (i = 0; i < N; i = i + 1) begin : leaf
            assign stage[0][i] = in[i*W +: W];
        end
        for (lvl = 1; lvl <= L; lvl = lvl + 1) begin : level
            localparam CNT = (N + (1 << lvl) - 1) >> lvl;
            for (i = 0; i < CNT; i = i + 1) begin : node
                if (2 * i + 1 < ((N + (1 << (lvl - 1)) - 1) >> (lvl - 1))) begin : pair
                    assign stage[lvl][i] = stage[lvl-1][2*i] + stage[lvl-1][2*i+1];
                end else begin : single
                    assign stage[lvl][i] = stage[lvl-1][2*i];
                end
            end
        end
    endgenerate
    assign sum = stage[L][0];
endmodule

module adder_chain #(parameter N = 4) (input [N*8-1:0] in, output [8+N-1:0] sum);
    wire [8+N-1:0] acc [0:N];
    assign acc[0] = {(8+N){1'b0}};
    genvar g;
    generate
        for (g = 0; g < N; g = g + 1) begin : chain
            assign acc[g+1] = acc[g] + in[g*8 +: 8];
        end
    endgenerate
    assign sum = acc[N];
endmodule
