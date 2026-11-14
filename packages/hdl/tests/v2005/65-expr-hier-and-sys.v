// annex: A.8.4 primary; A.9.3 hierarchical-identifier; A.8.2 function-call; A.8.2 system-function-call; A.8.2 constant-function-call; A.9.3 system-function-identifier
// iverilog: ok
module sub (output [3:0] q);
    reg [3:0] mem [0:1];
    function [3:0] inc (input [3:0] x);
        inc = x + 1;
    endfunction
    assign q = inc(4'd3);
    initial begin
        mem[0] = 4'h5;
        mem[1] = 4'hA;
    end
endmodule

module wrap;
    wire [3:0] q;
    sub u (q);
endmodule

module top_h;
    reg [3:0] a;
    integer i;
    real r;
    wrap w ();
    sub u1 (.q());
    function [3:0] dbl (input [3:0] x);
        dbl = x << 1;
    endfunction
    initial begin
        a = w.u.mem[0];
        a = w.u.mem[1][2:0];
        a = w.u.inc(4'd2);
        a = u1.inc(u1.mem[0]);
        a = w.q;
        a = w.u.q;
        a = top_h.u1.mem[1];
        a = dbl(dbl(2) + dbl(1));
        a = dbl(a) ^ top_h.dbl(a);
        i = $time;
        i = $stime;
        r = $realtime;
        i = $random;
        i = $random(i);
        i = $signed(a);
        i = $unsigned(a);
        i = $clog2(a);
        r = $itor(i) + $sqrt(2.0);
        i = $rtoi(r);
        a = $signed(a) + $unsigned(a);
        a = a + $time;
    end
endmodule
