// annex: A.3.1 gate-instantiation; A.3.1 n-input-gate-instance; A.3.1 n-output-gate-instance; A.3.1 name-of-gate-instance; A.3.3 input-terminal; A.3.3 output-terminal; A.3.4 n-input-gatetype; A.3.4 n-output-gatetype
// iverilog: ok
module gates1 (input a, b, c, d, output y1, y2, y3, y4, y5, y6, y7, y8, y9);
    and (y1, a, b);
    and g2 (y2, a, b, c, d);
    nand (y3, a, b);
    nand g4 (y4, a, b, c);
    or (y5, a, b);
    nor (y6, a, b, c);
    xor (y7, a, b);
    xnor (y8, a, b, c);
    wire o1, o2, o3;
    buf (o1, a);
    buf b2 (o1, o2, a);
    not (o3, a);
    not n2 (o3, o2, o1, a);
    and ga (y9, a, b), gb (y9, c, d);
    or gc (y9, a, b), (y9, c, d), gd (y9, b, c);
    xor g_x (y1, a, b), g_y (y1, c, d), g_z (y1, a, d);
endmodule
