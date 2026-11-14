// annex: A.8.4 mintypmax-expression; A.8.3 constant-mintypmax-expression; A.2.2.3 delay-value; A.2.2.3 delay3; A.2.2.3 delay2; A.7.4 path-delay-expression; A.2.4 param-assignment
// iverilog: ok
module mtm (input a, b, output y, z);
    parameter D = 2;
    wire w1, w2, w3;
    reg r;
    integer i;
    assign #(1:2:3) w1 = a;
    assign #(1:2:3, 2:3:4) w2 = b;
    assign #(1:2:3, 2:3:4, 3:4:5) w3 = a & b;
    wire #(1:2:3) w4 = a;
    wire #(D:D+1:D+2, 1:2:3) w5 = b;
    and #(1:2:3) g1 (y, a, b);
    nand #(1:2:3, 2:3:4) g2 (z, a, b);
    bufif1 #(1:2:3, 2:3:4, 3:4:5) g3 (w1, a, b);
    initial begin
        #(1:2:3) r = 0;
        #(D : D + 1 : D + 2) r = 1;
        i = (1:2:3);
        i = (D:D:D) + 1;
        r = #(1:2:3) a;
        r <= #(1:2:3) b;
    end
    specify
        (a => y) = (1:2:3);
        (a => z) = (1:2:3, 2:3:4);
        (b => y) = (1:2:3, 2:3:4, 3:4:5);
        (b *> z) = (1:2:3, 1:2:3, 1:2:3, 1:2:3, 1:2:3, 1:2:3);
        $setup(a, posedge b, (1:2:3));
        $hold(posedge b, a, (1:2:3));
    endspecify
endmodule
