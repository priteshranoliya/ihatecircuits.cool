# perf

Timing and profiling scripts for the simulator and the Verilog pipeline. None of them run in `npm test`.

```
npx vitest run --config tools/hdl-fuzz/vitest.perf.config.ts chain        # a+a+... chain, PERF_CHAIN=100,1000,10000
npx vitest run --config tools/hdl-fuzz/vitest.perf.config.ts mul16        # settle time of a gates-view multiplier and divider, PERF_MUL=16|32 PERF_VIEW=gates,blocks PERF_STEPS=200
npx vitest run --config tools/hdl-fuzz/vitest.perf.config.ts make-golden  # regenerate packages/hdl-bridge/tests/golden/fuzz-projects.json.gz
```

To profile, bundle a `*-main.ts` and run the bundle under Node, since Vitest workers do not write CPU profiles:

```
npx rolldown tools/hdl-fuzz/perf/chain-main.ts -f esm -p node -o /tmp/chain.mjs
PERF_CHAIN=2000 node --cpu-prof --cpu-prof-dir=/tmp/prof /tmp/chain.mjs
```

`fuzz-main.ts` times `runSimulator` on generated programs (`PERF_N`, `PERF_SIZE`, `PERF_SEED`).
`chain-main.ts` times compile, lowering and simulation of an N-term `a+a+...` chain (`PERF_CHAIN`, `PERF_CYCLES=2` for two stimulus cycles).

The chain is slow by construction. Every adder is one gate delay, so a change on `a` reaches adder k after k steps and adder k outputs a new value at each of the k steps before it. An N-term chain therefore processes about N^2/2 events (50 million for N = 10000), however fast each event is.
