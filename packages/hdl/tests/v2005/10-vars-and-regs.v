// annex: A.2.1.3 reg-declaration; A.2.1.3 integer-declaration; A.2.1.3 real-declaration; A.2.1.3 time-declaration; A.2.1.3 realtime-declaration; A.2.1.3 event-declaration; A.2.1.3 genvar-declaration; A.2.3 list-of-variable-identifiers; A.2.4 variable-type
// iverilog: ok
module vars;
    reg r;
    reg [7:0] r8;
    reg signed [7:0] sr8;
    reg [7:0] a, b, c;
    reg r_init = 1'b0;
    reg [3:0] r4_init = 4'hA, r4b = 4'h5;
    integer i, j = 3;
    integer k = 0, l;
    real x, y = 1.5;
    real z = 2.5e1;
    time t0, t1;
    time t2 = 5;
    realtime rt, rt2 = 1.5;
    event ev, ev2;
    event e3;
    reg signed [15:0] ss = -16'sd5;
    genvar g1, g2;
    genvar g3;
    initial begin
        r = 1; r8 = 8'hFF; sr8 = -1;
        a = 1; b = 2; c = 3;
        x = 1.0; t0 = 0; t1 = 0; rt = 0.0;
        -> ev;
    end
endmodule
