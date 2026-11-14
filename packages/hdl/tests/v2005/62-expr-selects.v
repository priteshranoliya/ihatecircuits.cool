// annex: A.8.4 primary; A.8.4 range-expression; A.8.5 net-lvalue; A.8.5 variable-lvalue; A.8.3 constant-range-expression; A.8.3 constant-base-expression; A.8.3 width-constant-expression; A.2.5 dimension-constant-expression
// iverilog: ok
module selects #(parameter P = 8, parameter [7:0] K = 8'hA5) (input [7:0] a, input [2:0] i, output reg [7:0] y, output reg b, output reg [3:0] n);
    reg [7:0] mem [0:3];
    reg [7:0] m2 [0:3][0:3];
    reg [3:0] m3 [0:1][0:1][0:1];
    integer j;
    wire [31:0] big = 32'hDEADBEEF;
    always @* begin
        b = a[0];
        b = a[i];
        b = a[7 - i];
        b = a[P - 1];
        n = a[7:4];
        n = a[3:0];
        n = a[P-1:P-4];
        n = a[i +: 4];
        n = a[i -: 4];
        n = a[0 +: 4];
        n = a[7 -: 4];
        n = a[P - 1 -: 4];
        n = a[(i * 2) +: 2];
        n = K[3:0];
        b = K[2];
        n = K[i +: 2];
        y = mem[0];
        y = mem[i];
        y = mem[i + 1];
        b = mem[1][0];
        n = mem[1][3:0];
        n = mem[i][i +: 4];
        n = mem[i][3 -: 4];
        y = m2[1][2];
        y = m2[i][i];
        b = m2[1][2][0];
        n = m2[1][2][3:0];
        n = m2[1][2][i +: 2];
        n = m2[i][i][i -: 2];
        n = m3[0][1][1];
        b = m3[1][1][1][0];
        n = m3[1][1][0][3:0];
        y = mem[mem[0][1:0]];
        b = big[big[2:0]];
        n = big[8 +: 4];
        n = a[a[1:0]];
    end
endmodule
