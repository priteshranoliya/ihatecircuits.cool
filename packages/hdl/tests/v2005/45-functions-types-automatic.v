// annex: A.2.6 function-declaration; A.2.6 function-range-or-type; A.2.5 range; A.2.1.1 local-parameter-declaration; A.2.1.2 input-declaration
// iverilog: ok
module funcs_types;
    function real half (input real x);
        half = x / 2.0;
    endfunction

    function realtime rt_id (input realtime t);
        rt_id = t;
    endfunction

    function time t_add (input time a, b);
        t_add = a + b;
    endfunction

    function integer imax (input integer a, input integer b);
        imax = (a > b) ? a : b;
    endfunction

    function automatic [31:0] fact (input [31:0] n);
        if (n <= 1) fact = 1;
        else fact = n * fact(n - 1);
    endfunction

    function automatic integer fib (input integer n);
        if (n < 2) fib = n;
        else fib = fib(n - 1) + fib(n - 2);
    endfunction

    function signed [15:0] sneg (input signed [15:0] x);
        sneg = -x;
    endfunction

    function automatic signed [7:0] sabs (input signed [7:0] x);
        sabs = (x < 0) ? -x : x;
    endfunction

    function integer clog2_c (input integer v);
        integer i;
        begin
            clog2_c = 0;
            for (i = v - 1; i > 0; i = i >> 1)
                clog2_c = clog2_c + 1;
        end
    endfunction

    localparam D = clog2_c(100);
    localparam F = fact(5);
    localparam C2 = $clog2(1024);
    reg [D-1:0] r;
    real rr;
    integer ii;
    initial begin
        rr = half(3.0);
        ii = imax(3, 7) + fib(6);
        r = 0;
    end
endmodule
