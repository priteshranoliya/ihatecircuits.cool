# hdl-fuzz

A differential fuzzer for the Verilog pipeline. It generates random synthesizable programs, runs each one in Icarus Verilog (the reference) and in our own pipeline, and compares the output traces cycle by cycle.

## Running it

Icarus must be on the `PATH` (`iverilog` and `vvp`). Without it the fuzz test skips.

```
npm run fuzz:hdl -- --n 300 --seed 8080
npm run fuzz:hdl -- --n 200 --seed 8181 --clocks --undriven
npm run fuzz:hdl -- --n 50 --seed 7 --size 6
```

Program `i` uses seed `seed + i`, so a run is reproducible and a failing seed can be rerun alone with `--n 1 --seed <seed>`.

| Option | Meaning |
| --- | --- |
| `--n N` | Number of programs. Default 100. |
| `--seed S` | First seed. Default 1. |
| `--size K` | Program size, 1 to 10. Scales module count, item count and expression depth. Default 3. |
| `--clocks`, `--undriven` | Generator features that are off by default. `--clocks` adds gated clocks (`always @(posedge g)`), `--undriven` adds declared wires that nothing drives. |
| `--no-unreset`, `--no-width-mismatch`, `--no-wide`, `--no-deep` | Turn off features that are on by default. |
| `--strict` | Compare exactly: a reference `x` must be matched by `x`. For targeted runs. |
| `--corpus DIR` | Where failing cases are written. Default `packages/hdl/tests/corpus`. |
| `--no-shrink` | Skip reducing a failing program to a small one. |
| `--max-failures K` | Stop starting new programs after K failing seeds. Default 5. Raise it to see every failure in a run. |
| `--concurrency K` | Programs in flight at once. Default 4. |
| `--self-test-only` | Run only the Icarus self-tests (no pipeline runners). |

A run prints one line per failure and a summary such as `300 programs (seeds 8080..8379, size 3), runners [...], 0 failing`.

## What is compared

Every program runs through these runners and each is compared with the reference trace.

- `iverilog-rerun` and `iverilog-passthrough-wrapper` are self-tests. They run Icarus twice, and Icarus on a semantically identical rewrite, to catch a flaky or mis-driven harness.
- `ihatecircuits` compiles the program, lowers it to a circuit and simulates it with the iHateCircuits engine (`runSimulator`).
- `ihatecircuits-export-iverilog` lowers to a circuit, exports it back to structural Verilog (`exportVerilog`) and runs that in Icarus. This checks what synthesis produced without our own simulator.

The default comparison treats a reference `x` as accepting any value, because our circuits can be more precise than Verilog's pessimism. Every other reference bit (`0`, `1`, `z`) must match exactly.

## Failures

A failing seed is shrunk and written to `<corpus>/<seed>.json` with the source, top module, clock, stimulus, both traces, the failing runner and the first mismatch. Reproduce one by running the runner on `source`, `top`, `clock` and `stimulus` from the file. The files in `packages/hdl/tests/corpus` are kept as regression inputs.

## Known reference quirks and known differences

These are expected mismatches. They are not bugs in the pipeline.

### Icarus keeps z through a bare `~` of an all-z vector

IEEE 1364-2005 gives `~z = x` (Table 5-14 and the bitwise operator tables). Icarus Verilog 13.0 prints `z` instead in one case.

```verilog
wire [3:0] u;            // never driven
assign o = ~u;           // Icarus: zzzz.  The standard, and iHateCircuits: xxxx
```

Experiments in Icarus 13.0, each run with `iverilog -g2005` and `vvp`:

| Expression | Icarus result |
| --- | --- |
| `~u`, `u` never driven | `zzzz` |
| `~zz`, `zz` driven with `4'bzzzz` | `zzzz` (the net does not have to be undriven) |
| `~(~u)` | `zzzz` |
| `~u` where `u` is `4'bzzz1` | `xxx0` |
| `~u & 4'hF`, `u ^ 4'h0`, `u \| 4'h0`, `u + 0`, `~(u \| u)`, `~(u & v)` | `xxxx` |
| `u ~^ 4'h0` | `xxxx` |
| `not g[3:0] (n, u)` (gate primitive), `u` never driven | `zzzz` (the same inverter) |
| `~w[3]`, bit 3 of `w` is z | `z` |
| `~w` where `w` is `4'bz10x` | `x01x`, as the standard says |
| `always @* p = ~u`, `initial p = ~u`, `always @(posedge clk) r <= ~u`, `u` never driven | `xxxx`, as the standard says |

The cause is the inverter Icarus generates for a continuous assignment or a `not` primitive, a `.functor NOT` in the `vvp` output. It returns z when its entire input vector is z. A vector that is only partly z inverts correctly, every other bitwise operator gives x on an all-z operand, and a `~` inside a procedural block gives x. No `iverilog` flag changes this (`-gstrict-ca-eval`, `-gstrict-expr-width` and `-g2001`/`-g2005`/`-g2012` were tried). It is not a collapse of the inverter onto the undriven net: an explicit `4'bzzzz` driver behaves the same.

