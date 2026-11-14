// annex: A.4.1 module-instantiation; A.4.1 parameter-value-assignment; A.4.1 list-of-parameter-assignments; A.4.1 ordered-parameter-assignment; A.4.1 named-parameter-assignment; A.8.3 mintypmax-expression
// iverilog: ok
module pm #(parameter W = 4, parameter D = 2, parameter S = "x") (input [W-1:0] a, output [W-1:0] y);
    assign y = a;
endmodule

module inst_params;
    wire [3:0] y0;
    wire [7:0] y1, y2, y3, y4;
    wire [15:0] y5, y6;
    pm u0 (4'h1, y0);
    pm #(8) u1 (8'h1, y1);
    pm #(8, 4) u2 (8'h2, y2);
    pm #(8, 4, "hello") u3 (8'h3, y3);
    pm #(.W(8)) u4 (.a(8'h4), .y(y4));
    pm #(.W(16), .D(1), .S("abc")) u5 (.a(16'h5), .y(y5));
    pm #(.D(7), .W(16)) u6 (.a(16'h6), .y(y6));
    pm #(.W()) u7 (.a(4'h1), .y());
    pm #(2 * 4) u8 (.a(8'h0), .y());
    pm #(.W(2 + 2)) u9 (.a(4'h0), .y());
    pm #(8) ua (8'h1, ), ub (8'h2, ), uc (8'h3, );
endmodule
