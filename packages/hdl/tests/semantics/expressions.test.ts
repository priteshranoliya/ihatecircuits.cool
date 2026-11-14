import { describe } from 'vitest';
import { sem } from './helpers';

describe('arithmetic operators (IEEE 5.1.5)', () => {
  sem(
    '+ - * keep the carry and the borrow in a wider target',
    `module top(input [3:0] a, input [3:0] b, output [4:0] s, output [4:0] d, output [7:0] p);
  assign s = a + b;
  assign d = a - b;
  assign p = a * b;
endmodule`,
    'top',
  );

  sem(
    '/ and % on unsigned operands',
    `module top(input [3:0] a, input [3:0] b, output [3:0] q, output [3:0] r, output [7:0] q8);
  assign q = a / b;
  assign r = a % b;
  assign q8 = a / 4'd3 + b % 4'd5;
endmodule`,
    'top',
  );

  sem(
    'division and modulo by zero give x in every bit',
    `module top(input [3:0] a, input [3:0] b, output [3:0] q, output [3:0] r);
  assign q = a / b;
  assign r = a % b;
endmodule`,
    'top',
    { strict: true, minKnown: 0.8 },
  );

  sem(
    '** with a constant exponent',
    `module top(input [2:0] a, output [8:0] c3, output [8:0] c2, output [8:0] c1, output [8:0] c0, output [8:0] two);
  assign c3 = a ** 3;
  assign c2 = a ** 2;
  assign c1 = a ** 1;
  assign c0 = a ** 0;
  assign two = 2 ** 3 + a;
endmodule`,
    'top',
  );

  sem(
    'signed ** with a constant exponent keeps the sign',
    `module top(input signed [3:0] a, output signed [7:0] sq, output signed [7:0] cube);
  assign sq = a ** 2;
  assign cube = a ** 3;
endmodule`,
    'top',
  );

  sem(
    'unary minus and plus',
    `module top(input [3:0] a, output [3:0] n, output [3:0] p, output [7:0] n8);
  assign n = -a;
  assign p = +a;
  assign n8 = -a;
endmodule`,
    'top',
  );
});

describe('bitwise, logical and reduction operators (IEEE 5.1.6, 5.1.7, 5.1.11, 5.1.9)', () => {
  sem(
    '& | ^ ~^ ^~ and ~',
    `module top(input [3:0] a, input [3:0] b, output [3:0] y_and, output [3:0] y_or, output [3:0] y_xor, output [3:0] y_xnor, output [3:0] y_xnor2, output [3:0] y_not);
  assign y_and = a & b;
  assign y_or = a | b;
  assign y_xor = a ^ b;
  assign y_xnor = a ~^ b;
  assign y_xnor2 = a ^~ b;
  assign y_not = ~a;
endmodule`,
    'top',
  );

  sem(
    'logical && || ! treat any nonzero vector as true and give one bit',
    `module top(input [2:0] a, input [2:0] b, output y_and, output y_or, output y_not, output y_mix, output [3:0] wide);
  assign y_and = a && b;
  assign y_or = a || b;
  assign y_not = !a;
  assign y_mix = a && !b;
  assign wide = (a || b) + (a && b);
endmodule`,
    'top',
  );

  sem(
    'reductions & | ^ ~& ~| ~^',
    `module top(input [5:0] a, output r_and, output r_or, output r_xor, output r_nand, output r_nor, output r_xnor, output r_expr);
  assign r_and = &a;
  assign r_or = |a;
  assign r_xor = ^a;
  assign r_nand = ~&a;
  assign r_nor = ~|a;
  assign r_xnor = ~^a;
  assign r_expr = &(a ^ 6'b101010);
endmodule`,
    'top',
  );

  sem(
    'reduction of a one bit operand and of a part-select',
    `module top(input [5:0] a, output x, output y, output z);
  assign x = ^a[3:3];
  assign y = |a[5:4];
  assign z = &a[2:0];
endmodule`,
    'top',
  );
});

