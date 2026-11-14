// annex: A.2.1.3 net-declaration; A.2.2.2 charge-strength; A.2.2.3 delay3; A.2.2.1 net-type
// iverilog: rejects (sorry: Net delays not supported. / sorry: trireg nets not supported.)
module delay_no_assign (input a);
    wire #5 w;
    wire #(1, 2, 3) w2;
    tri #2 t;
    wand #(1, 2) wd;
    wire [3:0] #(1:2:3) w3;
endmodule

module trireg_decls (input a, en);
    trireg (small) t1;
    trireg (medium) t2;
    trireg (large) t3;
    trireg (large) #(1, 2, 3) t4;
    trireg [3:0] t5;
    trireg (small) vectored [3:0] t6;
    trireg t7;
    nmos (t1, a, en);
endmodule
