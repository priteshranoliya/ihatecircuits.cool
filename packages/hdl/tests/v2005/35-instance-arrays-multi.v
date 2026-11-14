// annex: A.4.1 module-instance; A.4.1 name-of-module-instance; A.2.5 range; A.4.1 list-of-port-connections; A.4.1 module-instantiation
// iverilog: ok
module inv1 (input a, output y);
    assign y = ~a;
endmodule

module bit2 (input [1:0] a, input c, output [1:0] y);
    assign y = a ^ {2{c}};
endmodule

module inst_arrays (input [3:0] a, input c, output [3:0] y, output [3:0] y2);
    inv1 u[3:0] (a, y);
    inv1 v[0:3] (.a(a), .y(y2));
    wire [7:0] big;
    bit2 w[3:0] (.a(big), .c(c), .y(big));
    inv1 m1 (a[0], ), m2 (a[1], ), m3 (a[2], );
    inv1 n1 (.a(a[0]), .y()),
         n2 (.a(a[1]), .y());
    inv1 q[1:0] (a[1:0], y2[1:0]), r[1:0] (a[3:2], y2[3:2]);
endmodule