describe('shifts (IEEE 5.1.12)', () => {
  sem(
    '<< >> <<< >>> by a variable amount, a shift of the width or more gives zero',
    `module top(input [5:0] d, input [2:0] n, output [5:0] shl, output [5:0] shr, output [5:0] sll, output [5:0] sra);
  assign shl = d << n;
  assign shr = d >> n;
  assign sll = d <<< n;
  assign sra = d >>> n;
endmodule`,
    'top',
  );

  sem(
    'signed >>> replicates the sign bit, >> fills with zero, <<< is <<',
    `module top(input signed [3:0] a, input [1:0] n, output signed [3:0] sra, output [3:0] srl, output signed [3:0] sla);
  assign sra = a >>> n;
  assign srl = a >> n;
  assign sla = a <<< n;
endmodule`,
    'top',
  );

  sem(
    '-1 >>> 1 stays -1 and 4 >>> 1 is 2 on a sized signed wire',
    `module top(input sel, output [3:0] y, output signed [3:0] ys);
  wire signed [3:0] n1;
  assign n1 = sel ? -4'sd1 : 4'sd4;
  assign y = n1 >>> 1;
  assign ys = n1 >>> 1;
endmodule`,
    'top',
  );

  sem(
    'a signed left operand is sign-extended to the context width before a logical shift',
    `module top(input signed [3:0] a, output [7:0] logical, output [7:0] arith, output [7:0] left);
  assign logical = a >> 1;
  assign arith = a >>> 1;
  assign left = a << 1;
endmodule`,
    'top',
  );

  sem(
    'the shift amount is self-determined and unsigned',
    `module top(input [3:0] a, input signed [2:0] n, output [7:0] y);
  assign y = a << n;
endmodule`,
    'top',
  );
});

describe('relational and equality operators (IEEE 5.1.7, 5.1.8)', () => {
  sem(
    '< <= > >= == != on unsigned operands',
    `module top(input [3:0] a, input [3:0] b, output lt, output le, output gt, output ge, output eq, output ne);
  assign lt = a < b;
  assign le = a <= b;
  assign gt = a > b;
  assign ge = a >= b;
  assign eq = a == b;
  assign ne = a != b;
endmodule`,
    'top',
  );

  sem(
    'signed comparison when both operands are signed',
    `module top(input signed [3:0] a, input signed [3:0] b, output lt, output le, output gt, output ge, output lt0, output gt0);
  assign lt = a < b;
  assign le = a <= b;
  assign gt = a > b;
  assign ge = a >= b;
  assign lt0 = a < 0;
  assign gt0 = a > 0;
endmodule`,
    'top',
  );

  sem(
    'one unsigned operand makes the comparison unsigned, $signed restores a signed one',
    `module top(input signed [3:0] sa, input [3:0] ub, output lt_mixed, output lt_cast, output ge_mixed, output lt_lit);
  assign lt_mixed = sa < ub;
  assign lt_cast = sa < $signed(ub);
  assign ge_mixed = sa >= ub;
  assign lt_lit = sa < 4'd8;
endmodule`,
    'top',
  );

  sem(
    'equality zero-extends a signed operand when the other operand is unsigned',
    `module top(input signed [3:0] sa, input [7:0] ub, output eq_mixed, output eq_signed);
  assign eq_mixed = sa == ub;
  assign eq_signed = sa == $signed(ub);
endmodule`,
    'top',
  );
});

