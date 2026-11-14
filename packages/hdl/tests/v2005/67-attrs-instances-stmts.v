// annex: A.9.1 attribute-instance; A.4.1 ordered-port-connection; A.4.1 named-port-connection; A.3.1 gate-instantiation; A.6.4 statement; A.6.2 always-construct; A.6.2 initial-construct; A.6.2 blocking-assignment; A.6.6 conditional-statement; A.6.8 loop-statement
// iverilog: ok
module sub (input a, input b);
endmodule

module attr_stmts (input a, b, c);
    reg [3:0] r;
    wire gx, gy;
    reg x;
    integer i;
    event ev;
    (* inst_attr *) sub u1 (a, b);
    (* inst_attr2 = "x" *) sub u2 (.a(a), .b(b));
    sub u3 ((* pa *) a, (* pb *) b);
    sub u4 ((* pn *) .a(a), (* pm *) .b(b));
    (* gate_attr *) and (gx, a, b);
    (* gate_attr2 *) or g1 (gy, a, c);
    (* always_attr *) always @(a or b) r = {a, b, c, 1'b0};
    (* init_attr *) initial begin
        (* s1 *) r = 1;
        (* s2 *) r <= 2;
        (* s3 *) if (a) r = 2; else r = 3;
        (* s4 *) case (r) 1: r = 3; default: r = 0; endcase
        (* s5 *) for (i = 0; i < 1; i = i + 1) r = i;
        (* s6 *) while (0) ;
        (* s7 *) repeat (2) r = r + 1;
        (* s8 *) #1 r = 1;
        (* s9 *) @(a) r = 1;
        (* s10 *) begin end
        (* s11 *) fork join
        (* s12 *) begin : named r = 0; end
        (* s13 *) -> ev;
        (* s14 *) wait (a) r = 1;
        (* s15 *) $display("hi");
        (* s16 *) force x = 1;
        (* s17 *) release x;
        (* s18 *) ;
        (* s19 *) forever begin disable named; end
    end
endmodule
