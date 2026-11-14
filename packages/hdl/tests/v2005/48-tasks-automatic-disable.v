// annex: A.2.7 task-declaration; A.6.9 task-enable; A.6.5 disable-statement; A.6.4 seq-block; A.6.3 par-block; A.6.4 statement-or-null
// iverilog: ok
module tasks_auto;
    reg [7:0] r;
    integer depth;

    task automatic count_down (input integer n);
        integer local_n;
        begin
            local_n = n;
            if (local_n > 0) begin
                depth = depth + 1;
                count_down(local_n - 1);
            end
        end
    endtask

    task automatic swap (inout [7:0] x, inout [7:0] y);
        reg [7:0] t;
        begin
            t = x; x = y; y = t;
        end
    endtask

    task early_exit;
        input [7:0] v;
        begin : body
            if (v == 0) disable body;
            r = v;
        end
    endtask

    task abort_me;
        begin
            #10 r = 8'hFF;
        end
    endtask

    reg [7:0] p, q;
    initial begin
        depth = 0;
        count_down(3);
        p = 1; q = 2;
        swap(p, q);
        early_exit(8'd0);
        fork
            abort_me;
            begin
                #5 disable abort_me;
            end
        join
        begin : named_blk
            r = 1;
            disable named_blk;
            r = 2;
        end
        disable tasks_auto.early_exit;
    end
endmodule
