// annex: A.2.6 function-declaration; A.2.6 function-item-declaration; A.2.6 block-item-declaration; A.2.1.1 parameter-declaration; A.2.1.3 reg-declaration; A.2.1.3 integer-declaration; A.8.2 function-call; A.8.2 system-function-call
// iverilog: ok
module funcs_old;
    function integer f1;
        input integer a;
        input [3:0] b;
        reg [3:0] t;
        integer q;
        real rr;
        time tt;
        begin
            t = b;
            q = a + t;
            f1 = q;
        end
    endfunction

    function [3:0] f2;
        input a;
        parameter P = 3;
        localparam Q = 4;
        f2 = P + Q + a;
    endfunction

    function integer f3 (input integer a);
        begin : body
            integer loc;
            loc = a + 1;
            f3 = loc;
        end
    endfunction

    function [7:0] f4;
        input [7:0] a;
        reg [7:0] t;
        begin
            if (a > 8'd10) t = a;
            else t = ~a;
            f4 = t;
        end
    endfunction

    function [7:0] f5 (input [7:0] a);
        case (a)
            8'd0: f5 = 8'd1;
            8'd1, 8'd2: f5 = 8'd2;
            default: f5 = 8'hFF;
        endcase
    endfunction

    function f6 (input [3:0] a);
        f6 = f1(1, a) > 2;
    endfunction

    reg [7:0] r;
    integer n;
    initial begin
        n = f1(1, 4'h2) + f3(2);
        r = f4(8'd5) + f5(8'd1) + f2(1'b1);
        if (f6(4'h1)) r = 0;
    end
endmodule
