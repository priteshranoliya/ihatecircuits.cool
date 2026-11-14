// annex: A.1.3 module-declaration; A.2.4 variable-type; A.2.4 dimension; A.6.9 system-task-enable; A.6.2 initial-construct; A.6.2 always-construct; A.6.2 nonblocking-assignment
// iverilog: ok
module ram #(parameter AW = 8, parameter DW = 8, parameter INIT = "ram.hex") (
    input clk, we,
    input [AW-1:0] addr,
    input [DW-1:0] din,
    output reg [DW-1:0] dout
);
    reg [DW-1:0] mem [0:(1 << AW) - 1];
    integer i;
    initial begin
        for (i = 0; i < (1 << AW); i = i + 1)
            mem[i] = {DW{1'b0}};
        $readmemh(INIT, mem);
    end
    always @(posedge clk) begin
        if (we) mem[addr] <= din;
        dout <= mem[addr];
    end
endmodule

module rom16 (input [3:0] a, output [7:0] d);
    reg [7:0] rom [0:15];
    initial $readmemb("rom.bin", rom, 0, 15);
    assign d = rom[a];
endmodule

module dpram (
    input clka, clkb, wea,
    input [3:0] addra, addrb,
    input [7:0] dina,
    output reg [7:0] douta, doutb
);
    reg [7:0] store [0:15];
    always @(posedge clka) begin
        if (wea) store[addra] <= dina;
        douta <= store[addra];
    end
    always @(posedge clkb) doutb <= store[addrb];
endmodule
