// annex: A.9.3 identifier; A.9.3 simple-identifier; A.9.3 escaped-identifier; A.9.3 hierarchical-identifier; A.9.3 system-function-identifier; A.9.3 system-task-identifier; A.9.3 hierarchical-net-identifier; A.9.3 hierarchical-variable-identifier
// iverilog: ok
module ident;
    wire \bus+index ;
    wire \a$b ;
    wire \1abc ;
    wire \esc!ape ;
    wire \*star* ;
    wire \net[3] ;
    wire \x.y ;
    wire [3:0] \vec[3:0] ;
    wire simple;
    wire _under;
    wire a$dollar;
    wire a_1_$_b;
    wire UPPER, MixedCase, lower;
    wire \bus+index2 , \z ;
    assign \bus+index = 1'b1;
    assign \a$b = \bus+index ;
    assign \1abc = \a$b & simple;
    assign \esc!ape = ~\1abc ;
    assign \*star* = \esc!ape ^ \net[3] ;
    assign \net[3] = 1'b0;
    assign \x.y = 1'b1;
    assign \vec[3:0] = {4{\x.y }};
    assign simple = 1'b1;
    assign _under = simple;
    assign a$dollar = _under;
    assign a_1_$_b = a$dollar;
    assign UPPER = 1, MixedCase = 0, lower = 1;
    assign \bus+index2 = \vec[3:0] [0];
    assign \z = ident.\z ;
    reg \reg ;
    reg \wire-name ;
    initial begin
        \reg = \wire-name ;
        \wire-name <= \reg ;
        $display("%d", \reg );
    end
endmodule
