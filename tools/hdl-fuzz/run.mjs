#!/usr/bin/env node
/**
 * `npm run fuzz:hdl -- --n 500 --seed 42 [--size 1..10] [--corpus DIR] [--no-shrink] [--concurrency K] [--max-failures K]`
 *   `[--clocks] [--undriven] [--strict] [--self-test-only] [--no-unreset] [--no-width-mismatch] [--no-wide] [--no-deep]`
 * Runs the differential fuzzer through Vitest (so workspace TypeScript sources resolve the
 * same way they do in tests) with the options passed as HDL_FUZZ_* environment variables.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const VALUE_FLAGS = { '--n': 'HDL_FUZZ_N', '--seed': 'HDL_FUZZ_SEED', '--size': 'HDL_FUZZ_SIZE', '--corpus': 'HDL_FUZZ_CORPUS', '--concurrency': 'HDL_FUZZ_CONCURRENCY', '--max-failures': 'HDL_FUZZ_MAX_FAILURES' };
const FEATURES = ['unreset', 'width-mismatch', 'clocks', 'wide', 'deep', 'undriven'];
const env = { ...process.env };
const args = process.argv.slice(2);
const features = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--no-shrink') env.HDL_FUZZ_NO_SHRINK = '1';
  else if (a === '--strict') env.HDL_FUZZ_STRICT = '1';
  else if (a === '--self-test-only') env.HDL_FUZZ_SELF_ONLY = '1';
  else if (a.startsWith('--') && FEATURES.includes(a.slice(2))) features.push(a.slice(2));
  else if (a.startsWith('--no-') && FEATURES.includes(a.slice(5))) features.push('-' + a.slice(5));
  else if (a in VALUE_FLAGS && args[i + 1] !== undefined) env[VALUE_FLAGS[a]] = args[++i];
  else {
    console.error(
      `unknown or incomplete option "${a}"\nusage: npm run fuzz:hdl -- --n 500 --seed 42 [--size 3] [--corpus DIR] [--no-shrink] [--concurrency 4] [--max-failures 5] [--strict] [--self-test-only]\n` +
        `  features: --clocks --undriven (off by default), --no-unreset --no-width-mismatch --no-wide --no-deep (on by default)`,
    );
    process.exit(2);
  }
}
if (features.length) env.HDL_FUZZ_FEATURES = features.join(',');
const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const r = spawnSync(process.execPath, [vitest, 'run', '--config', join(here, 'vitest.fuzz.config.ts')], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
