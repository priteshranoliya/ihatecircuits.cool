import { describe } from 'vitest';
import { sem } from './helpers';

describe('edge-triggered registers (IEEE 9.2, 9.7)', () => {
  sem(
    'posedge register loads on the rising edge',
    `module top(input clk, input [3:0] d, output reg [3:0] q);
  always @(posedge clk) q <= d;
endmodule`,
    'top',
  );

  sem(
    'negedge register loads when the clock falls, one phase after the posedge sample',
    `module top(input clk, input [3:0] d, output reg [3:0] q);
  always @(negedge clk) q <= d;
endmodule`,
    'top',
    { skipFirstCycle: true },
  );

  sem(
    'clock enable and synchronous reset on a counter',
    `module top(input clk, input rst, input en, output reg [3:0] cnt);
  always @(posedge clk) begin
    if (rst) cnt <= 4'd0;
    else if (en) cnt <= cnt + 4'd1;
  end
endmodule`,
    'top',
    { random: true, cycles: 300, ones: { rst: 0.1 }, prefix: [{ rst: '1', en: '0' }] },
  );

  sem(
    'a register chain across two always blocks: nonblocking assignments see the old value',
    `module top(input clk, input [3:0] a, output reg [3:0] s1, output reg [3:0] s2);
  always @(posedge clk) s1 <= a;
  always @(posedge clk) s2 <= s1;
endmodule`,
    'top',
  );

  sem(
    'a later nonblocking assignment to the same reg wins',
    `module top(input clk, input c, input [3:0] a, output reg [3:0] q);
  always @(posedge clk) begin
    q <= 4'd1;
    if (c) q <= a;
  end
endmodule`,
    'top',
  );

  sem(
    'a divided clock drives a second register after the first has updated',
    `module top(input clk, input rst, input [3:0] d, output reg q, output reg [3:0] cap);
  always @(posedge clk) begin
    if (rst) q <= 1'b0;
    else q <= ~q;
  end
  always @(posedge q) cap <= d;
endmodule`,
    'top',
    { random: true, ones: { rst: 0.05 }, prefix: [{ rst: '1', d: '0000' }] },
  );

  sem(
    'signed accumulator with synchronous reset and signed comparisons',
    `module top(input clk, input rst, input signed [3:0] d, output reg signed [7:0] acc, output pos, output sat);
  always @(posedge clk) begin
    if (rst) acc <= 8'sd0;
    else acc <= acc + d;
  end
  assign pos = acc > 0;
  assign sat = acc > 8'sd20;
endmodule`,
    'top',
    { random: true, cycles: 300, ones: { rst: 0.03 }, prefix: [{ rst: '1', d: '0000' }] },
  );

  sem(
    'a shift register written with a loop over bit-selects',
    `module top(input clk, input din, output reg [3:0] sr);
  integer i;
  always @(posedge clk) begin
    sr[0] <= din;
    for (i = 1; i < 4; i = i + 1) sr[i] <= sr[i - 1];
  end
endmodule`,
    'top',
    { random: true, cycles: 100 },
  );

  sem(
    'a two-block finite state machine',
    `module top(input clk, input rst, input go, output reg [1:0] state, output busy);
  reg [1:0] next;
  always @(posedge clk) begin
    if (rst) state <= 2'd0;
    else state <= next;
  end
  always @* begin
    case (state)
      2'd0: next = go ? 2'd1 : 2'd0;
      2'd1: next = 2'd2;
      2'd2: next = go ? 2'd3 : 2'd0;
      default: next = 2'd0;
    endcase
  end
  assign busy = state != 2'd0;
endmodule`,
    'top',
    { random: true, cycles: 200, ones: { rst: 0.05 }, prefix: [{ rst: '1', go: '0' }] },
  );
});

