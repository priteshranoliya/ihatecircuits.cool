// annex: A.6.7 case-statement; A.6.7 case-item; A.6.4 statement-or-null; A.8.1 concatenation
// iverilog: ok
module cases;
    reg [3:0] v;
    reg [1:0] s;
    reg a, b, y;
    reg [7:0] r;
    initial begin
        case (v)
            4'd0: y = 0;
            4'd1: y = 1;
            default: y = 0;
        endcase
        case (v)
            0, 1, 2: y = 0;
            3, 4: begin y = 1; r = 1; end
            5: ;
            6: ;
            default: ;
        endcase
        case (s)
            2'b00: y = a;
            2'b01: y = b;
            2'b1x: y = 1'bx;
            2'b1z: y = 1'bz;
        endcase
        case ({a, b})
            2'b00, 2'b11: y = 0;
            2'b01, 2'b10: y = 1;
        endcase
        case (1'b1)
            v[0]: y = 0;
            v[1]: y = 1;
            default: y = 1'bx;
        endcase
        case (v) default: y = 1; endcase
        case (v + 1)
            4'd1 + 4'd1: y = 1;
            a ? 1 : 2: y = 0;
        endcase
        casez (v)
            4'b1???: y = 1;
            4'b01??: y = 0;
            4'b001z: y = 1;
            4'b0001: y = 0;
            default: y = 1'bx;
        endcase
        casex (v)
            4'b1xxx: y = 1;
            4'b01xx: y = 0;
            4'b001?: y = 1;
            4'bzzzz: y = 0;
        endcase
        casez (s) 2'b1?: y = 1; 2'b?1: y = 0; endcase
        case (s) 2'd0: case (a) 1'b0: y = 0; 1'b1: y = 1; endcase 2'd1: y = 1; endcase
        if (a) case (s) 0: y = 0; default: y = 1; endcase else y = 0;
    end
endmodule