describe('signedness of mixed expressions (IEEE 5.5.1)', () => {
  sem(
    'one unsigned operand makes the whole expression unsigned: no sign extension',
    `module top(input signed [3:0] sa, input [3:0] ub, output [7:0] mixed, output [7:0] both_signed, output [7:0] cast_up, output [7:0] cast_down);
  assign mixed = (sa + ub) >> 1;
  assign both_signed = (sa + $signed(ub)) >> 1;
  assign cast_up = $signed(ub);
  assign cast_down = $unsigned(sa);
endmodule`,
    'top',
  );

  sem(
    'the conditional operator is unsigned when either branch is unsigned',
    `module top(input c, input signed [3:0] sa, input [3:0] ub, input signed [3:0] sb, output [7:0] mixed, output [7:0] both);
  assign mixed = c ? sa : ub;
  assign both = c ? sa : sb;
endmodule`,
    'top',
  );

  sem(
    'unsized decimal literals are signed, based literals are unsigned',
    `module top(input signed [3:0] sa, output [7:0] y_signed, output [7:0] y_unsigned);
  assign y_signed = (sa + 1) >> 1;
  assign y_unsigned = (sa + 'd1) >> 1;
endmodule`,
    'top',
  );

  sem(
    'a sized signed literal sign-extends, a sized unsigned one zero-extends',
    `module top(input sel, output [7:0] s, output [7:0] u, output [7:0] w);
  assign s = sel ? 4'sb1111 : 4'sb0111;
  assign u = sel ? 4'b1111 : 4'b0111;
  assign w = sel ? 8'sb1 : 8'sd5;
endmodule`,
    'top',
  );

  sem(
    '$signed and $unsigned on wires',
    `module top(input [3:0] a, output [7:0] s_ext, output [7:0] u_ext, output lt_neg);
  assign s_ext = $signed(a);
  assign u_ext = $unsigned($signed(a));
  assign lt_neg = $signed(a) < 0;
endmodule`,
    'top',
  );

  sem(
    'signed division and modulo with negative operands truncate toward zero',
    `module top(input signed [3:0] a, input signed [3:0] b, output signed [3:0] q, output signed [3:0] r, output signed [7:0] q8, output signed [7:0] r8);
  assign q = a / b;
  assign r = a % b;
  assign q8 = a / b;
  assign r8 = a % b;
endmodule`,
    'top',
  );

  sem(
    'one unsigned operand makes division and modulo unsigned',
    `module top(input signed [3:0] sa, input [3:0] ub, output [3:0] q, output [3:0] r);
  assign q = sa / ub;
  assign r = sa % ub;
endmodule`,
    'top',
  );

  sem(
    'signed multiplication and a signed sum in a wider target',
    `module top(input signed [3:0] a, input signed [3:0] b, output signed [7:0] p, output signed [4:0] s);
  assign p = a * b;
  assign s = a + b;
endmodule`,
    'top',
  );
});

describe('conditional, concatenation and replication (IEEE 5.1.13, 5.1.14)', () => {
  sem(
    '?: selects a whole vector and nests',
    `module top(input c, input d, input [3:0] a, input [3:0] b, input [3:0] e, output [3:0] y, output [3:0] z);
  assign y = c ? a : b;
  assign z = c ? a : d ? b : e;
endmodule`,
    'top',
  );

  sem(
    '?: with an unknown condition merges the branches bit by bit',
    `module top(input [1:0] idx, input [3:0] p, input [3:0] q, output [3:0] y);
  wire [1:0] v;
  assign v = 2'b01;
  wire c;
  assign c = v[idx];
  assign y = c ? p : q;
endmodule`,
    'top',
    { minKnown: 0.5 },
  );

  sem(
    'concatenation, replication of a constant and of a vector, nesting',
    `module top(input [3:0] a, input [3:0] b, output [7:0] cat, output [3:0] ones, output [7:0] twice, output [8:0] nest, output [4:0] rep3);
  assign cat = {a, b};
  assign ones = {4{1'b1}};
  assign twice = {2{a}};
  assign nest = {a[1:0], {2{b[0]}}, 1'b0, b[3:2], a[3]};
  assign rep3 = {3{a[0]}} ^ {a[2:1], 3'b101};
endmodule`,
    'top',
  );

  sem(
    'replication count from a parameter and a replicated literal with a width',
    `module top(input [1:0] a, output [9:0] y);
  parameter N = 4;
  assign y = {N{a}} ^ {2'b10, {N{2'b01}}};
endmodule`,
    'top',
  );
});

