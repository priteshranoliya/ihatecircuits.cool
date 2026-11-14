// annex: A.2.1.3 net-declaration; A.2.5 range
// iverilog: rejects (syntax error / Invalid module item. for vectored/scalared followed by signed)
module vsigned (input [3:0] a);
    wire vectored signed [3:0] v3;
    wire scalared signed [3:0] s3;
    assign v3 = a;
    assign s3 = a;
endmodule
