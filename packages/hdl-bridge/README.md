# @ihatecircuits/hdl-bridge

Connects the HDL compiler (`@ihatecircuits/hdl`) to the circuit core (`@ihatecircuits/core`).

| File | What it does |
| --- | --- |
| `src/lower.ts` | IR `Design` to an iHateCircuits `Project`, in a blocks view or a gates view. |
| `src/blocks.ts`, `src/gates.ts`, `src/memory.ts`, `src/gb.ts` | The cell constructions behind the two views. |
| `src/layout.ts` | Layered placement: columns by logic depth, no two parts overlap, everything on the 10 px grid. |
| `src/export.ts` | Project back to structural Verilog (a fourth way to check a lowering). |
| `src/irVerilog.ts` | `designToVerilog(design)`: the IR printed as behavioural Verilog, so a reference simulator can evaluate the IR itself. |
| `src/run.ts` | `runSimulator` (Verilog source) and `runDesignOnSimulator` (an IR design, either view) as cycle-trace runners. |

The reference for what the IR means is the interpreter in `packages/hdl/src/interp.ts`, and `design.ts` next to it. `tools/hdl-fuzz` checks the interpreter, both lowerings and both exports against Icarus Verilog on the printed IR (`npm run fuzz:ir`).

## The two views

`lowerToProject(design, { view })` takes `'blocks'` (the default) or `'gates'`. Each module becomes a circuit, the top becomes `main`, and an instance becomes a `sub:` part.

**Blocks.** One library part per word-level cell, with guard logic around the part where its edge cases differ from the IR. This is the view for reading what a design computes.

**Gates.** Only and, or, not, xor, mux, single-bit flip-flops and latches, tri-state buffers, pull resistors and wiring. A word-level cell becomes a circuit of its own (`add8`, `mul16`, ...), shared by every module, so the canvas stays readable and a student can open `add8` and see eight `fa` boxes, and open `fa` and see the gates.

### Every cell, in both views

