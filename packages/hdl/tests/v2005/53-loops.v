// annex: A.6.8 loop-statement; A.6.2 variable-assignment; A.6.4 statement-or-null
// iverilog: ok
module loops;
    integer i, j, n;
    reg a, b, c, clk;
    reg [7:0] v;
    reg [7:0] mem [0:15];
    initial begin
        for (i = 0; i < 16; i = i + 1)
            mem[i] = i;
        for (i = 0; i < n; i = i + 1) begin end
        for (i = 0; i < 4; i = i + 1) ;
        for (i = 0; i < 4; i = i + 1)
            for (j = 0; j < 4; j = j + 1)
                v[j] = v[i] ^ i;
        for (i = 15; i >= 0; i = i - 1) begin
            mem[i] = mem[15 - i];
        end
        for (i = 1; i < 100; i = i * 2) v = v + 1;
        for (v = 0; v < 3; v = v + 1) a = ~a;
        while (i > 0) i = i - 1;
        while (a && (b || c) && !(i < 5)) begin
            i = i - 1;
            if (i == 3) a = 0;
        end
        while (0) ;
        repeat (3) a = ~a;
        repeat (n + 1) begin
            b = ~b;
            @(posedge clk);
        end
        repeat (2 * i) @(posedge clk);
        repeat (v[1:0]) #1 c = ~c;
        i = 3;
        forever begin : fb
            #1 a = ~a;
            if (i == 0) disable fb;
            i = i - 1;
        end
    end
endmodule
