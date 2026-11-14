// annex: A.4.2 module-or-generate-item; A.4.2 loop-generate-construct; A.4.2 conditional-generate-construct; A.4.2 generate-block; A.4.2 genvar-declaration
// iverilog: ok
module gen_nokw #(parameter N = 4, parameter USE_INV = 1) (input [N-1:0] a, output [N-1:0] y, output [N-1:0] y2);
    genvar i;
    for (i = 0; i < N; i = i + 1) begin : loop
        assign y[i] = ~a[i];
    end
    if (USE_INV) begin : inv_sel
        assign y2 = ~a;
    end else begin : buf_sel
        assign y2 = a;
    end
    wire t;
    case (N)
        4: assign t = 1'b1;
        default: assign t = 1'b0;
    endcase
    genvar j;
    wire [N-1:0] z;
    for (j = 0; j < N; j = j + 1)
        assign z[j] = a[j];
    wire w0, w1;
    if (N == 4) assign w0 = 1'b1; else assign w0 = 1'b0;
    if (N == 8)
        assign w1 = 1'b1;
    else if (N == 4)
        assign w1 = 1'b0;
    else
        assign w1 = 1'bx;
endmodule
