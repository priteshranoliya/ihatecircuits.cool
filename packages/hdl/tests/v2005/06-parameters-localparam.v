// annex: A.2.1.1 module-parameter-declarations; A.2.1.1 local-parameter-declaration; A.2.1.1 parameter-declaration; A.2.3 list-of-param-assignments; A.2.4 param-assignment; A.8.4 constant-mintypmax-expression
// iverilog: ok
module params;
    parameter P0 = 1;
    parameter integer P1 = 10, P2 = P1 * 2;
    parameter signed [7:0] P3 = 8'shFF;
    parameter [15:0] P4 = 16'hBEEF;
    parameter real P5 = 3.14159, P6 = 2.0e-3;
    parameter realtime P7 = 1.25;
    parameter time P8 = 100;
    parameter signed P9 = -1;
    parameter P10 = "str";
    parameter [8*4-1:0] P11 = "abcd";
    localparam L0 = P1 + 1;
    localparam integer L1 = 3, L2 = L1 << 2;
    localparam signed [3:0] L3 = -2;
    localparam real L4 = 1.5e1;
    localparam realtime L5 = 0.5;
    localparam time L6 = 7;
    localparam [P1:0] L7 = {P1+1{1'b1}};
    localparam L8 = P1 > 5 ? P2 : P1;
    localparam L9 = $clog2(P2);
    wire [L0-1:0] w;
    reg [L2:0] r;
endmodule
