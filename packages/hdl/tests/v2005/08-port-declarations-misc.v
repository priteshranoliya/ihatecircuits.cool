// annex: A.2.1.2 port-declarations; A.2.1.2 inout-declaration; A.2.1.2 input-declaration; A.2.1.2 output-declaration; A.2.3 list-of-port-identifiers
// iverilog: ok
module portmisc (a, b, c, d, e, f, g, h, i, j, k);
    input a;
    input wire b;
    input [3:0] c;
    input wire signed [3:0] d;
    output e;
    output wire [1:0] f;
    output reg g;
    output reg signed [7:0] h;
    output integer i;
    output time j;
    inout [2:0] k;
    reg [7:0] hr;
    assign e = a & b;
    assign f = c[1:0];
    assign k = 3'bzzz;
    initial begin
        g = 0; h = 0; i = 0; j = 0;
    end
endmodule

module portmisc2 (output reg signed [3:0] q, output tri t, input wand w, inout supply1 s, output realtime rt, output real rr);
    initial begin
        q = 0;
        rt = 1.5;
        rr = 2.5;
    end
endmodule