describe('asynchronous reset and set (IEEE 9.7.5)', () => {
  sem(
    'async reset with always @(posedge clk or posedge rst)',
    `module top(input clk, input rst, input [3:0] d, output reg [3:0] q);
  always @(posedge clk or posedge rst) begin
    if (rst) q <= 4'd0;
    else q <= d;
  end
endmodule`,
    'top',
  );

  sem(
    'active-low async reset with negedge rstn',
    `module top(input clk, input rstn, input [3:0] d, output reg [3:0] q);
  always @(posedge clk or negedge rstn) begin
    if (!rstn) q <= 4'd0;
    else q <= d;
  end
endmodule`,
    'top',
  );

  sem(
    'async set loads all ones',
    `module top(input clk, input set, input [3:0] d, output reg [3:0] q);
  always @(posedge clk or posedge set) begin
    if (set) q <= 4'hF;
    else q <= d;
  end
endmodule`,
    'top',
  );

  sem(
    'async reset to a non-zero constant on a register clocked by the falling edge',
    `module top(input clk, input rst, input [3:0] d, output reg [3:0] q);
  always @(negedge clk or posedge rst) begin
    if (rst) q <= 4'd9;
    else q <= d;
  end
endmodule`,
    'top',
    { skipFirstCycle: true },
  );

  sem(
    'async reset has priority over the clock edge that arrives in the same cycle',
    `module top(input clk, input rst, input [3:0] d, output reg [3:0] q);
  always @(posedge clk or posedge rst) begin
    if (rst) q <= 4'd0;
    else q <= d;
  end
endmodule`,
    'top',
    {
      stimulus: [
        { rst: '0', d: '0101' },
        { rst: '0', d: '0110' },
        { rst: '1', d: '0111' },
        { rst: '1', d: '1000' },
        { rst: '0', d: '1001' },
        { rst: '0', d: '1010' },
        { rst: '1', d: '1011' },
        { rst: '0', d: '1100' },
      ],
    },
  );

  sem(
    'a counter with async reset and enable',
    `module top(input clk, input rst, input en, output reg [3:0] cnt);
  always @(posedge clk or posedge rst) begin
    if (rst) cnt <= 4'd0;
    else if (en) cnt <= cnt + 4'd1;
  end
endmodule`,
    'top',
    { random: true, cycles: 300, ones: { rst: 0.08 }, prefix: [{ rst: '1', en: '0' }] },
  );

  sem(
    'two registers share one async reset in one block, the reset value of each is its own constant',
    `module top(input clk, input rstn, input [1:0] d, output reg [1:0] a, output reg [2:0] b);
  always @(posedge clk or negedge rstn) begin
    if (!rstn) begin
      a <= 2'd1;
      b <= 3'd6;
    end else begin
      a <= d;
      b <= {d, a[0]};
    end
  end
endmodule`,
    'top',
    { random: true, cycles: 200, ones: { rstn: 0.9 } },
  );
});

