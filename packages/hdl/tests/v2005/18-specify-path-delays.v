// annex: A.7.1 specify-block; A.7.2 path-declaration; A.7.2 simple-path-declaration; A.7.2 parallel-path-description; A.7.2 full-path-description; A.7.4 path-delay-value; A.7.4 list-of-path-delay-expressions; A.7.3 specify-input-terminal-descriptor; A.7.4 polarity-operator
// iverilog: ok
module sp_paths (input a, b, c, input [3:0] v, output y, z, output [3:0] w);
    assign y = a & b;
    assign z = a | c;
    assign w = ~v;
    specify
        (a => y) = 1;
        (b => y) = (1, 2);
        (c => y) = (1, 2, 3);
        (a => z) = (1, 2, 3, 4, 5, 6);
        (b => z) = (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13);
        (a *> y) = 4;
        (a, b *> y, z) = (1, 2);
        (a, b, c *> y) = 5;
        (a +=> y) = 1;
        (b -=> y) = 1;
        (a +*> z) = 2;
        (b -*> z) = 2;
        (v *> w) = 3;
        (v[0] => w[1]) = 1;
        (v[3:2] *> w[1:0]) = 2;
        (c => z) = (3, 4);
        (c => y) = 0;
    endspecify
endmodule
