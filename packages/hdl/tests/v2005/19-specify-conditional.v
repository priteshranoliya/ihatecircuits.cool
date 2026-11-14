// annex: A.7.2 path-declaration; A.7.2 state-dependent-path-declaration; A.7.2 module-path-expression; A.7.2 module-path-conditional-expression; A.7.3 specify-input-terminal-descriptor
// iverilog: ok
module sp_cond (input a, b, en, sel, input [1:0] m, output y, z);
    assign y = en ? a : b;
    assign z = a ^ b;
    specify
        if (en) (a => y) = 2;
        if (!en) (b => y) = 3;
        if (en == 1'b1) (a => z) = 1;
        if (en === 1'b0) (b => z) = 1;
        if (sel && en) (a *> z) = (1, 2);
        if (sel || en) (b *> z) = (2, 3);
        if (~sel) (a, b *> y) = 4;
        if (m == 2'b01) (a => y) = 5;
        if (m[0] ^ m[1]) (b => y) = 5;
        if (^m) (a => z) = 1;
        if (&m) (b => z) = 1;
        if (sel != en) (a => y) = 6;
        if (sel ? en : a) (b => z) = 2;
        ifnone (a => y) = 7;
        ifnone (b => z) = 8;
        if (en) (a *> z) = 9;
        ifnone (a *> z) = 10;
    endspecify
endmodule