describe('combinational always blocks and sensitivity lists (IEEE 9.7)', () => {
  sem(
    'always @* with a case multiplexer',
    `module top(input [1:0] s, input [3:0] a, input [3:0] b, output reg [3:0] y);
  always @* begin
    case (s)
      2'd0: y = a;
      2'd1: y = b;
      2'd2: y = a & b;
      default: y = a | b;
    endcase
  end
endmodule`,
    'top',
  );

  sem(
    'always @(*) is the same as always @*',
    `module top(input [3:0] a, input [3:0] b, output reg [3:0] y);
  always @(*) y = a ^ b;
endmodule`,
    'top',
  );

  sem(
    'a complete explicit sensitivity list, with or and with commas',
    `module top(input [3:0] a, input [3:0] b, input c, output reg [3:0] y, output reg [3:0] z);
  always @(a or b or c) y = c ? a + b : a - b;
  always @(a, b, c) z = c ? a & b : a | b;
endmodule`,
    'top',
  );

  sem(
    'blocking assignments: later reads see earlier writes',
    `module top(input [3:0] a, output reg [3:0] y);
  reg [3:0] t;
  always @* begin
    t = a;
    t = t + 4'd1;
    t = t << 1;
    y = t;
  end
endmodule`,
    'top',
  );

  sem(
    'a read between two writes of the same reg sees the first write',
    `module top(input [3:0] a, input [3:0] b, output reg [3:0] x, output reg [3:0] y);
  always @* begin
    x = a;
    y = x + b;
    x = x ^ 4'hF;
  end
endmodule`,
    'top',
  );

  sem(
    'default assignment followed by a conditional override leaves no latch',
    `module top(input c, input d, input [3:0] a, output reg [3:0] y);
  always @* begin
    y = 4'd0;
    if (c) y = a;
    if (d) y = ~a;
  end
endmodule`,
    'top',
  );

  sem(
    'nonblocking assignments in a combinational block settle to the same value',
    `module top(input [3:0] a, input [3:0] b, output reg [3:0] y);
  always @* y <= a + b;
endmodule`,
    'top',
  );

  sem(
    'if, else if and else chains: the first true condition wins',
    `module top(input [3:0] a, output reg [1:0] y);
  always @* begin
    if (a == 4'd0) y = 2'd3;
    else if (a == 4'd1) y = 2'd2;
    else if (a[3]) y = 2'd1;
    else y = 2'd0;
  end
endmodule`,
    'top',
  );

  sem(
    'a local reg declared in a named block',
    `module top(input [3:0] a, input [3:0] b, output reg [3:0] y);
  always @* begin : blk
    reg [3:0] t;
    t = a + b;
    y = t ^ 4'hF;
  end
endmodule`,
    'top',
  );
});

describe('latches from incomplete assignment (IEEE 9.7)', () => {
  sem(
    'if without else holds the previous value while the enable is low',
    `module top(input en, input [3:0] d, output reg [3:0] q);
  always @* if (en) q = d;
endmodule`,
    'top',
  );

  sem(
    'latch with an active-low enable and an explicit sensitivity list',
    `module top(input en, input [3:0] d, output reg [3:0] q);
  always @(en or d) if (!en) q <= d;
endmodule`,
    'top',
  );

  sem(
    'a case without default holds the output for unlisted selectors',
    `module top(input [1:0] s, input [1:0] a, input [1:0] b, output reg [1:0] y);
  always @* begin
    case (s)
      2'd0: y = a;
      2'd1: y = b;
    endcase
  end
endmodule`,
    'top',
    { minKnown: 0.3 },
  );

  sem(
    'a latch beside a combinational output in the same block',
    `module top(input en, input [3:0] d, output reg [3:0] q, output reg [3:0] n);
  always @* begin
    n = ~d;
    if (en) q = d + 4'd1;
  end
endmodule`,
    'top',
  );
});

describe('blocking and nonblocking assignment (IEEE 9.2)', () => {
  sem(
    'nonblocking swap exchanges two registers',
    `module top(input clk, input load, input [2:0] ia, input [2:0] ib, output reg [2:0] a, output reg [2:0] b);
  always @(posedge clk) begin
    if (load) begin
      a <= ia;
      b <= ib;
    end else begin
      a <= b;
      b <= a;
    end
  end
endmodule`,
    'top',
  );

  sem(
    'blocking "swap" copies one value into both registers',
    `module top(input clk, input load, input [2:0] ia, input [2:0] ib, output reg [2:0] a, output reg [2:0] b);
  always @(posedge clk) begin
    if (load) begin
      a = ia;
      b = ib;
    end else begin
      a = b;
      b = a;
    end
  end
endmodule`,
    'top',
  );

  sem(
    'a blocking temporary inside a clocked block',
    `module top(input clk, input [3:0] a, input [3:0] b, input [3:0] c, output reg [3:0] q);
  reg [3:0] t;
  always @(posedge clk) begin
    t = a + b;
    q <= t ^ c;
  end
endmodule`,
    'top',
  );

  sem(
    'blocking assignment to a register read by a later nonblocking one in the same block',
    `module top(input clk, input [3:0] a, output reg [3:0] q, output reg [3:0] r);
  reg [3:0] t;
  always @(posedge clk) begin
    t = a;
    q <= t;
    t = t + 4'd1;
    r <= t;
  end
endmodule`,
    'top',
  );
});

