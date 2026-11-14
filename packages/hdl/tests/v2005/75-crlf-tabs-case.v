// annex: A.9.4 white-space; A.1.3 module-declaration; A.6.7 case-statement; A.6.3 par-block; A.8.8 string
// iverilog: ok
module crlf2 (input [1:0] s, output reg [3:0] y);
	always @(*) begin
		case (s)
			2'b00: y = 4'h1;
			2'b01: y = 4'h2;
			default: y = 4'hF;
		endcase
	end
	initial begin
		$display("crlf\n");
	end
endmodule
