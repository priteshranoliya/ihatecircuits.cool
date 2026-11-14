// annex: A.2.6 function-declaration; A.2.6 function-item-declaration; A.2.6 function-port-list; A.2.6 function-range-or-type; A.2.5 range; A.2.1.2 input-declaration
// iverilog: ok
module funcs_basic (input [7:0] a, b, output [7:0] y, output signed [8:0] ys, output [3:0] yn);
    function [7:0] add8;
        input [7:0] x;
        input [7:0] z;
        add8 = x + z;
    endfunction

    function [7:0] add8b (input [7:0] x, z);
        begin
            add8b = x + z;
        end
    endfunction

    function signed [8:0] sadd;
        input signed [7:0] x, z;
        sadd = x + z;
    endfunction

    function parity (input [7:0] x);
        parity = ^x;
    endfunction

    function reg [3:0] ones (input [7:0] x);
        integer i;
        begin
            ones = 0;
            for (i = 0; i < 8; i = i + 1)
                ones = ones + x[i];
        end
    endfunction

    function integer twice (input integer n);
        twice = n * 2;
    endfunction

    function [7:0] with_locals;
        input [7:0] v;
        reg [7:0] tmp;
        integer k;
        begin
            tmp = v;
            for (k = 0; k < 2; k = k + 1) tmp = tmp << 1;
            with_locals = tmp;
        end
    endfunction

    assign y = add8(a, b) ^ add8b(a, b) ^ with_locals(a);
    assign ys = sadd(a, b);
    assign yn = ones(a) + parity(b) + twice(2);
endmodule
