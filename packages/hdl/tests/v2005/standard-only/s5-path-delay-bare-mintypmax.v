// annex: A.7.4 path-delay-value; A.7.4 list-of-path-delay-expressions; A.7.4 path-delay-expression; A.8.4 constant-mintypmax-expression
// iverilog: rejects (syntax error / Syntax error in specify block for an unparenthesised min:typ:max path delay)
module sp_bare (input a, b, output y, z);
    assign y = a;
    assign z = b;
    specify
        (a => y) = 1:2:3;
        (b => z) = 4:5:6;
    endspecify
endmodule
