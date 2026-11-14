// annex: A.3.1 gate-instantiation; A.3.1 pull-gate-instance; A.3.2 pulldown-strength; A.3.2 pullup-strength; A.2.2.2 drive-strength; A.2.2.3 delay2; A.2.2.3 delay3; A.2.2.3 delay-value
// iverilog: ok
module gates3 (input a, b, c, en, output y);
    wire p1, p2, p3, p4, p5;
    pullup (p1);
    pullup pu (p2);
    pulldown (p3);
    pulldown pd (p4);
    pullup (pull1) (p5);
    pulldown (pull0) pd2 (p1);
    pullup (strong1) (p2), pu3 (p3);
    pulldown (weak0) (p4), (p5);
    wire q1, q2, q3, q4, q5, q6, q7, q8;
    and #1 (q1, a, b);
    and #(1, 2) (q2, a, b);
    and #(1, 2) g1 (q3, a, b);
    or #(1, 2) (q4, a, b);
    bufif1 #(1, 2, 3) (q5, a, en);
    and (strong0, weak1) (q6, a, b);
    and (strong0, weak1) #3 g2 (q7, a, b);
    nand (pull1, supply0) #(1, 2) g3 (q8, a, b), g4 (q8, b, c);
    buf (weak0, strong1) #1 (y, a);
    nor #2 g5 (q2, a, b), g6 (q2, b, c);
    not (strong0, strong1) (q3, a);
    nmos #(1, 2, 3) (q4, a, en);
    cmos #(1, 2) (q5, a, en, en);
endmodule
