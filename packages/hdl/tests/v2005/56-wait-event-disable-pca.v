// annex: A.6.5 wait-statement; A.6.5 event-trigger; A.6.5 disable-statement; A.6.1 procedural-continuous-assignments; A.6.2 variable-assignment; A.8.5 variable-lvalue; A.8.5 net-lvalue
// iverilog: ok
module misc_stmts;
    reg a, b, c, clk, flag;
    reg [3:0] v;
    wire [3:0] wn;
    wire wb;
    event ev, ev2;
    integer i;
    initial begin
        wait (a) b = 1;
        wait (a == 1'b1) begin b = 0; end
        wait (!a && b) ;
        wait (v[0]) #1 c = 1;
        wait (flag === 1'b1) c = 0;
        -> ev;
        ->ev2;
        #5 -> ev;
        begin : blk
            a = 1;
            if (b) disable blk;
            a = 0;
        end
        fork : f
            #1 a = 1;
            #2 disable f;
            #3 a = 0;
        join
        disable blk;
        disable f;
        disable misc_stmts.blk;
    end
    reg r;
    reg [3:0] rv;
    initial begin
        assign r = a;
        assign rv = {b, c, a, b};
        deassign r;
        deassign rv;
        assign {a, b} = 2'b11;
        deassign {a, b};
        force r = 1'b0;
        force rv = v;
        force wb = 1'b1;
        force wn = 4'hA;
        force {a, b} = 2'b00;
        release r;
        release rv;
        release wb;
        release wn;
        release {a, b};
    end
endmodule
