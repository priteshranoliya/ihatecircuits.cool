// annex: A.1.4 module-parameter-port-list; A.2.1.1 module-parameter-declarations; A.2.2.1 net-type
// iverilog: ok
module pp1 #(
    parameter W = 8,
    parameter signed [7:0] SV = -3,
    parameter integer N = 4,
    parameter real R = 1.5,
    parameter realtime RT = 2.5,
    parameter time T = 10,
    parameter [W-1:0] MASK = {W{1'b1}},
    parameter D = W / 2, E = D + 1
) (
    input  [W-1:0] a,
    output [W-1:0] y
);
    assign y = a & MASK;
endmodule

module pp2 #(parameter A = 1, B = 2) (input x, output y);
    assign y = x;
endmodule

module pp3 #(parameter signed A = 5, parameter [3:0] B = 4'hF);
    wire [A:0] w;
endmodule

module pp4 #(parameter W = 4)
    (input [W-1:0] a, b, output [W:0] s);
    assign s = a + b;
endmodule

module pp_top;
    wire [7:0] y1;
    pp1 #(.W(8), .N(3)) u1 (.a(8'hAA), .y(y1));
    pp1 #(16, -1, 2) u2 (.a(16'h1), .y());
    pp2 #(.A(3)) u3 (1'b0, );
endmodule
