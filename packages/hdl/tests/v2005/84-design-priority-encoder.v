// annex: A.6.7 case-statement; A.6.6 conditional-statement; A.6.8 loop-statement; A.1.3 module-declaration; A.8.1 concatenation; A.2.6 function-declaration
// iverilog: ok
module prio_enc_casez (input [7:0] req, output reg [2:0] idx, output reg valid);
    always @* begin
        valid = 1'b1;
        casez (req)
            8'b1???????: idx = 3'd7;
            8'b01??????: idx = 3'd6;
            8'b001?????: idx = 3'd5;
            8'b0001????: idx = 3'd4;
            8'b00001???: idx = 3'd3;
            8'b000001??: idx = 3'd2;
            8'b0000001?: idx = 3'd1;
            8'b00000001: idx = 3'd0;
            default: begin idx = 3'd0; valid = 1'b0; end
        endcase
    end
endmodule

module prio_enc_loop #(parameter N = 8) (input [N-1:0] req, output reg [2:0] idx, output reg valid);
    integer i;
    always @* begin
        idx = 0;
        valid = 0;
        for (i = 0; i < N; i = i + 1)
            if (req[i]) begin
                idx = i;
                valid = 1;
            end
    end
endmodule

module prio_enc_casex (input [3:0] r, output reg [1:0] y);
    always @(r)
        casex (r)
            4'b1xxx: y = 2'd3;
            4'b01xx: y = 2'd2;
            4'b001x: y = 2'd1;
            default: y = 2'd0;
        endcase
endmodule

module prio_arb (input [3:0] req, output [3:0] grant);
    assign grant[0] = req[0];
    assign grant[1] = req[1] & ~req[0];
    assign grant[2] = req[2] & ~|req[1:0];
    assign grant[3] = req[3] & ~|req[2:0];
endmodule
