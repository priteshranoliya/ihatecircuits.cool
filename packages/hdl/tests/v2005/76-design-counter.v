// annex: A.1.3 module-declaration; A.1.4 module-parameter-port-list; A.6.2 always-construct; A.6.6 conditional-statement; A.6.5 event-control; A.6.2 nonblocking-assignment; A.8.1 concatenation
// iverilog: ok
module counter #(
    parameter WIDTH = 8,
    parameter [WIDTH-1:0] MAX = {WIDTH{1'b1}}
) (
    input  wire             clk,
    input  wire             rst_n,
    input  wire             en,
    input  wire             load,
    input  wire [WIDTH-1:0] din,
    output reg  [WIDTH-1:0] q,
    output wire             wrap
);
    assign wrap = (q == MAX) & en;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            q <= {WIDTH{1'b0}};
        else if (load)
            q <= din;
        else if (en) begin
            if (q == MAX)
                q <= {WIDTH{1'b0}};
            else
                q <= q + 1'b1;
        end
    end
endmodule
