// annex: A.9.1 attribute-instance; A.4.1 module-instantiation; A.4.1 module-instance
// iverilog: rejects (Segmentation fault: 11 in ivl when an attribute precedes an instantiation with two instances; elaboration crash, no message)
module sub (input a);
endmodule

module attr_multi_inst (input a);
    (* inst_attr *) sub u1 (a), u2 (a);
endmodule
