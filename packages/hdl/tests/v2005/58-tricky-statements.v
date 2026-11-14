// annex: A.6.4 statement; A.6.4 statement-or-null; A.6.6 conditional-statement; A.6.7 case-statement; A.6.8 loop-statement; A.6.3 par-block; A.6.2 always-construct; A.6.2 initial-construct
// iverilog: ok
module tricky;
    reg clk, a, b, c, x, y, z;
    reg [3:0] v;
    integer i, n;
    initial clk = 0;
    always #5 clk = ~clk;
    always #5 begin clk = ~clk; end
    always @(posedge clk) ;
    always @(posedge clk) begin end
    always @(posedge clk) begin : lbl ; end
    initial begin
        ;
        ;;
        x = 1;;
        if (a) ; else ;
        if (a) begin if (b) x = 1; else x = 0; end else y = 1;
        if (a) if (b) x = 1; else y = 1;
        if (a) begin
            case (v)
                0: x = 1;
                default: x = 0;
            endcase
        end else begin
            case (v) 1: x = 0; endcase
        end
        forever @(posedge clk) x = ~x;
    end
    initial begin
        repeat (n) @(posedge clk);
        repeat (n * 2 + 1) begin end
        while (a & b | c && !x) @(posedge clk);
        for (i = 0; i < n; i = i + 1) begin end
        for (i = n; i > 0; i = i >> 1) ;
        fork : f
            begin #1 x = 1; end
            begin #2 y = 1; disable f; end
            begin #3 z = 1; end
        join
        #10 $finish;
    end
    initial begin : outer
        begin : mid
            begin : inner
                x = 1;
                disable mid;
                y = 1;
            end
            z = 1;
        end
        disable outer;
    end
    initial begin
        $display("ok");
        $finish;
    end
endmodule
