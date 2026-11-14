// annex: A.8.2 system-function-call; A.6.9 system-task-enable; A.8.2 function-call; A.2.6 function-declaration; A.9.3 system-function-identifier; A.9.3 system-task-identifier
// iverilog: ok
module sys_in_funcs;
    integer seed;
    reg [31:0] rnd;
    reg signed [7:0] s;
    reg [7:0] u;
    real rl;
    time now;
    function [7:0] clamp (input [31:0] x);
        clamp = (x > 255) ? 8'hFF : x[7:0];
    endfunction

    function integer lg (input integer n);
        lg = $clog2(n);
    endfunction

    function signed [8:0] sgn (input [7:0] x);
        sgn = $signed({1'b0, x});
    endfunction

    function [7:0] uns (input signed [7:0] x);
        uns = $unsigned(x);
    endfunction

    initial begin
        seed = 1;
        rnd = $random;
        rnd = $random(seed);
        s = $signed(8'hF0);
        u = $unsigned(s);
        rl = $itor(3) + $realtime;
        now = $time + $stime;
        rl = $sqrt(16.0) + $pow(2.0, 3.0) + $ln(2.0) + $exp(1.0) + $sin(0.0);
        rnd = $rtoi(3.7) + $bitstoreal(64'h0) + $realtobits(1.0);
        u = clamp(300) + lg(16) + sgn(8'd5) + uns(-8'sd1);
        $display("n=%0d", lg(100));
    end
endmodule
