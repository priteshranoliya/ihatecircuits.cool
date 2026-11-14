// annex: A.1.2 config-declaration; A.1.2 design-statement; A.1.2 config-rule-statement; A.1.2 default-clause; A.1.2 inst-clause; A.1.2 inst-name; A.1.2 cell-clause; A.1.2 liblist-clause; A.1.2 use-clause
// iverilog: rejects (sorry: config declarations are not supported and will be skipped.)
module top;
endmodule

config cfg1;
    design work.top;
    default liblist lib1 lib2;
    instance top.u1 use lib3.m;
    cell m use lib4.m;
endconfig

config cfg2;
    design top;
    default liblist lib1;
    instance top.u1.u2 liblist lib5;
    cell lib6.m liblist lib7 lib8;
    cell n use n:config;
    instance top.u3 use lib9.k:config;
endconfig

config cfg3;
    design lib1.top lib2.other bare_cell;
endconfig
