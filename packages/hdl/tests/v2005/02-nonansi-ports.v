// annex: A.1.3 module-declaration; A.1.4 list-of-ports; A.1.4 port; A.2.1.2 port-declarations
// iverilog: ok
module nonansi (clk, rst, d, q, qn, bus, flag, cnt, r);
    input clk, rst;
    input [7:0] d;
    output [7:0] q;
    output reg [7:0] qn;
    inout [3:0] bus;
    output reg flag;
    output integer cnt;
    output real r;
    reg [7:0] q_r;
    assign q = q_r;
    assign bus = flag ? 4'hA : 4'bzzzz;
    always @(posedge clk) begin
        if (rst) begin
            q_r <= 8'h00;
            qn <= 8'hFF;
            flag <= 1'b0;
            cnt = 0;
            r = 0.0;
        end else begin
            q_r <= d;
            qn <= ~d;
            flag <= ^d;
            cnt = cnt + 1;
            r = r + 0.5;
        end
    end
endmodule

module nonansi_split (a, b);
    input a;
    output b;
    wire b;
    assign b = ~a;
endmodule

module nonansi_signed (x, y);
    input signed [7:0] x;
    output signed [8:0] y;
    assign y = x + 1;
endmodule
