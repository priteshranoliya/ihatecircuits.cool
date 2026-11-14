// annex: A.4.2 generate-region; A.4.2 loop-generate-construct; A.4.2 genvar-initialization; A.4.2 genvar-iteration; A.4.2 generate-block; A.4.2 generate-block-identifier; A.4.2 module-or-generate-item; A.2.1.3 genvar-declaration
// iverilog: ok
module gen_for #(parameter N = 4) (input [N-1:0] a, b, output [N-1:0] s, output [N-1:0] c);
    genvar i;
    generate
        for (i = 0; i < N; i = i + 1) begin : bit_slice
            wire x = a[i] ^ b[i];
            assign s[i] = x;
            assign c[i] = a[i] & b[i];
        end
    endgenerate
    genvar j, k;
    wire [N-1:0] p;
    generate
        for (j = 0; j < N; j = j + 1) begin : outer
            for (k = 0; k < 2; k = k + 1) begin : inner
                wire t = a[j];
            end
            assign p[j] = outer[j].inner[0].t;
        end
    endgenerate
    wire [N-1:0] q;
    genvar m;
    generate
        for (m = N - 1; m >= 0; m = m - 1)
            begin : down
                assign q[m] = ~a[m];
            end
    endgenerate
    wire [N-1:0] r;
    genvar n;
    generate
        for (n = 0; n < N; n = n + 2) begin : step
            assign r[n] = 1'b0;
            if (n + 1 < N) begin : odd
                assign r[n + 1] = 1'b1;
            end
        end
    endgenerate
endmodule