| IR cell | Blocks view | Gates view |
| --- | --- | --- |
| `const` | A `const` part at every reader. A literal with an x or z bit is refused (see below). | Same. |
| `not` `and` `or` `xor` `xnor` | The gate part, `bits` wide. | Same. |
| `mux` | `mux`, 2 inputs, `bits` wide. | Same. |
| `concat` `slice` | `splitter` (fan-in or fan-out) and `extender` (narrowing, zero extension). | Same. |
| `eq` `ne` | `xor` over the operands, a `splitter` into bits, an `or` (`nor` for `eq`) tree. One bit: `xnor`/`xor`. | Same. |
| `reduce_and` `reduce_or` `reduce_xor` | `splitter` into bits, then a tree of `and`/`or`/`xor` gates of at most 16 inputs. | Same. |
| `add` | `adder`, carry-in unconnected. | `add{N}`: a ripple of `fa` (the first bit is a half adder). |
| `sub` | `subtractor`, borrow-in unconnected. | `sub{N}`: `a + ~b + 1` through `fa`. |
| `mul` | `multiplier`, output `P` (the low half is the same for signed and unsigned operands). | `mul{N}`: array multiplier, `and` for each partial product, `fa` rows, only the low N bits kept. |
| `divu` `remu` | `divider`, output `Q` or `R`, `Hi` unconnected. | `divu{N}`: restoring divider, N steps of an (N+1)-bit `fa` subtraction and N 1-bit `mux`. |
| `divs` `rems` | Two `negator`+`mux` pairs take the magnitudes, an unsigned `divider` divides, then a `negator`+`mux` fixes the sign (quotient: `xor` of the signs; remainder: the dividend's sign). | `divs{N}`: the same shape, built from `neg{N}`, `divu{N}` and `mux`. |
| `shl` `shr` `sshr` | `shifter` in SLL, SRL or SRA mode. Its amount pin is `indexBits(N)` wide: a narrower amount goes through an `extender`; a wider one goes through a `splitter`, and an `or` of the high bits selects the fill (zeros, or the sign bit through an `extender`) with a `mux`. | `shl{N}_{W}` / `shr` / `sshr`: a barrel shifter, one stage of 1-bit `mux` per amount bit below log2 N, plus the fill guard for higher amount bits. |
| `ltu` `lts` | `comparator`, unsigned or signed, output `<`. | `ltu{N}` / `lts{N}`: a ripple of `mux` (`lts` flips both sign bits). |
| `dff` | `register` (rising or falling edge); its `init` becomes the part's power-on value. | One `dff` part per bit, each with its bit of `init`. |
| `adff` | Reset value 0: `register` with `CLR` from `arst` (a `not` first when the level is 0). Any other value: one `dff` per bit, `SET` for the bits that reset to 1 and `CLR` for those that reset to 0. | The per-bit form always. |
| `latch` | One `dlatch` per bit; a `not` on the enable when the level is 0. | Same. |
| `tribuf` | `tribuf`. | Same. |
| `memory` | A `rom` part per read port when there are no write ports; a `ram` part when one write port and one asynchronous read port share the address net and there are no initial contents; otherwise a `register` per word, an `and` decoder per write port, and a `mux` tree per read port (a `register` after it for a synchronous read). | A `dff` and a `mux` (the enable feeds `q` back) per bit, `and` decoders, `mux` trees. A ROM is constants under a `mux` tree. |
| `instance` | A `sub:` part. | Same. |
| Net `kind` | See below. | Same. |

## Where hardware and the IR differ, and what is done about it

A circuit has no x. Where the IR says x, the circuit gives some definite value, and the trace comparison accepts that because a reference x stands for any value (the comparator takes anything where the reference has x). This is the same policy as the `if` on an unknown condition in `design.ts`. In each case below the circuit is at least as precise as the IR on x inputs, except where it says otherwise.

- **There is no x source.** A `const` cell with an x or z bit is refused with a `LowerError`. The only unknown values a circuit can have are a floating net (a junction nothing drives, which reads z, and a gate reads z as x), a register before its first clock, and the results of the cases below. A net that is read but never driven gets that junction.
- **Division by zero.** The library divider answers all ones (quotient) and the dividend (remainder), the RISC-V convention, and the gates view's restoring divider gives the same answer. The IR says x. For `divs` and `rems` the answer goes through the sign fix-up, so it is some definite value. Nothing relies on it.
- **Unknown inputs to `add`, `sub`, `mul` and the dividers.** The IR gives all x on any unknown input bit. The library adder and subtractor, and the ripple circuits, keep result bits below the first unknown bit known, which is more precise. The multiplier and divider give all x, as the IR does.
- **Shift amounts.** The library shifter's amount pin has only `indexBits(N)` bits, so a wider amount needs the guard in the table. A shift by N or more gives all fill, as the IR says.
- **Memories.** Words nothing wrote and no initial contents gave read 0 where the IR reads x. An address past the depth reads 0 in the ROM part and aliases in the RAM part, where the IR reads x. A write whose address has an unknown bit poisons every word it might hit, where the IR writes nothing, because decoding an unknown address in hardware cannot tell it from a known one; a write with an unknown enable is a merge in both. A RAM part has one address pin and returns the new word on a clocked read, so it is used only where those differences cannot show. All write ports of one memory must share a clock and an edge, or the lowering stops with a `LowerError`.
- **Initial contents of a writable memory.** Each word with initial contents is a register whose `init` property is that word (the same mechanism as a `reg q = 4'd5;`, see Power-on). A word with no initial contents has no `init`.
- **Several drivers on a net.** Drivers meet at a junction and the simulator resolves them: z yields, equal values agree, different values give a conflict, reported as x. `pull0`/`pull1` add a pull resistor. `supply0`/`supply1` are constants. The library has no wired-AND or wired-OR net, so for `wand`/`wor` each tri-state buffer contributes its data while enabled and the identity (1 or 0) while not, a gate combines them, and one `tribuf`, enabled when any driver is, drives the net. With every driver off the net floats, as in Verilog; another, ordinary driver on the net counts as always on.
- **Latches and asynchronous resets are level sensitive.** An unknown latch enable merges the held value with `d`, and an unknown reset merges the reset value with the held one, bit by bit. Verilog's `if` would take its else branch, which agrees once the signal is known.
- **A glitch is a real thing in a circuit.** Gates have delay, so an asynchronous reset or a latch enable that comes from two inputs changing together can pulse briefly, and the flip-flop clears or the latch opens. The interpreter has no delay and never shows it. The IR generator in `tools/hdl-fuzz` keeps such signals to one-path logic (an input bit, a constant, wiring and inversion of those) and keeps a latch's data independent of the inputs, so that the comparison tests the lowering and not the timing of a hazard.
- **Power-on.** Library registers, flip-flops and latches start at 0 where Verilog starts at x. `runDesignOnSimulator` and `runSimulator` set them to x before the first cycle. The exception is a part with an `init` property: the IR's `init` on a `dff`, `adff` or `latch` (`reg q = 4'd5;`, `reg [3:0] q = 0;`, `initial q = 5;`) and a memory word's initial contents. `init` is bits over 0, 1 and x, most significant first, and a part with one powers on at that value (an x bit powers on unknown). The runner leaves such parts alone, a reset of the simulation restores them, and the exporter declares them `reg q = 4'b0101;`. There is one mechanism for all of it. One difference remains: a circuit's register is cleared by an asynchronous reset that is active at power-on (every input is 0 then), where the interpreter keeps `init` until the first clock edge, so `init` and an asynchronous reset that is active at power-on should not disagree.
- **z passes through wiring.** A `concat` and a `slice` are wiring, so a floating bit stays z through them (`assign o = w;` on a floating `w` gives z at `o`, widened or cut). The splitter always did this; the bit extender used to read its input like a gate does, which turned z into x, and now reads it raw. A register, a gate, a mux or any operator still reads z as x, so `s ? a : b` with a floating chosen arm gives x where Verilog passes z, and a register that loads a floating net holds x where Verilog keeps z.
- **Clocks.** A flip-flop ignores its clock until it has had a known level; a Verilog simulator counts the clock going from x to 0 as a falling edge at time 0. `designToVerilog` and `exportVerilog` hold falling-edge blocks back until time 1 for that reason.

## Export

`exportVerilog` handles every part the two views use: the gate parts, `adder`, `subtractor`, `multiplier`, `divider` (without `Hi`), `negator`, `comparator`, `shifter` (shifts, not rotates), `mux`, `splitter`, `extender`, `junction`, `pull`, `tribuf`, `register` (with `CLR` and `EN`), `dff` (with `SET` and `CLR`), `dlatch`, `rom`, `ram` and subcircuits. `CLR` and `SET` are written level sensitive (`assign q = clr ? 0 : state`), so a reset that is active from time 0 reads right. A divider exports as `/` and `%`, so a division by zero is x in the exported text where the part gives all ones.

## Timing

`npx vitest run --config tools/hdl-fuzz/vitest.perf.config.ts mul16` lowers and settles a combinational multiplier (`PERF_MUL=32`, `PERF_VIEW=gates`, `PERF_STEPS=200`). On a quiet laptop a 16-bit multiplier in the gates view (1,331 parts once subcircuits are flattened) settles in about 0.9 ms per input change (mean over 300 random inputs, p95 1.5 ms); a 32-bit one (5,715 parts) takes about 8.5 ms.

`npx vitest run --config tools/hdl-fuzz/vitest.perf.config.ts layout` lowers synthetic circuits of 1,500 and 5,000 cells (a constant at every pin, one wide column, mixed logic) in both views and fails above 2 s and 10 s. Placement is linear: a constant takes the nearest free slot in its column by binary search over the parts already placed there. Before that, each constant rescanned its whole column, so a 1,500-cell circuit with a literal at every pin took 17 s.
