// annex: A.9.2 comment; A.9.2 one-line-comment; A.9.2 block-comment; A.9.2 comment-text; A.9.4 white-space; A.1.3 module-declaration; A.1.4 list-of-port-declarations
// iverilog: ok
/* leading block comment */ module /* c1 */ lex_comments /* c2 */ (
    // line comment in port list
    input /* in */ a, /* between */ input b,   // trailing
    /* multi
       line
       comment */
    output /* out */ y
) /* before semi */ ;
    // comment only line
    wire /* x */ w /* y */ = /* z */ a /* & */ & /* ! */ b /* end */ ;
    /* // nested line marker inside block */
    // /* nested block marker inside line
    /* ** * / not an end yet **/
    /**/
    /***/
    /* a */ /* b */ /* c */
    assign y = w //**/
        | b;
    reg r; initial /* c */ begin /* c */ r /* c */ = /* c */ 1 /* c */ ; /* c */ end /* c */
    always @ /* c */ ( /* c */ a /* c */ or /* c */ b /* c */ ) /* c */ r /* c */ = /* c */ a;
    initial begin
        r = a; // eol comment
        r = /* mid */ b; /* tail */
        $display(/* arg comment */ "x" /* more */ , /* last */ r);
    end
endmodule // trailing comment after endmodule
/* trailing block comment */
// last line without newline