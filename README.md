# iHateCircuits

A browser-based digital logic simulator for engineering students. Design, wire, simulate, analyse and export circuits — from single gates to multi-level hierarchical designs with buses, tri-state logic, transistors and memory — with no install, no account and no upload. Work is saved automatically in the browser and can be saved to and opened from `.json` project files.

## Run it

```sh
npm install
npm run dev        # development server (apps/web)
npm run build      # type-check and build the static site into apps/web/dist/
npm run preview    # serve the built site
npm run check      # type-check, unit tests, licence audit, browser tests
```

`apps/web/dist/` is a static site with relative paths; host it anywhere.

## Repository layout

This is an npm-workspaces monorepo. Every command above runs from the repository root.

| Path | Package | What it holds |
| --- | --- | --- |
| `packages/core` | `@ihatecircuits/core` | Circuit model, simulator, netlist, parts, analysis and synthesis. Pure TypeScript with no DOM, consumed as source (no build step) through its `exports` map, for example `@ihatecircuits/core/sim`. |
| `packages/hdl` | `@ihatecircuits/hdl` | Verilog-2005 compiler: preprocessor, parser, elaboration to a synthesis IR, and a 4-state IR interpreter. It must stay independent of the circuit core, and a boundary test enforces that. |
| `packages/hdl-bridge` | `@ihatecircuits/hdl-bridge` | Connects the compiler to the circuit core: lowers the IR to a project in a blocks view or a gates view, exports a project to Verilog, and prints the IR as Verilog. See its README for every cell and where hardware differs from the IR. |
| `apps/web` | `@ihatecircuits/web` | The browser app: UI, state store, exporters, Vite config, and the Playwright browser tests in `e2e/`. |
| `tools/` | | Repository tooling, currently the licence audit. |

`npm test` runs the unit tests of every workspace through one root Vitest config. `npm run typecheck` type-checks every workspace.

## What it does

**Parts (60+)**

| Family | Parts |
| --- | --- |
| Gates | AND, OR, NOT, buffer, NAND, NOR, XOR, XNOR, odd/even parity, tri-state buffer and inverter. 2–16 inputs, 1–32 bits wide, inverted inputs, open-drain / open-source outputs, per-part propagation delay. |
| Wiring | Pin (input/output port, 1–32 bits, tri-state option), probe, splitter (any bit mapping, bidirectional, zero delay), tunnel, junction, pull-up/pull-down resistor, power, ground, N- and P-type transistors, transmission gate, bit extender (zero/one/sign/input fill), not-connected marker. |
| Inputs | Switch, push button, DIP switch, clock (high/low duration, phase), constant, slider, keyboard (FIFO). |
| Outputs | LED (colours, active high/low), RGB LED, hex display, 7-segment display, LED bar, LED matrix, TTY terminal. |
| Multiplexers | Multiplexer, demultiplexer, decoder, priority encoder (cascadable), bit selector. |
| Arithmetic | Adder, subtractor, multiplier, divider, negator, comparator (signed/unsigned), shifter (logical, arithmetic, rotate), population count, bit finder, Gray-code converter. |
| Memory | D, T, JK and SR flip-flops (edge or level triggered, async set/clear), D and SR latches, register, counter (up/down, load, max value, four overflow modes), shift register (serial/parallel), random generator (seeded), RAM (separate or bidirectional bus, sync/async read), ROM. |
| Your circuits | Every circuit in the project can be placed inside another; its pins become the box's connections. |

**Simulation**
- Five values per bit: `0`, `1`, `x` (unknown), `Z` (floating) and conflict. Nets with several drivers resolve per bit following the strong-value part of the IEEE 1164 resolution table; pull resistors are weak drivers that only set bits nobody drives.
- Event-driven with per-part propagation delays (in gate delays), so hazards produce real glitches — and a glitch can clock a flip-flop, just as on a breadboard. Oscillation is detected and the parts involved are outlined.
- Switch-level CMOS: N-type transistors pass only strong 0s and P-types only strong 1s, so correct CMOS gates need complementary networks; a transmission gate passes both.
- Subcircuits are flattened into one netlist; each instance has its own state; recursion is refused.

