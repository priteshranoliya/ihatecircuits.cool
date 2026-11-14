// annex: A.9.4 white-space; A.8.6 binary-operator; A.8.6 unary-operator; A.8.7 number; A.8.1 concatenation; A.8.4 primary
// iverilog: ok
module
lex_tokens
(
input
[
7
:
0
]
a
,
input
b
,
output
[
7
:
0
]
y
)
;
wire
[
7
:
0
]
t
=
a
+
8
'h01
;
wire
[3:0]  q  =  {  a  [  3  :  0  ]  }  ;
wire [7:0] s1 = a<<1, s2 = a>>1, s3 = a<<<1, s4 = a>>>1;
wire [7:0] n1 = ~a, n2 = - a, n3 = + a, n4 = ~ a;
wire z1 = a [ 0 ] ;
wire z2 = a [ 0 +: 2 ] ;
wire z3 = & a ;
wire z6 = a ^ ~ b;
wire z7 = a ^~ b;
wire z9 = a===b, z10 = a!==b, z11 = a==b, z12 = a!=b;
wire z12b = a>=b, z13 = a<=b, z14=a<b, z15=a>b;
wire z16 = a&&b, z17 = a||b, z18=!a;
wire z19 = a&b|b^a;
assign
y
=
t
;
endmodule
