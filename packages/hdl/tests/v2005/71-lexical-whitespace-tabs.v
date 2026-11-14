// annex: A.9.4 white-space; A.8.7 number; A.9.3 identifier; A.1.3 module-declaration; A.6.4 seq-block
// iverilog: ok
module	lex_ws	(
	input	[7:0]	a	,
	output	reg	[7:0]	y
	)	;
	reg	[7:0]	t	;
	wire	[7:0]	u	=	a	;


	always	@	(	a	)
	begin
		y	=	8	'hFF	&	a	;
		t	=	4 'd 3	;
		t	=	'h	F	;
		t	=	8'sh	7F	;
		t	=	8 'b 1010_1010	;
	end
endmodule
