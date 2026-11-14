// annex: A.2.4 variable-type; A.2.4 dimension; A.2.3 list-of-variable-identifiers; A.2.1.3 net-declaration; A.2.5 range
// iverilog: ok
module mems;
    reg [7:0] mem [0:255];
    reg [7:0] m2 [3:0][3:0];
    reg [7:0] m3 [0:3][0:3];
    reg [3:0] m4 [0:1][0:1][0:1];
    reg bits [0:7];
    integer ia [0:9];
    integer ib [9:0], ic [0:1];
    real ra [0:3];
    time ta [0:1];
    realtime rta [1:0];
    reg [7:0] aa [0:3], ab [0:7];
    wire [7:0] wa [0:3];
    wire [1:0] wm [0:1][0:1];
    reg signed [7:0] sm [0:15];
    reg [7:0] x;
    integer i, j;
    assign wa[0] = 8'h00;
    assign wa[1] = 8'h01;
    assign wa[2] = 8'h02;
    assign wa[3] = 8'h03;
    initial begin
        for (i = 0; i < 256; i = i + 1)
            mem[i] = i;
        m3[1][2] = 8'hAB;
        x = m3[1][2];
        m4[0][1][1] = 4'hF;
        ia[3] = 7;
        ra[1] = 2.5;
        sm[15] = -8'sd1;
        bits[0] = 1'b1;
    end
endmodule