describe('case, casez and casex (IEEE 9.5)', () => {
  sem(
    'case with several labels per item and a default',
    `module top(input [3:0] a, output reg [1:0] y);
  always @* begin
    case (a)
      4'b0000: y = 2'd0;
      4'b0001, 4'b0010: y = 2'd1;
      4'b1111: y = 2'd2;
      default: y = 2'd3;
    endcase
  end
endmodule`,
    'top',
  );

  sem(
    'case labels narrower than the expression are zero-extended',
    `module top(input [3:0] a, output reg [1:0] y);
  always @* begin
    case (a)
      2'b11: y = 2'd1;
      2'b00: y = 2'd2;
      default: y = 2'd0;
    endcase
  end
endmodule`,
    'top',
  );

  sem(
    'casez treats ? and z as wildcards',
    `module top(input [3:0] a, output reg [1:0] y);
  always @* begin
    casez (a)
      4'b1???: y = 2'd3;
      4'b01??: y = 2'd2;
      4'b001z: y = 2'd1;
      default: y = 2'd0;
    endcase
  end
endmodule`,
    'top',
  );

  sem(
    'casex treats x, z and ? as wildcards',
    `module top(input [3:0] a, output reg [1:0] y);
  always @* begin
    casex (a)
      4'b1x0x: y = 2'd3;
      4'b01zz: y = 2'd2;
      4'b0010: y = 2'd1;
      default: y = 2'd0;
    endcase
  end
endmodule`,
    'top',
  );

  sem(
    'casez with an x in a pattern: x is not a wildcard in casez, so that item never matches a known input',
    `module top(input [3:0] a, output reg [1:0] y);
  always @* begin
    casez (a)
      4'b1?x0: y = 2'd1;
      4'b1???: y = 2'd2;
      4'b0??1: y = 2'd3;
      default: y = 2'd0;
    endcase
  end
endmodule`,
    'top',
  );

  sem(
    'the first matching item wins when casez items overlap',
    `module top(input [3:0] a, output reg [1:0] y);
  always @* begin
    casez (a)
      4'b????: y = 2'd0;
      4'b1???: y = 2'd1;
      default: y = 2'd2;
    endcase
  end
endmodule`,
    'top',
  );

  sem(
    'case (1\'b1) with expression items is a priority encoder',
    `module top(input [3:0] a, output reg [2:0] y);
  always @* begin
    case (1'b1)
      a[0]: y = 3'd1;
      a[1]: y = 3'd2;
      a[2]: y = 3'd3;
      a[3]: y = 3'd4;
      default: y = 3'd0;
    endcase
  end
endmodule`,
    'top',
  );

  sem(
    'overlapping constant items in a plain case: the first listed wins',
    `module top(input [2:0] a, output reg [1:0] y);
  always @* begin
    case (a)
      3'd2: y = 2'd1;
      3'd2, 3'd3: y = 2'd2;
      3'd3: y = 2'd3;
      default: y = 2'd0;
    endcase
  end
endmodule`,
    'top',
  );

  sem(
    'a case inside a clocked block with a registered decode',
    `module top(input clk, input [1:0] s, input [3:0] a, output reg [3:0] q);
  always @(posedge clk) begin
    case (s)
      2'd0: q <= a;
      2'd1: q <= ~a;
      2'd2: q <= a + 4'd1;
      default: q <= 4'd0;
    endcase
  end
endmodule`,
    'top',
  );
});

