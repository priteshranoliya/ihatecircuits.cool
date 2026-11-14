// annex: A.1.4 list-of-ports; A.1.4 port; A.1.4 port-expression
// iverilog: rejects (syntax error / Errors in port declarations. on `.x()`)
module empty_named_port (.x(), y, .z());
    input y;
endmodule

module empty_unnamed_port (, y, );
    input y;
endmodule
