// annex: A.9.1 attribute-instance; A.8.3 expression; A.8.3 conditional-expression; A.8.6 binary-operator; A.8.6 unary-operator; A.8.2 function-call
// iverilog: ok
module attr_expr (input [3:0] a, b, c, input s, output [3:0] y);
    function [3:0] f;
        input [3:0] x;
        f = x;
    endfunction
    wire [3:0] w1 = a + (* x *) b;
    wire [3:0] w2 = a & (* x = 1 *) (* y *) b;
    wire [3:0] w3 = ~ (* neg *) a;
    wire [3:0] w4 = - (* neg2 *) a;
    wire w5 = & (* red *) a;
    wire [3:0] w6 = s ? (* t *) a : b;
    wire [3:0] w7 = f (* fc *) (a);
    wire [3:0] w8 = a + (* o1 *) b * (* o2 *) c;
    wire [3:0] w9 = (a + (* p *) b) - (* q *) c;
    wire w10 = a == (* eq *) b;
    wire w11 = a && (* and_a *) b || (* or_a *) c;
    wire [3:0] w12 = a << (* sh *) 1;
    wire [3:0] w13 = a ** (* pw *) 2;
    wire [3:0] w14 = a ^~ (* xn *) b;
    wire [3:0] w15 = a !== (* ne *) b;
    assign y = a ? (* tt *) b : (c);
endmodule
