// annex: A.4.1 module-instantiation; A.4.1 module-instance; A.4.1 name-of-module-instance; A.4.1 list-of-port-connections; A.4.1 ordered-port-connection; A.4.1 named-port-connection
// iverilog: ok
module sub (input a, input b, output y, output z);
    assign y = a & b;
    assign z = a | b;
endmodule

module sub3 (input a, input b, input c, output y);
    assign y = a ^ b ^ c;
endmodule

module inst_conn;
    wire a, b, c, y1, y2, y3, y4, y5, y6, z1, z2;
    wire [3:0] v;
    sub u1 (a, b, y1, z1);
    sub u2 (.a(a), .b(b), .y(y2), .z(z2));
    sub u3 (.z(), .y(y3), .b(b), .a(a));
    sub u4 (.a(a), .b(), .y(y4), .z());
    sub u5 (a, , y5, );
    sub u6 (a, b, , );
    sub3 u7 (a, ,c , y6);
    sub u8 (.a(v[0] & v[1]), .b(~v[2]), .y(), .z());
    sub u9 (.a({v[0]}), .b(v[3:3]), .y(), .z());
    sub u10 (.a (a) , .b ( b ) , .y ( ) , .z ( ) );
    sub u11 (
        .a(a),   // first
        .b(b),   /* second */
        .y(),
        .z()
    );
endmodule
