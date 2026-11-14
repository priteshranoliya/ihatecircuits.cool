// annex: A.6.2 blocking-assignment; A.6.2 nonblocking-assignment; A.6.5 delay-or-event-control; A.6.5 delay-control; A.6.5 event-control; A.6.5 repeat-event-control; A.6.2 variable-assignment; A.6.2 variable-lvalue
// iverilog: ok
module assigns;
    reg clk, a, b, c, q;
    reg [7:0] v, w;
    reg [7:0] mem [0:3];
    integer i;
    event ev;
    initial begin
        a = b;
        a = #5 b;
        a = @(posedge clk) b;
        a = @ev b;
        a = repeat (3) @(posedge clk) b;
        a = repeat (i + 1) @(negedge clk) b;
        q <= #3 b;
        q <= @(posedge clk) b;
        q <= repeat (2) @(posedge clk) b;
        q <= @(a or b) c;
        q <= #(i + 1) c;
        v[3:0] = 4'hA;
        v[7] = 1'b1;
        v[i +: 2] = 2'b01;
        v[i -: 2] = 2'b10;
        {a, b} = 2'b10;
        {a, b} <= #1 2'b01;
        {v[1:0], w[3:2]} = 4'b1010;
        mem[0] = 8'h11;
        mem[i] <= 8'h22;
        mem[1][3:0] = 4'h3;
        mem[2][i] = 1'b1;
        w = #2 v + 1;
        w <= #2 v & 8'h0F;
        w = (a) ? v : ~v;
    end
endmodule
