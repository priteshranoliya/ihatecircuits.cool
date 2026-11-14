// annex: A.4.2 generate-region; A.4.2 generate-block-or-null; A.4.2 if-generate-construct; A.1.5 module-item; A.4.2 generate-block-identifier
// iverilog: ok
module gen_implicit #(parameter A = 1, parameter B = 0) (input x, output y, output z);
    generate
        if (A)
            assign y = x;
        else
            assign y = ~x;
    endgenerate
    generate
        if (B) begin
            assign z = x;
        end else begin
            assign z = ~x;
        end
    endgenerate
    generate
    endgenerate
    generate
        genvar k;
        wire [1:0] w;
        for (k = 0; k < 2; k = k + 1) begin
            assign w[k] = x;
        end
    endgenerate
endmodule
