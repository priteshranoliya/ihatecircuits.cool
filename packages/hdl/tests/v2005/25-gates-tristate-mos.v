// annex: A.3.1 gate-instantiation; A.3.1 enable-gate-instance; A.3.1 mos-switch-instance; A.3.1 cmos-switch-instance; A.3.1 pass-switch-instance; A.3.1 pass-enable-switch-instance; A.3.3 enable-terminal; A.3.3 ncontrol-terminal; A.3.3 pcontrol-terminal; A.3.3 inout-terminal; A.3.4 enable-gatetype; A.3.4 mos-switchtype; A.3.4 cmos-switchtype; A.3.4 pass-switchtype; A.3.4 pass-en-switchtype
// iverilog: ok
module gates2 (input a, b, en, enb, output y);
    wire w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11, w12;
    bufif0 (w1, a, en);
    bufif1 bf1 (w2, a, en);
    notif0 (w3, a, en);
    notif1 nf1 (w4, a, en);
    nmos (w5, a, en);
    pmos p1 (w6, a, en);
    rnmos (w7, a, en);
    rpmos rp (w8, a, en);
    cmos (w9, a, en, enb);
    rcmos rc (w10, a, en, enb);
    tran (w11, w12);
    rtran rt (w11, w12);
    tranif0 (w11, w12, en);
    tranif1 t1 (w11, w12, en);
    rtranif0 (w11, w12, enb);
    rtranif1 rt1 (w11, w12, enb);
    bufif1 (y, a, en), (y, b, enb);
    nmos n1 (y, a, en), n2 (y, b, enb);
    cmos c1 (y, a, en, enb), c2 (y, b, enb, en);
    tran tt1 (w1, w2), tt2 (w3, w4);
endmodule
