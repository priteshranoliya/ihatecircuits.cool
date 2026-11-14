// annex: A.6.2 initial-construct; A.6.5 delay-control; A.2.7 task-declaration; A.6.9 task-enable; A.6.9 system-task-enable; A.6.8 loop-statement; A.4.1 module-instantiation; A.6.3 par-block
// iverilog: ok
module dut (input clk, rst, input [3:0] d, output reg [3:0] q);
    always @(posedge clk) q <= rst ? 4'd0 : d;
endmodule

module tb;
    reg clk, rst;
    reg [3:0] d;
    wire [3:0] q;
    integer errors, i;
    reg [3:0] expected;

    dut u (.clk(clk), .rst(rst), .d(d), .q(q));

    initial clk = 0;
    always #5 clk = ~clk;

    task apply (input [3:0] value);
        begin
            @(negedge clk);
            d = value;
            expected = rst ? 4'd0 : value;
        end
    endtask

    task check;
        begin
            @(posedge clk);
            #1;
            if (q !== expected) begin
                errors = errors + 1;
                $display("FAIL at %0t: q=%h expected=%h", $time, q, expected);
            end
        end
    endtask

    initial begin : stimulus
        errors = 0;
        rst = 1;
        d = 0;
        #12 rst = 0;
        for (i = 0; i < 16; i = i + 1) begin
            apply(i[3:0]);
            check;
        end
        rst = 1;
        apply(4'hF);
        check;
        if (errors == 0) $display("PASS");
        else $display("FAILED: %0d errors", errors);
        $finish;
    end

    initial begin : watchdog
        #10000;
        $display("timeout");
        $finish;
    end

    initial begin
        $dumpfile("tb.vcd");
        $dumpvars(0, tb);
        $monitor("%t clk=%b rst=%b d=%h q=%h", $time, clk, rst, d, q);
    end
endmodule
