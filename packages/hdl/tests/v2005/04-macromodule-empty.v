// annex: A.1.3 module-declaration; A.1.4 module-keyword; A.1.4 list-of-ports
// iverilog: ok
macromodule mm1 (input a, output b);
    assign b = a;
endmodule

module empty1 ();
endmodule

module empty2;
endmodule

macromodule mm2;
    wire w;
endmodule

module empty3 ( );
endmodule

macromodule mm3 (a, b);
    input a;
    output b;
    buf (b, a);
endmodule

module top_empty;
    wire s, t;
    mm1 u0 (s, t);
    empty1 u1 ();
    empty2 u2 ();
endmodule
