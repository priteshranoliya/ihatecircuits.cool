// annex: A.6.3 par-block; A.6.4 seq-block; A.6.4 block-item-declaration; A.6.3 block-identifier; A.2.1.3 integer-declaration; A.2.1.3 reg-declaration; A.2.1.3 real-declaration; A.2.1.3 event-declaration; A.2.1.1 parameter-declaration
// iverilog: ok
module blocks;
    reg a, b, c, r2;
    initial begin : blk
        integer i;
        reg r;
        reg [3:0] v, w;
        real x;
        time t;
        realtime rt;
        event e;
        reg [7:0] m [0:3];
        parameter P = 3;
        localparam Q = 4;
        i = P + Q;
        r = 0;
        v = 4'hF;
        x = 1.5;
        t = 0;
        -> e;
    end
    initial begin : blk2
        reg k;
        begin : inner
            integer j;
            j = 0;
            begin : innermost
                reg z;
                z = 1;
            end
        end
        k = 1;
    end
    initial begin
        begin : sub1 a = 1; end
        begin : sub2 b = 1; end
    end
    initial fork : par
        integer pi;
        reg pr;
        #1 a = 1;
        #2 b = 1;
        #3 c = 1;
    join
    initial fork
        a = 0;
        b = 0;
        begin : s1 #2 a = 1; #2 a = 0; end
        begin #1 c = 1; end
    join
    initial fork : pf2
        fork : nested
            #1 a = 1;
        join
        begin : blk3 #1 b = 1; end
    join
    initial begin : empty_named
    end
    initial begin : lbl
        fork : par2
            #5 a = 1;
            begin #2 disable par2; end
        join
    end
endmodule
