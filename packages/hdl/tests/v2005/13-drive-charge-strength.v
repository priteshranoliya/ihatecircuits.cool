// annex: A.2.2.2 drive-strength; A.2.2.2 strength0; A.2.2.2 strength1; A.2.1.3 net-declaration
// iverilog: ok
module strengths (input a, b, en);
    wire (strong1, pull0) w = a;
    wire (pull1, strong0) w2 = b;
    wire (supply0, supply1) w3 = a;
    wire (weak0, weak1) w4 = a;
    wire (highz0, strong1) w5 = a;
    wire (strong0, highz1) w6 = a;
    wire (strong1, pull0) wb1 = a, wb2 = b;
    tri (weak1, weak0) tw = a;
    wand (strong1, strong0) wa = a;
    wor (pull0, pull1) wo = a;
    wire (supply1, supply0) w9 = b;
endmodule