describe('expression width rules (IEEE 5.4, 5.5)', () => {
  sem(
    'a context-determined sum keeps its carry in a wider target and loses it in an equal one',
    `module top(input [7:0] a, input [7:0] b, output [8:0] wide, output [7:0] narrow);
  assign wide = a + b;
  assign narrow = a + b;
endmodule`,
    'top',
  );

  sem(
    'a concatenation operand is self-determined, so its carry is lost',
    `module top(input [7:0] a, input [7:0] b, output [8:0] y);
  assign y = {a + b};
endmodule`,
    'top',
  );

  sem(
    'relational operands are sized to the wider operand, so the carry of a sum is lost',
    `module top(input [7:0] a, input [7:0] b, output ovf, output no_ovf);
  assign ovf = (a + b) < a;
  assign no_ovf = ({1'b0, a} + b) < {1'b0, a};
endmodule`,
    'top',
  );

  sem(
    'an unsized literal widens the expression to 32 bits, a sized one does not',
    `module top(input [7:0] a, output big, output little);
  assign big = (a + 'd250) > 255;
  assign little = (a + 8'd250) > 8'd255;
endmodule`,
    'top',
  );

  sem(
    'a shifted sum is evaluated in the context width of the target',
    `module top(input [7:0] a, input [7:0] b, output [8:0] y, output [7:0] z);
  assign y = (a + b) >> 1;
  assign z = (a + b) >> 1;
endmodule`,
    'top',
  );

  sem(
    '~ inverts after extension to the context width',
    `module top(input [3:0] a, output [7:0] y, output [3:0] z);
  assign y = ~a;
  assign z = ~a;
endmodule`,
    'top',
  );

  sem(
    'constant folding follows the context width of the target',
    `module top(input sel, output [8:0] y, output [8:0] z);
  assign y = sel ? (8'd200 + 8'd100) : 9'd0;
  assign z = sel ? {8'd200 + 8'd100} : 9'd0;
endmodule`,
    'top',
  );

  sem(
    'unsized literals are 32 bits wide in a bitwise expression',
    `module top(input [7:0] a, output all_ones, output seven);
  assign all_ones = (a | 'hFFFF_FF00) == 32'hFFFF_FFFF;
  assign seven = {24'b0, a} == 32'd7;
endmodule`,
    'top',
  );

  sem(
    'literals in several bases with underscores',
    `module top(input [1:0] sel, output [7:0] y);
  assign y = sel == 0 ? 8'b1010_0101 : sel == 1 ? 8'hA5 : sel == 2 ? 8'o245 : 8'd165;
endmodule`,
    'top',
  );
});

describe('expressions wider than 32 bits (IEEE 5.4)', () => {
  sem(
    'a 36 bit concatenation compared with 36 bit literals, summed and shifted',
    `module top(input [3:0] x, output eq, output gt, output lt, output [3:0] sum_hi, output shifted);
  assign eq = {x, x, x, x, x, x, x, x, x} == 36'hAAAAAAAAA;
  assign gt = {x, x, x, x, x, x, x, x, x} > 36'h7FFFFFFFF;
  assign lt = {x, x, x, x, x, x, x, x, x} < 36'h111111111;
  assign sum_hi = ({x, x, x, x, x, x, x, x, x} + 36'h1_0000_0001) >> 32;
  assign shifted = ({x, x, x, x, x, x, x, x, x} >> 4) == {4'b0, x, x, x, x, x, x, x, x};
endmodule`,
    'top',
  );

  sem(
    'a 36 bit literal wraps in a 36 bit sum',
    `module top(input [3:0] x, output [3:0] y);
  assign y = {3'b0, (36'hF_FFFF_FFFF + {32'b0, x}) == 36'd0};
endmodule`,
    'top',
  );

  sem(
    'a 33 bit sum keeps its carry when only the carry is wanted',
    `module top(input [31:0] a, input [31:0] b, output [31:0] s, output c, output [31:0] plo);
  assign s = a + b;
  assign c = ({1'b0, a} + {1'b0, b}) >> 32;
  assign plo = a * b;
endmodule`,
    'top',
  );

  sem(
    'a 40 bit difference, comparison and shift of a 32 bit input and a literal',
    `module top(input [31:0] a, output [7:0] d_hi, output lt, output [7:0] sh);
  assign d_hi = ({8'h01, 32'h0} - {8'h0, a}) >> 32;
  assign lt = {8'h0, a} < 40'h80_0000_0000;
  assign sh = ({8'h0, a} << 8) >> 32;
endmodule`,
    'top',
  );
});