describe('loops with constant bounds (IEEE 9.6)', () => {
  sem(
    'a for loop popcount',
    `module top(input [7:0] a, output reg [3:0] cnt);
  integer i;
  always @* begin
    cnt = 4'd0;
    for (i = 0; i < 8; i = i + 1) cnt = cnt + a[i];
  end
endmodule`,
    'top',
  );

  sem(
    'one integer loop variable reused by two always blocks',
    `module top(input [7:0] a, output reg [7:0] rev, output reg [3:0] pop);
  integer i;
  always @* begin
    for (i = 0; i < 8; i = i + 1) rev[i] = a[7 - i];
  end
  always @* begin
    pop = 4'd0;
    for (i = 0; i < 8; i = i + 1) pop = pop + a[i];
  end
endmodule`,
    'top',
  );

  sem(
    'loops that count down, step by two and use <=',
    `module top(input [7:0] a, output reg [7:0] down, output reg even_par, output reg [3:0] n);
  integer i;
  always @* begin
    for (i = 7; i >= 0; i = i - 1) down[7 - i] = a[i];
    even_par = 1'b0;
    for (i = 0; i < 8; i = i + 2) even_par = even_par ^ a[i];
    n = 4'd0;
    for (i = 1; i <= 4; i = i + 1) n = n + a[i];
  end
endmodule`,
    'top',
  );

  sem(
    'a priority encoder written as a loop with a found flag',
    `module top(input [7:0] a, output reg [2:0] idx, output reg found);
  integer i;
  always @* begin
    idx = 3'd0;
    found = 1'b0;
    for (i = 0; i < 8; i = i + 1) begin
      if (a[i] && !found) begin
        idx = i;
        found = 1'b1;
      end
    end
  end
endmodule`,
    'top',
  );

  sem(
    'a loop that selects among words with a computed index',
    `module top(input [15:0] a, input [1:0] s, output reg [3:0] y);
  integer i;
  always @* begin
    y = 4'd0;
    for (i = 0; i < 4; i = i + 1) if (s == i) y = a[i * 4 +: 4];
  end
endmodule`,
    'top',
  );

  sem(
    'a loop with a nested if inside a clocked block',
    `module top(input clk, input [7:0] a, output reg [3:0] cnt);
  integer i;
  always @(posedge clk) begin
    cnt <= 4'd0;
    for (i = 0; i < 8; i = i + 1) if (a[i]) cnt <= cnt + 4'd1;
  end
endmodule`,
    'top',
  );
});

describe('assignment to parts of a vector and to concatenations (IEEE 9.2, 5.1.14)', () => {
  sem(
    'bit-select and part-select targets with constant bounds',
    `module top(input [1:0] a, input b, output reg [7:0] y);
  always @* begin
    y = 8'h00;
    y[3:2] = a;
    y[7] = b;
    y[0] = ~b;
    y[6:5] = {b, ~b};
  end
endmodule`,
    'top',
  );

  sem(
    'a bit-select target in an unrolled loop of nonblocking assignments',
    `module top(input clk, input [3:0] d, output reg [3:0] q);
  integer i;
  always @(posedge clk) begin
    for (i = 0; i < 4; i = i + 1) q[i] <= d[3 - i];
  end
endmodule`,
    'top',
  );

  sem(
    'a bit-select target with a variable index writes one bit',
    `module top(input [2:0] idx, input en, output reg [7:0] y);
  always @* begin
    y = 8'h00;
    y[idx] = en;
  end
endmodule`,
    'top',
  );

  sem(
    'an indexed part-select target with a variable base',
    `module top(input [1:0] idx, input [1:0] v, output reg [7:0] y);
  always @* begin
    y = 8'hFF;
    y[{idx, 1'b0} +: 2] = v;
  end
endmodule`,
    'top',
  );

  sem(
    '{c, s} = a + b on the left side of a blocking assignment',
    `module top(input [3:0] a, input [3:0] b, output reg c, output reg [3:0] s);
  always @* {c, s} = a + b;
endmodule`,
    'top',
  );

  sem(
    '{p, q} <= {q, p} swaps through a concatenation target',
    `module top(input clk, input load, input [1:0] ia, input [1:0] ib, output reg [1:0] p, output reg [1:0] q);
  always @(posedge clk) begin
    if (load) {p, q} <= {ia, ib};
    else {p, q} <= {q, p};
  end
endmodule`,
    'top',
  );

  sem(
    'a concatenation target with a part-select of a wider reg',
    `module top(input [3:0] a, output reg [5:0] y);
  always @* begin
    y = 6'b0;
    {y[5], y[3:2], y[0]} = {a[3], a[1:0], a[2]};
  end
endmodule`,
    'top',
  );
});

