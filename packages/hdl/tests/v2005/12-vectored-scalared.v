// annex: A.2.1.3 net-declaration; A.2.2.3 delay3; A.2.5 range
// iverilog: ok
module vs (input [3:0] a);
    wire vectored [3:0] v1;
    wire scalared [3:0] s1;
    tri vectored [7:0] v2;
    wand scalared [1:0] s2;
    wire vectored [3:0] #3 v4 = a;
    wire scalared [3:0] #(1, 2) s4 = a;
    wire scalared [3:0] s5 = a, s6 = a;
    assign v1 = a;
    assign s1 = a;
endmodule
