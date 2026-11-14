/**
 * Short Verilog examples for the picker. Each one compiles without errors and lowers in both views
 * (examples.test.ts checks that), so a student can press Build on any of them straight away.
 */

export interface VerilogExample {
  id: string;
  title: string;
  /** One line shown under the title in the picker. */
  summary: string;
  source: string;
}

export const VERILOG_EXAMPLES: readonly VerilogExample[] = [
  {
    id: 'adders',
    title: 'Half and full adder',
    summary: 'Two small modules, one built from the other.',
    source: `// A half adder adds two bits: the sum is XOR, the carry is AND.
module half_adder (
  input  a,
  input  b,
  output sum,
  output carry
);
  assign sum   = a ^ b;
  assign carry = a & b;
endmodule

// A full adder also takes a carry in. It is two half adders and an OR gate.
// Build makes one circuit per module, and the full adder uses the half adder.
module full_adder (
  input  a,
  input  b,
  input  cin,
  output sum,
  output cout
);
  wire s1, c1, c2;
  half_adder first  (.a(a),  .b(b),   .sum(s1),  .carry(c1));
  half_adder second (.a(s1), .b(cin), .sum(sum), .carry(c2));
  assign cout = c1 | c2;
endmodule
`,
  },
  {
    id: 'mux',
    title: 'Parameterised 4-to-1 mux',
    summary: 'A parameter sets the width of the data inputs.',
    source: `// A 4-to-1 multiplexer. W is the width of each data input.
// Change the 4 to another number and the whole module follows.
module mux4 #(
  parameter W = 4
) (
  input      [W-1:0] d0,
  input      [W-1:0] d1,
  input      [W-1:0] d2,
  input      [W-1:0] d3,
  input      [1:0]   sel,
  output reg [W-1:0] y
);
  // always @* re-runs whenever any input changes: combinational logic.
  always @* begin
    case (sel)
      2'd0:    y = d0;
      2'd1:    y = d1;
      2'd2:    y = d2;
      default: y = d3;
    endcase
  end
endmodule
`,
  },
  {
    id: 'counter',
    title: '4-bit counter, async reset',
    summary: 'Counts up on each clock edge. Reset clears it at once.',
    source: `// A 4-bit up counter. The reset is asynchronous: when rst_n goes low
// the count clears straight away, without waiting for a clock edge.
module counter4 (
  input            clk,
  input            rst_n,   // active low
  input            enable,
  output reg [3:0] count
);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      count <= 4'd0;
    else if (enable)
      count <= count + 4'd1;   // wraps from 15 back to 0
  end
endmodule
`,
  },
  {
    id: 'alu',
    title: '4-bit ALU',
    summary: 'Eight operations picked by a case statement.',
    source: `// A small arithmetic logic unit. "op" picks the operation.
module alu4 (
  input      [3:0] a,
  input      [3:0] b,
  input      [2:0] op,
  output reg [3:0] y,
  output           zero      // 1 when the result is 0
);
  always @* begin
    case (op)
      3'd0:    y = a + b;                 // add
      3'd1:    y = a - b;                 // subtract
      3'd2:    y = a & b;                 // AND
      3'd3:    y = a | b;                 // OR
      3'd4:    y = a ^ b;                 // XOR
      3'd5:    y = ~a;                    // NOT a
      3'd6:    y = (a < b) ? 4'd1 : 4'd0; // set if a is less than b
      default: y = a << 1;                // shift left by one
    endcase
  end

  assign zero = (y == 4'd0);
endmodule
`,
  },
  {
    id: 'shift',
    title: 'Shift register',
    summary: 'Takes one bit per clock and shows the last eight.',
    source: `// An 8-bit shift register. On each clock edge with "shift" high,
// every bit moves one place left and "din" enters at the right.
module shift8 (
  input            clk,
  input            rst_n,
  input            shift,
  input            din,
  output reg [7:0] q
);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      q <= 8'd0;
    else if (shift)
      q <= {q[6:0], din};   // drop the top bit, add din at the bottom
  end
endmodule
`,
  },
  {
    id: 'traffic',
    title: 'Traffic light controller',
    summary: 'A finite state machine: green, yellow, red.',
    source: `// A traffic light as a finite state machine. Every time "tick" pulses
// the light moves to the next colour: green, yellow, red, green...
module traffic_light (
  input  clk,
  input  rst_n,
  input  tick,
  output green,
  output yellow,
  output red
);
  // Names for the three states, so the code reads like the design.
  localparam GREEN = 2'd0, YELLOW = 2'd1, RED = 2'd2;

  reg [1:0] state, next;

  // State register: the only part that remembers anything.
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) state <= RED;
    else        state <= next;
  end

  // Next-state logic: pure combinational.
  always @* begin
    next = state;
    if (tick) begin
      case (state)
        GREEN:   next = YELLOW;
        YELLOW:  next = RED;
        default: next = GREEN;
      endcase
    end
  end

  // Outputs depend only on the state (a Moore machine).
  assign green  = (state == GREEN);
  assign yellow = (state == YELLOW);
  assign red    = (state == RED);
endmodule
`,
  },
  {
    id: 'rom',
    title: 'Seven-segment decoder (ROM)',
    summary: 'A lookup table from a digit to its segments.',
    source: `// A read-only memory written as a lookup table. The input is a digit
// 0 to 9 and the output says which of the seven segments a to g to light.
// Bit 6 is segment a and bit 0 is segment g.
module seg7 (
  input      [3:0] digit,
  output reg [6:0] segments
);
  always @* begin
    case (digit)
      4'd0:    segments = 7'b1111110;
      4'd1:    segments = 7'b0110000;
      4'd2:    segments = 7'b1101101;
      4'd3:    segments = 7'b1111001;
      4'd4:    segments = 7'b0110011;
      4'd5:    segments = 7'b1011011;
      4'd6:    segments = 7'b1011111;
      4'd7:    segments = 7'b1110000;
      4'd8:    segments = 7'b1111111;
      4'd9:    segments = 7'b1111011;
      default: segments = 7'b0000000;   // not a digit: all off
    endcase
  end
endmodule
`,
  },
  {
    id: 'ram',
    title: 'Small RAM',
    summary: 'Sixteen words of four bits, with a write enable.',
    source: `// A small RAM: 16 words, each 4 bits wide.
// Writing happens on the clock edge. Reading is immediate.
module ram16x4 (
  input        clk,
  input        we,         // write enable
  input  [3:0] addr,
  input  [3:0] din,
  output [3:0] dout
);
  reg [3:0] mem [0:15];

  always @(posedge clk) begin
    if (we) mem[addr] <= din;
  end

  assign dout = mem[addr];
endmodule
`,
  },
];

export const DEFAULT_EXAMPLE = VERILOG_EXAMPLES[0]!;
