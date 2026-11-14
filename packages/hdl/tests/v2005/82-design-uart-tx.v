// annex: A.1.3 module-declaration; A.2.1.1 local-parameter-declaration; A.6.7 case-statement; A.6.2 always-construct; A.6.6 conditional-statement; A.8.1 concatenation
// iverilog: ok
module uart_tx #(parameter CLKS_PER_BIT = 16) (
    input clk, rst_n, start,
    input [7:0] data,
    output reg tx, busy, done
);
    localparam [1:0] IDLE = 2'd0, START = 2'd1, DATA = 2'd2, STOP = 2'd3;
    reg [1:0] state;
    reg [15:0] clk_cnt;
    reg [2:0] bit_idx;
    reg [7:0] shreg;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state <= IDLE;
            tx <= 1'b1;
            busy <= 1'b0;
            done <= 1'b0;
            clk_cnt <= 16'd0;
            bit_idx <= 3'd0;
            shreg <= 8'd0;
        end else begin
            done <= 1'b0;
            case (state)
                IDLE: begin
                    tx <= 1'b1;
                    clk_cnt <= 16'd0;
                    bit_idx <= 3'd0;
                    if (start) begin
                        shreg <= data;
                        busy <= 1'b1;
                        state <= START;
                    end
                end
                START: begin
                    tx <= 1'b0;
                    if (clk_cnt == CLKS_PER_BIT - 1) begin
                        clk_cnt <= 16'd0;
                        state <= DATA;
                    end else clk_cnt <= clk_cnt + 16'd1;
                end
                DATA: begin
                    tx <= shreg[bit_idx];
                    if (clk_cnt == CLKS_PER_BIT - 1) begin
                        clk_cnt <= 16'd0;
                        if (bit_idx == 3'd7) state <= STOP;
                        else bit_idx <= bit_idx + 3'd1;
                    end else clk_cnt <= clk_cnt + 16'd1;
                end
                STOP: begin
                    tx <= 1'b1;
                    if (clk_cnt == CLKS_PER_BIT - 1) begin
                        state <= IDLE;
                        busy <= 1'b0;
                        done <= 1'b1;
                    end else clk_cnt <= clk_cnt + 16'd1;
                end
                default: state <= IDLE;
            endcase
        end
    end
endmodule
