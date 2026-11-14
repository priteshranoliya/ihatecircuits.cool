// annex: A.8.8 string; A.9.2 comment; A.6.9 system-task-enable
// iverilog: ok
module lex_strings;
    reg [8*20-1:0] s;
    initial begin
        s = "plain";
        s = "with // not a comment";
        s = "with /* not a comment */";
        s = "tab\there";
        s = "newline\nhere";
        s = "quote \" inside";
        s = "backslash \\ inside";
        s = "percent %% sign";
        s = "octal \101\102";
        $display("a string with a continuation \
on the next line");
        $display("%s %0d", "x", 1); // a "quoted" word in a comment
        $display("// still a string");
        $display("/* still a string */");
    end
endmodule