iHateCircuits answers `x`, which is the standard's answer. The tests in `packages/hdl-bridge/tests/regressions.test.ts` pin both sides.

Two consequences in the fuzzer:

- **A combinational `~u`** shows up as `reference z vs ours x` (corpus `9192.json` is one). The reference is the one that is off.
- **A registered `r <= ~u`** gives the reference `xxxx` (a procedural `~` is correct) and iHateCircuits `xxxx`, but the exported circuit run in Icarus gives `zzzz`. The export hoists the `~` into an `assign`, which meets the same Icarus behaviour, and the register then loads that z. The exported text is correct Verilog; only its simulation in Icarus differs. The comparison does not flag it because a reference `x` accepts any value.

The export keeps plain `~`. Rewriting every inverter as `in ^ 4'hF` would hide the quirk in Icarus but make every exported circuit harder to read.

### Other known differences

- **A register that loads an undriven wire.** Verilog keeps the z. iHateCircuits loads x. The fuzzer reports `reference z vs ours x`.
- **An undriven wire widened by an extender.** iHateCircuits's zero-extension turns the floating bits into x where Verilog keeps z.
- **Power-on values.** Library registers start at 0 where a Verilog `reg` starts as x. `runSimulator` sets registers to x before the first cycle to match, but the exported circuit does not.

## Fuzzing the IR back ends (`fuzz:ir`)

`npm run fuzz:ir -- --n 1000 --seed 1` generates random IR designs (not Verilog) and compares every back end with Icarus.

```
npm run fuzz:ir -- --n 1000 --seed 1
npm run fuzz:ir -- --n 400 --seed 5000 --size 8
npm run fuzz:ir -- --n 1 --seed 240 --max-failures 1
```

| Option | Meaning |
| --- | --- |
| `--n N` | Number of designs. Default 100. |
| `--seed S` | First seed. Design `i` uses seed `S + i`. Default 1. |
| `--size K` | 1 to 10. Scales module count and cells per module. Default 3. |
| `--corpus DIR` | Where failing designs are written as `<seed>.json`. Default `tools/hdl-fuzz/corpus-ir`. |
| `--max-failures K`, `--concurrency K` | As for `fuzz:hdl`. |

The reference is Icarus running `designToVerilog(design)`, the IR printed as behavioural Verilog. Each design is also run through

- `interp`, the reference interpreter (`packages/hdl/src/interp.ts`), held to exact equality;
- `ihatecircuits-blocks` and `ihatecircuits-gates`, the lowered circuit in each view, simulated by the iHateCircuits engine (`runDesignOnSimulator`);
- `export-blocks-iverilog` and `export-gates-iverilog`, each lowered circuit exported to structural Verilog and run in Icarus.

A reference `x` accepts any value, as in `fuzz:hdl`. The summary line reads `ir-fuzz: 1000 designs (seeds 1..1000, size 3), reference iverilog-ir, runners [...], 0 failing, ...`.

`src/irgen.ts` builds designs that use every cell kind, several modules and instances, `wire`, `pull0`, `pull1`, `wand`, `wor` and `supply` nets with tri-state drivers, memories with up to two write and two read ports (asynchronous and synchronous, with initial contents), `adff` and `latch`. It is valid by construction (one ordinary driver per net, loops only through a flip-flop or a memory write port) and keeps anything that decides *when* something happens out of reach of unknown values and glitches; the comments at the top of the file say how, and `packages/hdl-bridge/README.md` says why. `src/irprint.ts` prints a design compactly for reading a failing case.

`tests/ir-cells.test.ts` runs every cell exhaustively at 1 to 4 bits (x and z inputs included up to 3 bits) through the interpreter and Icarus, and through every back end. `tests/ir-seq.test.ts` does the same for registers, latches, tri-state nets, memories and values up to 32 bits.

Two Icarus behaviours the printer works around, both listed in `packages/hdl-bridge/src/irVerilog.ts`: it passes z through shifts, slices and concatenations where the IR reads z as x, and it counts the clock going from x to 0 at power-on as a falling edge.

## Layout

- `src/gen.ts`, `src/ast.ts`, `src/analysis.ts` generate programs and keep them free of simulation-only differences.
- `src/irgen.ts`, `src/irbuild.ts`, `src/irfuzz.ts`, `src/ir-runners.ts`, `src/irprint.ts` and `run-ir/` are the IR-level fuzzer.
- `src/iverilog.ts` runs the reference; `src/extra-runners.ts` defines the pipeline runners.
- `src/compare.ts` compares traces; `src/shrink.ts` reduces failures.
- `run/fuzz.fuzz.ts` is the Vitest entry that `npm run fuzz:hdl` drives.
- `perf/` holds timing and profiling scripts for the simulator, run through `vitest.perf.config.ts`. See `perf/README.md`.
