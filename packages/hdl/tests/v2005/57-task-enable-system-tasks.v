// annex: A.6.9 task-enable; A.6.9 system-task-enable; A.9.3 system-task-identifier; A.8.2 list-of-arguments; A.8.1 concatenation
// iverilog: ok
module sys_tasks;
    reg clk;
    reg [7:0] a, b;
    reg [7:0] mem [0:15];
    integer fd, seed, n;
    real r;
    time t;

    task show (input [7:0] x);
        $display("x = %h", x);
    endtask

    task two (input [7:0] x, y);
        $display("%0d %0d", x, y);
    endtask

    task none;
        $display("none");
    endtask

    initial begin
        show(a);
        show(a + b);
        show(8'hAB);
        two(a, b);
        two(a, 8'd3);
        none;
        none();
        $display;
        $display();
        $display("hello");
        $display("a=%d b=%h", a, b);
        $display(a, b);
        $display(, a);
        $display("x", , "y");
        $display("t=%t", $time);
        $display("%s", "abc");
        $display("%b %o %x", a, b, a);
        $display("%m");
        $display("%0d%%", 5);
        $display("tab\there\\ \"quote\" \n");
        $write("no newline");
        $write("%d", a);
        $monitor("%d", a);
        $monitor(a, b);
        $monitoroff;
        $monitoron;
        $strobe("%d", a);
        fd = $fopen("out.txt");
        fd = $fopen("out.txt", "w");
        $fdisplay(fd, "x=%d", a);
        $fwrite(fd, "y");
        $fclose(fd);
        $readmemh("data.hex", mem);
        $readmemb("data.bin", mem, 0, 15);
        $readmemh("data.hex", mem, 4);
        $dumpfile("out.vcd");
        $dumpvars;
        $dumpvars(0, sys_tasks);
        a = $random;
        a = $random(seed);
        r = $realtime;
        t = $time;
        n = $signed(a);
        $stop;
        $finish;
        $finish(0);
    end
endmodule