describe('bit-selects and part-selects (IEEE 5.2)', () => {
  sem(
    'a[i] reads x when the index is out of range',
    `module top(input [5:0] a, input [2:0] i, output y);
  assign y = a[i];
endmodule`,
    'top',
    { strict: true, minKnown: 0.7 },
  );

  sem(
    'a[i +: 4] and a[i -: 4] with partly out-of-range windows',
    `module top(input [7:0] a, input [2:0] i, output [3:0] up, output [3:0] down);
  assign up = a[i +: 4];
  assign down = a[i -: 4];
endmodule`,
    'top',
    { strict: true, minKnown: 0.6 },
  );

  sem(
    'indexed part-select with a constant base and a wider vector',
    `module top(input [15:0] a, output [3:0] up, output [3:0] down, output [1:0] mid);
  assign up = a[6 +: 4];
  assign down = a[9 -: 4];
  assign mid = a[8 +: 2];
endmodule`,
    'top',
  );

  sem(
    'ascending range [0:5]: index 0 is the most significant bit',
    `module top(input [0:5] a, input [2:0] i, output msb, output lsb, output [0:2] hi, output [0:1] win, output d);
  assign msb = a[0];
  assign lsb = a[5];
  assign hi = a[0:2];
  assign win = a[2 +: 2];
  assign d = a[i];
endmodule`,
    'top',
    { strict: true, minKnown: 0.7 },
  );

  sem(
    'ascending range [0:7] on ports: bit 0 is the leftmost, a copy keeps the order',
    `module top(input [0:7] a, output [0:3] hi, output [0:3] lo, output b0, output b7, output [7:0] same, output [3:0] mid);
  assign hi = a[0:3];
  assign lo = a[4:7];
  assign b0 = a[0];
  assign b7 = a[7];
  assign same = a;
  assign mid = {a[3], a[4], a[1], a[6]};
endmodule`,
    'top',
  );

  sem(
    'ascending internal vector assigned from a descending one',
    `module top(input [3:0] a, output [3:0] y, output [1:0] pair);
  wire [0:3] w;
  assign w = a;
  assign y = {w[3], w[2], w[1], w[0]};
  assign pair = w[1:2];
endmodule`,
    'top',
  );

  sem(
    'non-zero least significant index [11:4]',
    `module top(input [11:4] a, input [3:0] i, output [3:0] mid, output msb, output lsb, output d, output [1:0] win);
  assign mid = a[7:4];
  assign msb = a[11];
  assign lsb = a[4];
  assign d = a[i];
  assign win = a[i +: 2];
endmodule`,
    'top',
    { strict: true, minKnown: 0.5 },
  );

  sem(
    'bit-select of a vector with a computed index',
    `module top(input [7:0] a, input [1:0] i, output y, output z);
  assign y = a[{i, 1'b1}];
  assign z = a[i + 4];
endmodule`,
    'top',
  );
});

describe('operator precedence and associativity (IEEE table 5-4)', () => {
  sem(
    'multiplication before addition, subtraction associates left, + binds tighter than <<',
    `module top(input [3:0] a, input [3:0] b, input [3:0] c, output [7:0] y1, output [7:0] y2, output [7:0] y3, output [7:0] y4);
  assign y1 = a + b * c;
  assign y2 = a - b - c;
  assign y3 = a << 1 + 1;
  assign y4 = a * b << 1;
endmodule`,
    'top',
  );

  sem(
    'equality binds tighter than &, & tighter than ^ tighter than |, ! tighter than ==',
    `module top(input [3:0] a, input [3:0] b, input [3:0] c, output [3:0] y1, output [3:0] y2, output y3, output [3:0] y4);
  assign y1 = a & b == c;
  assign y2 = a | b ^ c & a;
  assign y3 = !a == b[0];
  assign y4 = ~a & b | c;
endmodule`,
    'top',
  );

  sem(
    '?: is right associative and lowest, logical operators bind looser than comparison',
    `module top(input [3:0] a, input [3:0] b, input [3:0] c, output [3:0] y1, output y2, output y3);
  assign y1 = a > b ? a : b > c ? b : c;
  assign y2 = a > b && b > c || a == c;
  assign y3 = a < b == b < c;
endmodule`,
    'top',
  );
});
