// annex: A.7.5.1 system-timing-check; A.7.5.1 $setup-timing-check; A.7.5.1 $hold-timing-check; A.7.5.1 $setuphold-timing-check; A.7.5.1 $recovery-timing-check; A.7.5.1 $removal-timing-check; A.7.5.1 $recrem-timing-check; A.7.5.1 $skew-timing-check; A.7.5.1 $timeskew-timing-check; A.7.5.1 $fullskew-timing-check; A.7.5.1 $period-timing-check; A.7.5.1 $width-timing-check; A.7.5.1 $nochange-timing-check; A.7.5.2 timing-check-event; A.7.5.2 controlled-timing-check-event; A.7.5.3 timing-check-condition; A.7.5.3 scalar-timing-check-condition; A.7.5.3 edge-control-specifier
// iverilog: ok
module sp_checks (input clk, d, rst, en, input [3:0] v, output reg q);
    reg ntf;
    wire dclk, ddat;
    always @(posedge clk) q <= d;
    specify
        $setup(d, posedge clk, 1);
        $setup(d, negedge clk, 1, ntf);
        $hold(posedge clk, d, 2);
        $hold(posedge clk, d, 2, ntf);
        $setuphold(posedge clk, d, 1, 2);
        $setuphold(posedge clk, d, 1, 2, ntf);
        $setuphold(posedge clk, d, 1, 2, ntf, , , dclk, ddat);
        $recovery(posedge rst, posedge clk, 3);
        $recovery(negedge rst, posedge clk, 3, ntf);
        $removal(posedge rst, posedge clk, 3);
        $recrem(posedge rst, posedge clk, 3, 4);
        $skew(posedge clk, negedge clk, 5);
        $timeskew(posedge clk, negedge clk, 5);
        $fullskew(posedge clk, negedge clk, 5, 6);
        $period(posedge clk, 10);
        $period(posedge clk, 10, ntf);
        $width(posedge clk, 5);
        $width(negedge clk, 5, 1, ntf);
        $nochange(posedge clk, d, 0, 0);
        $setup(d, posedge clk &&& en, 1);
        $setup(d &&& en, posedge clk, 1);
        $setup(d, posedge clk &&& ~en, 1);
        $setup(d, posedge clk &&& (en == 1'b1), 1);
        $hold(posedge clk &&& en, d &&& !rst, 1);
        $setup(d, edge[01, 10] clk, 1);
        $setup(d, edge[x1, 1x, 0z, z0] clk, 1);
        $hold(posedge clk, v[2], 1);
        $hold(posedge clk, v[3:0], 1);
        $width(edge[01] clk, 4);
    endspecify
endmodule
