// annex: A.2.1.1 module-parameter-declarations; A.1.5 parameter-override; A.2.4 defparam-assignment; A.2.3 list-of-defparam-assignments; A.8.3 constant-expression
// iverilog: ok
module leaf #(parameter W = 4, parameter D = 1) (input [W-1:0] a, output [W-1:0] y);
    assign y = a;
endmodule

module mid;
    wire [7:0] y;
    leaf u (.a(8'h5), .y(y));
    defparam u.W = 8;
endmodule

module top;
    wire [3:0] y0;
    wire [11:0] y1;
    leaf l0 (.a(4'h0), .y(y0));
    leaf l1 (.a(12'h0), .y(y1));
    mid m0 ();
    defparam l1.W = 12, l1.D = 3;
    defparam m0.u.D = 2;
    defparam l0.W = 4;
endmodule
