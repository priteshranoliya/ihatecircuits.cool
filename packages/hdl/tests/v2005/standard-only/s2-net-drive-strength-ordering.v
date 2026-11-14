// annex: A.2.1.3 net-declaration; A.2.2.2 drive-strength; A.2.2.3 delay3; A.2.5 range
// iverilog: rejects (syntax error / Invalid module item. when drive_strength precedes range, signed, vectored or a delay3)
module strength_order (input a, b);
    wire (strong1, pull0) [3:0] w8 = {4{a}};
    wire (strong1, pull0) signed sw = a;
    wire (pull0, weak1) #2 w7 = b;
    wire (supply0, supply1) #(1, 2) w9 = a;
    wire (strong1, pull0) vectored [3:0] v8 = {4{a}};
    tri (weak1, weak0) [3:0] tw = {4{b}};
endmodule
