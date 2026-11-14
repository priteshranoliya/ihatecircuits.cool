// annex: A.7.2 edge-sensitive-path-declaration; A.7.2 parallel-edge-sensitive-path-description; A.7.2 full-edge-sensitive-path-description; A.7.4 edge-identifier; A.7.4 polarity-operator; A.7.2 data-source-expression
// iverilog: ok
module sp_edge (input clk, rst, d, en, output reg q, output reg qn, output reg [3:0] bq, input [3:0] bd);
    always @(posedge clk) begin
        q <= d;
        qn <= ~d;
        bq <= bd;
    end
    specify
        (posedge clk => (q +: d)) = 3;
        (posedge clk => (qn -: d)) = (1, 2);
        (negedge clk => (q : d)) = (1, 2, 3);
        (posedge clk *> (q +: d)) = 2;
        (posedge clk *> (q, qn +: d)) = 4;
        (clk => (q +: d)) = 1;
        (posedge rst => (q +: 1'b0)) = 2;
        if (en) (posedge clk => (q +: d)) = 3;
        if (!en) (negedge clk => (qn -: d)) = 3;
        if (en) (posedge clk *> (bq +: bd)) = 4;
        (posedge clk => (bq[0] +: bd[0])) = 1;
        (negedge clk => (bq -: ~bd)) = 1;
    endspecify
endmodule
