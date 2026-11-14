// annex: A.2.3 list-of-net-decl-assignments; A.2.3 list-of-variable-identifiers; A.2.3 net-decl-assignment; A.2.3 variable-type; A.2.5 range
// iverilog: ok
module multi (input a, b, c);
    wire x, y, z;
    wire [3:0] p, q, r;
    wire m = a, n = b, o = c;
    wire [1:0] s = 2'b01, t = 2'b10;
    reg u, v, w;
    reg [3:0] aa = 4'd1, bb = 4'd2, cc;
    reg [3:0] mm [0:1], nn [0:2];
    integer i = 1, j, k = 3;
    real r1 = 1.0, r2, r3 = 3.0;
    time tt1, tt2 = 3;
    event e1, e2, e3;
    wire signed [3:0] sa = 4'sd3, sb = -4'sd3;
    initial begin
        u = 0; v = 1; w = 0;
    end
endmodule
