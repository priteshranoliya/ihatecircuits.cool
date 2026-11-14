// annex: A.4.1 module-instantiation; A.2.2.3 delay-value; A.4.1 parameter-value-assignment; A.3.1 gate-instantiation
// iverilog: ok
module dly #(parameter D = 1) (input a, output y);
    assign #D y = a;
endmodule

module inst_delay (input a, b, output y1, y2, y3, y4);
    dly #(5) u1 (a, y1);
    dly #(.D(3)) u2 (.a(b), .y(y2));
    dly #5 u3 (a, y3);
    dly #(2 + 3) u4 (.a(b), .y(y4));
    and #(1, 2) g (y3, a, b);
endmodule
