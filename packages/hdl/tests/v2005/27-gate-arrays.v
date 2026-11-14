// annex: A.3.1 gate-instantiation; A.3.1 name-of-gate-instance; A.2.5 range; A.4.1 name-of-instance
// iverilog: ok
module gate_arrays (input [3:0] a, b, input en, output [3:0] y, output [3:0] z, output [3:0] t);
    and g[3:0] (y, a, b);
    or h[0:3] (z, a, b);
    not n[3:0] (t, a);
    wire [1:0] w;
    xor x[1:0] (w, a[1:0], b[1:0]);
    nand #2 ng[3:0] (y, a, b);
    bufif1 bf[3:0] (t, a, en);
    wire [3:0] pu;
    pullup pup[3:0] (pu);
    pulldown pd[3:0] (pu);
    nmos nm[3:0] (t, a, en);
    cmos cm[1:0] (t[1:0], a[1:0], en, en);
    and a1[1:0] (w, a[1:0], b[1:0]), a2[1:0] (w, b[1:0], a[1:0]);
    buf (strong0, weak1) #1 bb[3:0] (z, a);
endmodule
