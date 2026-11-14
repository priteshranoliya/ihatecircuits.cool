// annex: A.5.4 udp-instantiation; A.5.4 udp-instance; A.5.4 name-of-udp-instance; A.2.2.3 delay2
// iverilog: ok
primitive inv (y, a);
    output y;
    input a;
    table
        0 : 1;
        1 : 0;
        x : x;
    endtable
endprimitive

primitive nand2 (y, a, b);
    output y;
    input a, b;
    table
        0 ? : 1;
        ? 0 : 1;
        1 1 : 0;
    endtable
endprimitive

module udp_inst (input [3:0] a, b, input c, output [3:0] y, output z);
    inv (z, c);
    inv i1 (y[0], a[0]);
    inv i2 (y[1], a[1]), i3 (y[2], a[2]), (y[3], a[3]);
    wire [3:0] t;
    nand2 #5 nd (z, a[0], b[0]);
    nand2 #(1, 2) nd2 (z, a[1], b[1]), nd3 (z, a[2], b[2]);
endmodule
