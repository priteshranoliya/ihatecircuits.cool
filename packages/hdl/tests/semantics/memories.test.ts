import { describe } from 'vitest';
import { sem } from './helpers';

describe('memories: asynchronous read (IEEE 3.8, 4.9)', () => {
  sem(
    'a write port with enable and an asynchronous read port',
    `module top(input clk, input we, input [1:0] wa, input [1:0] ra, input [7:0] wd, output [7:0] q);
  reg [7:0] mem [0:3];
  always @(posedge clk) if (we) mem[wa] <= wd;
  assign q = mem[ra];
endmodule`,
    'top',
    { cycles: 300 },
  );

  sem(
    'a dual-read register file whose register 0 reads as zero',
    `module top(input clk, input we, input [2:0] wa, input [7:0] wd, input [2:0] ra1, input [2:0] ra2, output [7:0] rd1, output [7:0] rd2);
  reg [7:0] rf [0:7];
  always @(posedge clk) if (we && wa != 3'd0) rf[wa] <= wd;
  assign rd1 = ra1 == 3'd0 ? 8'd0 : rf[ra1];
  assign rd2 = ra2 == 3'd0 ? 8'd0 : rf[ra2];
endmodule`,
    'top',
    { cycles: 400, ones: { we: 0.7 } },
  );

  sem(
    'two reads of one memory in one expression',
    `module top(input clk, input we, input [1:0] wa, input [3:0] wd, input [1:0] a, input [1:0] b, output [4:0] sum);
  reg [3:0] mem [0:3];
  always @(posedge clk) if (we) mem[wa] <= wd;
  assign sum = mem[a] + mem[b];
endmodule`,
    'top',
    { cycles: 400, ones: { we: 0.8 } },
  );

  sem(
    'a read inside a combinational always block',
    `module top(input clk, input we, input [1:0] wa, input [3:0] wd, input [1:0] a, output reg [3:0] y);
  reg [3:0] mem [0:3];
  always @(posedge clk) if (we) mem[wa] <= wd;
  always @* y = mem[a] ^ 4'hF;
endmodule`,
    'top',
    { cycles: 300, ones: { we: 0.7 } },
  );

  sem(
    'computed read addresses',
    `module top(input clk, input we, input [1:0] wa, input [3:0] wd, input [1:0] a, output [3:0] y1, output [3:0] y2);
  reg [3:0] mem [0:3];
  always @(posedge clk) if (we) mem[wa] <= wd;
  assign y1 = mem[a ^ 2'b01];
  assign y2 = mem[{a[0], a[1]}];
endmodule`,
    'top',
    { cycles: 300, ones: { we: 0.7 } },
  );

  sem(
    'address range [0:5]: an address beyond the last word reads x and a write there is ignored',
    `module top(input clk, input we, input [2:0] wa, input [3:0] wd, input [2:0] ra, output [3:0] q);
  reg [3:0] mem [0:5];
  always @(posedge clk) if (we) mem[wa] <= wd;
  assign q = mem[ra];
endmodule`,
    'top',
    { cycles: 400, ones: { we: 0.8 }, strict: true, minKnown: 0.4 },
  );

  sem(
    'a descending address range [3:0]',
    `module top(input clk, input we, input [1:0] wa, input [3:0] wd, input [1:0] ra, output [3:0] q);
  reg [3:0] mem [3:0];
  always @(posedge clk) if (we) mem[wa] <= wd;
  assign q = mem[ra];
endmodule`,
    'top',
    { cycles: 300, ones: { we: 0.7 } },
  );

  sem(
    'a memory whose first address is not zero, [4:7]',
    `module top(input clk, input we, input [2:0] wa, input [3:0] wd, input [2:0] ra, output [3:0] q);
  reg [3:0] mem [4:7];
  always @(posedge clk) if (we) mem[wa] <= wd;
  assign q = mem[ra];
endmodule`,
    'top',
    { cycles: 400, ones: { we: 0.8 }, strict: true, minKnown: 0.4 },
  );

  sem(
    'a memory of one bit words',
    `module top(input clk, input we, input [2:0] wa, input wd, input [2:0] ra, output q);
  reg mem [0:7];
  always @(posedge clk) if (we) mem[wa] <= wd;
  assign q = mem[ra];
endmodule`,
    'top',
    { cycles: 400, ones: { we: 0.8 } },
  );

  sem(
    'a memory inside a parameterised module instantiated at two sizes',
    `module ram #(parameter W = 8, parameter D = 4) (input clk, input we, input [$clog2(D)-1:0] a, input [W-1:0] d, output [W-1:0] q);
  reg [W-1:0] mem [0:D-1];
  always @(posedge clk) if (we) mem[a] <= d;
  assign q = mem[a];
endmodule
module top(input clk, input we, input [2:0] a, input [7:0] d, output [7:0] q8, output [3:0] q4);
  ram #(8, 8) u8 (clk, we, a, d, q8);
  ram #(4, 4) u4 (clk, we, a[1:0], d[3:0], q4);
endmodule`,
    'top',
    { cycles: 400, ones: { we: 0.8 } },
  );
});

