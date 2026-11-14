// annex: A.8.3 primary; A.9.3 hierarchical-identifier; A.9.3 simple-hierarchical-identifier; A.8.5 net-lvalue; A.6.2 variable-lvalue
// iverilog: ok
module leaf;
    reg [3:0] x;
    reg y;
    initial begin
        x = 4'h5;
        y = 1'b1;
    end
endmodule

module mid;
    leaf l ();
    reg [3:0] t;
    initial begin
        t = l.x;
        l.y = 1'b0;
    end
endmodule

module top_hier;
    mid m ();
    reg [3:0] a;
    reg b;
    wire [3:0] w;
    assign w = m.l.x;
    initial begin
        #1;
        a = m.l.x;
        b = m.l.y;
        m.t = 4'hA;
        m.l.x[1:0] = 2'b11;
        m.l.x[2] = 1'b0;
        a = top_hier.m.l.x;
        a[0] = top_hier.b;
    end
endmodule
