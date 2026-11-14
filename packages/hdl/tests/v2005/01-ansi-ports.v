// annex: A.1.3 module-declaration; A.1.4 module-parameters-and-ports; A.2.1.2 port-declarations
// iverilog: ok
module ansi_basic (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [7:0]  din,
    input  signed [3:0] sdin,
    output reg  [7:0]  dout,
    output wire        valid,
    output reg signed [15:0] acc,
    output integer     cnt,
    output reg         flag,
    inout  wire        io,
    output reg [3:0] a, b,
    input  wire c, d
);
    assign valid = |din;
    assign io = flag ? 1'b1 : 1'bz;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            dout <= 8'd0;
            acc  <= 16'sd0;
            cnt  = 0;
            flag <= 1'b0;
            a <= 4'd0;
            b <= 4'd0;
        end else begin
            dout <= din;
            acc  <= acc + sdin;
            cnt  = cnt + 1;
            flag <= c ^ d;
            a <= din[3:0];
            b <= din[7:4];
        end
    end
endmodule