describe('memories: synchronous read (IEEE 9.2.2)', () => {
  sem(
    'a synchronous read of the address being written returns the old data',
    `module top(input clk, input we, input [1:0] a, input [7:0] d, output reg [7:0] q);
  reg [7:0] mem [0:3];
  always @(posedge clk) begin
    if (we) mem[a] <= d;
    q <= mem[a];
  end
endmodule`,
    'top',
    { cycles: 400, ones: { we: 0.6 } },
  );

  sem(
    'a simple dual-port RAM with separate read and write addresses',
    `module top(input clk, input we, input [1:0] wa, input [1:0] ra, input [7:0] wd, output reg [7:0] rd);
  reg [7:0] mem [0:3];
  always @(posedge clk) begin
    if (we) mem[wa] <= wd;
    rd <= mem[ra];
  end
endmodule`,
    'top',
    { cycles: 400, ones: { we: 0.7 } },
  );

  sem(
    'a blocking write followed by a registered read in the same block returns the new data',
    `module top(input clk, input we, input [1:0] a, input [7:0] d, output reg [7:0] q);
  reg [7:0] mem [0:3];
  always @(posedge clk) begin
    if (we) mem[a] = d;
    q <= mem[a];
  end
endmodule`,
    'top',
    { cycles: 400, ones: { we: 0.6 } },
  );

  sem(
    'a reset loop clears every word',
    `module top(input clk, input rst, input we, input [1:0] wa, input [7:0] wd, input [1:0] ra, output [7:0] q);
  reg [7:0] mem [0:3];
  integer i;
  always @(posedge clk) begin
    if (rst) begin
      for (i = 0; i < 4; i = i + 1) mem[i] <= 8'd0;
    end else if (we) mem[wa] <= wd;
  end
  assign q = mem[ra];
endmodule`,
    'top',
    { cycles: 400, ones: { rst: 0.05, we: 0.7 }, prefix: [{ rst: '1', we: '0', wa: '00', wd: '00000000', ra: '00' }] },
  );
});

describe('memories: initial contents (IEEE 17.2.8)', () => {
  sem(
    '$readmemh loads words in order, skips comments and honours an @address directive',
    `module top(input [1:0] a, output [7:0] q);
  reg [7:0] mem [0:3];
  initial $readmemh("f.hex", mem);
  assign q = mem[a];
endmodule`,
    'top',
    { files: { 'f.hex': '11\n// a comment\n22\n@3\n44\n' }, minKnown: 0.5 },
  );

  sem(
    '$readmemb loads binary words with underscores',
    `module top(input [1:0] a, output [7:0] q);
  reg [7:0] mem [0:3];
  initial $readmemb("f.bin", mem);
  assign q = mem[a];
endmodule`,
    'top',
    { files: { 'f.bin': '0001_0010\n0011_0100\n0101_0110\n0111_1000\n' } },
  );

  sem(
    '$readmemh into a ROM read through a register',
    `module top(input clk, input [1:0] a, output reg [7:0] q);
  reg [7:0] rom [0:3];
  initial $readmemh("rom.hex", rom);
  always @(posedge clk) q <= rom[a];
endmodule`,
    'top',
    { files: { 'rom.hex': 'DE\nAD\nBE\nEF\n' } },
  );

  sem(
    'initial blocks assigning memory words one by one',
    `module top(input [1:0] a, output [7:0] q);
  reg [7:0] mem [0:3];
  initial begin
    mem[0] = 8'h11;
    mem[1] = 8'h22;
    mem[2] = 8'h33;
    mem[3] = 8'h44;
  end
  assign q = mem[a];
endmodule`,
    'top',
  );

  sem(
    'an initial loop fills a memory with a computed pattern',
    `module top(input [2:0] a, output [7:0] q);
  reg [7:0] mem [0:7];
  integer i;
  initial begin
    for (i = 0; i < 8; i = i + 1) mem[i] = i * 3 + 1;
  end
  assign q = mem[a];
endmodule`,
    'top',
  );

  sem(
    'a write port overrides initial contents',
    `module top(input clk, input we, input [1:0] wa, input [7:0] wd, input [1:0] ra, output [7:0] q);
  reg [7:0] mem [0:3];
  initial begin
    mem[0] = 8'hA0;
    mem[1] = 8'hA1;
    mem[2] = 8'hA2;
    mem[3] = 8'hA3;
  end
  always @(posedge clk) if (we) mem[wa] <= wd;
  assign q = mem[ra];
endmodule`,
    'top',
    { cycles: 300, ones: { we: 0.3 } },
  );
});