describe('tasks and functions without timing (IEEE 10)', () => {
  sem(
    'a task with output arguments and a task with an inout argument',
    `module top(input [3:0] a, input [3:0] b, output reg [4:0] s, output reg [3:0] d, output reg [3:0] y);
  reg [3:0] t;
  task addsub;
    input [3:0] x1;
    input [3:0] x2;
    output [4:0] sum;
    output [3:0] diff;
    begin
      sum = x1 + x2;
      diff = x1 - x2;
    end
  endtask
  task bump;
    inout [3:0] v;
    begin
      v = v + 4'd1;
    end
  endtask
  always @* begin
    addsub(a, b, s, d);
    t = a;
    bump(t);
    bump(t);
    y = t;
  end
endmodule`,
    'top',
  );

  sem(
    'a task with an ANSI header that writes a module-level reg',
    `module top(input [3:0] a, output reg [3:0] y, output reg [3:0] z);
  reg [3:0] acc;
  task step(input [3:0] v);
    acc = acc + v;
  endtask
  always @* begin
    acc = 4'd0;
    step(a);
    step(a);
    y = acc;
    step(4'd1);
    z = acc;
  end
endmodule`,
    'top',
  );

  sem(
    'an automatic task called from a clocked block',
    `module top(input clk, input [3:0] a, input [3:0] b, output reg [3:0] q);
  task automatic mix(input [3:0] x1, input [3:0] x2, output [3:0] r);
    r = (x1 & x2) | (x1 ^ x2);
  endtask
  reg [3:0] m;
  always @(posedge clk) begin
    mix(a, b, m);
    q <= m;
  end
endmodule`,
    'top',
  );

  sem(
    'functions in continuous assignments: old style, ANSI style, with a loop and nested calls',
    `module top(input [3:0] a, input [3:0] b, output [4:0] y1, output [3:0] y2, output [3:0] y3);
  function [4:0] add5;
    input [3:0] x;
    input [3:0] y;
    add5 = x + y;
  endfunction
  function [3:0] maxf(input [3:0] x, input [3:0] y);
    begin
      if (x > y) maxf = x;
      else maxf = y;
    end
  endfunction
  function [3:0] rev(input [3:0] x);
    integer i;
    begin
      for (i = 0; i < 4; i = i + 1) rev[i] = x[3 - i];
    end
  endfunction
  assign y1 = add5(a, b);
  assign y2 = maxf(a, b);
  assign y3 = rev(maxf(a, rev(b)));
endmodule`,
    'top',
  );

  sem(
    'an automatic function with local variables used in a combinational block',
    `module top(input [7:0] a, output reg [3:0] hi_pop, output reg [3:0] lo_pop);
  function automatic [3:0] popc(input [3:0] x);
    integer i;
    reg [3:0] n;
    begin
      n = 4'd0;
      for (i = 0; i < 4; i = i + 1) n = n + x[i];
      popc = n;
    end
  endfunction
  always @* begin
    hi_pop = popc(a[7:4]);
    lo_pop = popc(a[3:0]);
  end
endmodule`,
    'top',
  );

  sem(
    'a function with a case statement and a module parameter',
    `module top(input [1:0] s, input [3:0] a, output [3:0] y);
  parameter K = 3;
  function [3:0] sel(input [1:0] s, input [3:0] v);
    case (s)
      2'd0: sel = v;
      2'd1: sel = v + K;
      2'd2: sel = v << 1;
      default: sel = ~v;
    endcase
  endfunction
  assign y = sel(s, a);
endmodule`,
    'top',
  );

  sem(
    'a function called twice in one expression with different arguments',
    `module top(input [3:0] a, input [3:0] b, output [4:0] y);
  function [3:0] half(input [3:0] x);
    half = x >> 1;
  endfunction
  assign y = half(a) + half(b);
endmodule`,
    'top',
  );
});
