// annex: A.9.1 attribute-instance; A.9.1 attr-spec; A.9.1 attr-name; A.1.3 module-declaration; A.1.4 port-declaration; A.1.5 module-item; A.2.1.3 net-declaration; A.2.1.3 reg-declaration; A.2.1.1 parameter-declaration; A.2.1.3 event-declaration
// iverilog: ok
(* keep, mark = 1 *)
module attr_decls (
    (* port_attr *) input a,
    (* p2 = "string value" *) (* p3 *) input [3:0] b,
    (* p4 = 8'hFF, p5 = 1 + 2 *) output y,
    (* io *) inout z
);
    (* net_attr *) wire w;
    (* reg_attr = 5 *) reg [3:0] r;
    (* a1 = 1 *) (* a2 = 2 *) (* a3 *) integer i;
    (* P *) parameter P = 1;
    (* LP = 3 *) localparam LP = 2;
    (* *) wire empty_attr;
    (*a*) wire tight;
    (*   spaced   =   "x"   *) wire spaced;
    (* ev *) event e;
    (* t *) time tt;
    (* rl *) real rr;
    (* mem *) reg [7:0] memory [0:3];
    (* tri_attr *) tri t3;
    (* sup *) supply0 g;
    (* a, b = "x", c = 2'b01 *) wire multi;
    assign y = a;
endmodule

(* module_a *) (* module_b = "two" *) module attr_two (input x);
endmodule

(* full_case, parallel_case *)
macromodule attr_macro;
endmodule
