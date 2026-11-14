// annex: A.4.2 conditional-generate-construct; A.4.2 if-generate-construct; A.4.2 case-generate-construct; A.4.2 case-generate-item; A.4.2 generate-block; A.4.2 generate-block-or-null
// iverilog: ok
module gen_cond #(parameter MODE = 1, parameter W = 8) (input [W-1:0] a, output [W-1:0] y, output z);
    generate
        if (MODE == 0) begin : m0
            assign y = a;
        end else if (MODE == 1) begin : m1
            assign y = ~a;
        end else if (MODE == 2) begin : m2
            assign y = a << 1;
        end else begin : m3
            assign y = {W{1'b0}};
        end
    endgenerate
    generate
        if (W > 4)
            assign z = 1'b1;
        else
            assign z = 1'b0;
    endgenerate
    wire e1, e2, e3, e4;
    generate
        case (MODE)
            0: begin : c0
                assign e1 = 1'b0;
            end
            1, 2: begin : c12
                assign e1 = 1'b1;
            end
            default: begin : cd
                assign e1 = 1'bx;
            end
        endcase
    endgenerate
    generate
        case (W)
            8: assign e2 = 1'b1;
            16: assign e2 = 1'b0;
            default: assign e2 = 1'bz;
        endcase
    endgenerate
    generate
        if (MODE) begin : nolabel_else_empty
            assign e3 = 1'b1;
        end
        else ;
    endgenerate
    generate
        if (MODE == 5) ; else assign e4 = 1'b0;
    endgenerate
endmodule
