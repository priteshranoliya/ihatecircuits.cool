// annex: A.4.2 genvar-declaration; A.2.1.3 genvar-declaration; A.2.3 list-of-genvar-identifiers; A.2.1.3 reg-declaration; A.2.1.3 net-declaration
// iverilog: ok
module gv;
    genvar i;
    genvar j, k;
    genvar a, b, c;
    wire [3:0] x;
    generate
        for (i = 0; i < 4; i = i + 1) begin : g
            assign x[i] = 1'b0;
        end
    endgenerate
    wire [1:0] y;
    wire [1:0] z;
    generate
        for (j = 0; j < 2; j = j + 1) begin : h
            for (k = 0; k < 1; k = k + 1) begin : hh
                assign y[j] = 1'b1;
            end
            assign z[j] = j;
        end
    endgenerate
endmodule
