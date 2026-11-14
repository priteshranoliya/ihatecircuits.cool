#!/usr/bin/env node
/**
 * `npm run fuzz:ir -- --n 1000 --seed 1 [--size 1..10] [--corpus DIR] [--concurrency K] [--max-failures K]`
 * Differential fuzzer for the IR back ends. Random IR designs run in Icarus (the IR printed as Verilog),
 * in the IR interpreter and in both lowered circuits, directly and exported to Verilog.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FLAGS = { '--n': 'IR_FUZZ_N', '--seed': 'IR_FUZZ_SEED', '--size': 'IR_FUZZ_SIZE', '--corpus': 'IR_FUZZ_CORPUS', '--concurrency': 'IR_FUZZ_CONCURRENCY', '--max-failures': 'IR_FUZZ_MAX_FAILURES' };
const env = { ...process.env };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a in FLAGS && args[i + 1] !== undefined) env[FLAGS[a]] = args[++i];
  else {
    console.error(`unknown or incomplete option "${a}"\nusage: npm run fuzz:ir -- --n 1000 --seed 1 [--size 3] [--corpus DIR] [--concurrency 4] [--max-failures 5]`);
    process.exit(2);
  }
}
const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const r = spawnSync(process.execPath, [vitest, 'run', '--config', join(here, 'vitest.fuzz-ir.config.ts')], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
