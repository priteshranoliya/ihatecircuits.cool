// annex: A.7.1 specify-block; A.7.1 specify-item; A.7.1 pulsestyle-declaration; A.7.1 showcancelled-declaration; A.2.1.1 specparam-declaration; A.7.3 list-of-path-outputs
// iverilog: ok
module sp_pulse (input a, b, output y, z);
    assign y = a;
    assign z = b;
    specify
        specparam rj = 2, rej = 1;
        pulsestyle_onevent y;
        pulsestyle_ondetect z;
        pulsestyle_onevent y, z;
        showcancelled y;
        noshowcancelled z;
        showcancelled y, z;
        (a => y) = 3;
        (b => z) = 3;
    endspecify
    specify
        (a => z) = 1;
    endspecify
    specify
    endspecify
endmodule
