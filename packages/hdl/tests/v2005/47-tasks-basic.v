// annex: A.2.7 task-declaration; A.2.7 task-item-declaration; A.2.7 task-port-list; A.2.7 task-port-item; A.2.7 tf-input-declaration; A.2.7 tf-output-declaration; A.2.7 tf-inout-declaration; A.6.9 task-enable
// iverilog: ok
module tasks_basic;
    reg [7:0] a, b, c;
    integer count;
    reg flag;

    task noargs;
        begin
            count = count + 1;
        end
    endtask

    task oneargs;
        input [7:0] v;
        begin
            a = v;
        end
    endtask

    task old_style;
        input [7:0] x, y;
        output [7:0] s;
        inout [7:0] z;
        reg [7:0] tmp;
        begin
            tmp = x + y;
            s = tmp;
            z = z + 1;
        end
    endtask

    task ansi_style (input [7:0] x, input [7:0] y, output [7:0] s, inout flg);
        begin
            s = x + y;
            flg = ~flg;
        end
    endtask

    task ansi_shared (input [3:0] p, q, output [3:0] r, s);
        begin
            r = p;
            s = q;
        end
    endtask

    task with_types (input integer n, input real r, input time t, output integer m);
        m = n;
    endtask

    task with_local;
        integer i;
        reg r;
        begin
            for (i = 0; i < 3; i = i + 1) r = i;
        end
    endtask

    task single_stmt;
        count = 0;
    endtask

    task nulltask;
        ;
    endtask

    reg [3:0] p1, p2;
    integer mm;
    initial begin
        count = 0;
        flag = 0;
        noargs;
        noargs();
        oneargs(8'd5);
        old_style(8'd1, 8'd2, b, c);
        ansi_style(a, b, c, flag);
        ansi_shared(4'd1, 4'd2, p1, p2);
        with_types(3, 1.5, 10, mm);
        with_local;
        single_stmt;
        nulltask;
    end
endmodule