**Analysis**
- Truth tables over every input bit (multi-bit inputs and outputs expand into bit columns, up to 12 input bits).
- Minimum sum-of-products and product-of-sums (Quine–McCluskey with an exact minimum cover), Σm/ΠM lists with don't-cares, Karnaugh maps (2–4 variables) with the chosen groups drawn, including groups that wrap around edges.
- Static-hazard detection with the consensus terms that remove each hazard.
- Build a circuit from Boolean expressions in several notations, as written or as minimal SOP/POS, optionally with 2-input gates only or NAND gates only.
- Test vectors: a plain-text table of inputs and expected outputs, run against the circuit, including clocked sequences.
- A timing diagram follows inputs, clocks, probes and outputs in simulated time.

**Interface:** a warm, low-distraction workspace with docked, resizable library and properties panels (hide either with `[` / `]`, or both with `\` for focus mode), a floating tool dock (select/wire, pan, note, add part, undo, rotate, delete), a ⌘K command palette, right-click menus with shortcuts, a breadcrumb that follows you into subcircuits, favourites and recent parts, and undo buttons on destructive toasts. Colours are design tokens in three layers (primitives → semantics → components); light and dark themes redefine only the semantic layer. The signal palette was chosen by search so every pair of states stays distinguishable (ΔE ≥ 25) for normal vision and for protanopia, deuteranopia and tritanopia, and each state also has its own line pattern.

**Editing:** drag or ⌘K to place parts; wire by dragging or clicking pin to pin; reroute wires; move, rotate, multi-select, copy, paste, duplicate; undo/redo across the whole project; zoom, pan, pinch; memory hex editor for RAM and ROM; light and dark themes; phone layout with drawers and touch wiring.

**Files:** JSON project files (version-1 single-circuit files still open), SVG, PNG and PDF diagram export.

## Architecture

```
packages/core/src/  Pure TypeScript, no DOM
  bits.ts            5-state multi-bit values, bitwise logic, net resolution
  library.ts         Component contract and registry
  parts/             Part families: gates, wiring, io, ioextra, plexers, arith, memory
  netlist.ts         Pins → pin-nets → bit-level nets (wires, tunnels, splitters, subcircuits)
  sim.ts             Event-driven simulator with per-part delays
  project.ts         Multi-circuit projects and subcircuit definitions
  edit.ts, geometry.ts, serialize.ts, examples.ts
  analysis.ts        Truth tables, Quine–McCluskey, K-map data
  expr.ts, synth.ts, hazards.ts, testvec.ts
apps/web/src/state/store.ts   Zustand store: project, history, simulator, timing signals
apps/web/src/ui/      React components; the canvas is SVG
apps/web/src/export/  SVG/PNG/PDF export (the PDF writer is written from the spec)
packages/core/tests/ Vitest: core, parts, examples, analysis
apps/web/tests/      Vitest: dialog helpers
apps/web/e2e/        Playwright: real UI on desktop and phone viewports
```

**Determinism.** Events are ordered by (time, sequence). All parts whose inputs changed at the same instant are evaluated in a fixed order against the values at that instant, and their outputs are committed together. Results never depend on the order parts were created, and edge-triggered parts sample their data as it was at the edge.

## Tests

`npm test` runs 320+ unit tests: every part family exhaustively at small widths and randomly at 8/16/32 bits against reference arithmetic, net resolution, tri-state contention, CMOS gates, hazards, splitters, subcircuits, every example (including a 3-level ripple-carry adder over all 256 input pairs), file round-trips, minimisation equivalence on hundreds of random functions, synthesis verified by simulation. `npm run test:e2e` runs the browser tests.

## Licensing and originality

iHateCircuits's code is MIT-licensed (see `LICENSE`). It is an independent implementation that takes functional inspiration from classic educational simulators such as Logisim and Logisim Evolution. It contains none of their source code, logos, artwork, icons, example files or documentation text. Part behaviour was specified in our own words and implemented from scratch. Part names are the standard technical terms of digital logic (splitter, tunnel, probe, priority encoder, transmission gate and so on), which many tools share. Gate symbols follow the public IEEE/ANSI distinctive-shape convention, drawn from scratch.

`npm run licenses` audits every installed package and fails if anything shipped uses a licence outside a permissive allow-list; the result is in `THIRD_PARTY_LICENSES.md`. Shipped dependencies: React and React DOM (MIT), Zustand (MIT), and the Geist and Geist Mono typefaces (SIL OFL 1.1). Development tools are not distributed; the only non-permissive one is `lightningcss` (MPL-2.0), a build-time CSS tool used unmodified.
