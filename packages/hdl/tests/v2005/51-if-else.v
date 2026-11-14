// annex: A.6.6 conditional-statement; A.6.6 if-else-if-statement; A.6.4 statement-or-null; A.6.4 seq-block
// iverilog: ok
module ifelse;
    reg a, b, c, d, x, y, z;
    reg [3:0] v;
    initial begin
        if (a) x = 1;
        if (a) x = 1; else x = 0;
        if (a) begin x = 1; end else begin x = 0; end
        if (a) x = 1; else if (b) x = 2; else if (c) x = 3; else x = 4;
        if (a) ; else x = 0;
        if (a) x = 0; else ;
        if (a) ;
        if (a)
            if (b)
                x = 1;
            else
                x = 2;
        if (a)
            if (b) x = 1;
            else if (c) x = 2;
            else x = 3;
        else
            x = 4;
        if (a) begin
            if (b) x = 1;
        end else
            x = 2;
        if (a && b || c) x = 1;
        if (!a) x = 1;
        if (v == 4'b1010) x = 1;
        if (v[0]) x = 1;
        if (a ? b : c) x = 1;
        if ((a)) x = 1;
        if (a) if (b) if (c) x = 1; else y = 1; else z = 1; else d = 1;
        if (a) begin : lbl
            x = 1;
        end else begin : lbl2
            x = 0;
        end
    end
endmodule
