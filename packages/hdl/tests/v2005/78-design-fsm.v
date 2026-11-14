// annex: A.1.3 module-declaration; A.2.1.1 local-parameter-declaration; A.6.7 case-statement; A.6.2 always-construct; A.6.6 conditional-statement; A.6.5 event-control
// iverilog: ok
module fsm_seq (
    input clk, rst, in,
    output reg detected
);
    localparam [2:0] S0 = 3'd0, S1 = 3'd1, S2 = 3'd2, S3 = 3'd3, S4 = 3'd4;
    reg [2:0] state, next;

    always @(posedge clk or posedge rst) begin
        if (rst) state <= S0;
        else state <= next;
    end

    always @(state or in) begin
        next = state;
        detected = 1'b0;
        case (state)
            S0: if (in) next = S1;
            S1: begin
                if (!in) next = S2;
            end
            S2: if (in) next = S3; else next = S0;
            S3: begin
                if (in) begin
                    next = S4;
                end else begin
                    next = S2;
                end
            end
            S4: begin
                detected = 1'b1;
                next = in ? S1 : S2;
            end
            default: next = S0;
        endcase
    end
endmodule

module fsm_traffic (input clk, rst, car, output reg [1:0] light);
    parameter RED = 2'b00, GREEN = 2'b01, YELLOW = 2'b10;
    reg [3:0] timer;
    always @(posedge clk) begin
        if (rst) begin
            light <= RED;
            timer <= 4'd0;
        end else begin
            timer <= timer + 1;
            case (light)
                RED:    if (timer == 4'd9 && car) begin light <= GREEN; timer <= 4'd0; end
                GREEN:  if (timer == 4'd7) begin light <= YELLOW; timer <= 4'd0; end
                YELLOW: if (timer == 4'd2) begin light <= RED; timer <= 4'd0; end
                default: light <= RED;
            endcase
        end
    end
endmodule
