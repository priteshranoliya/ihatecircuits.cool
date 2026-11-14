import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { extraRunners } from '../src/extra-runners';
import { runFuzz, selfTestRunners } from '../src/fuzz';
import { parseFeatureList } from '../src/gen';
import { iverilogAvailable } from '../src/iverilog';

const env = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);

it.skipIf(!iverilogAvailable())('hdl fuzz: reference vs runners', async () => {
  const report = await runFuzz({
    n: env('HDL_FUZZ_N', 100),
    seed: env('HDL_FUZZ_SEED', 1),
    size: process.env.HDL_FUZZ_SIZE ? Number(process.env.HDL_FUZZ_SIZE) : undefined,
    features: parseFeatureList(process.env.HDL_FUZZ_FEATURES ?? ''),
    strict: process.env.HDL_FUZZ_STRICT === '1',
    maxFailures: process.env.HDL_FUZZ_MAX_FAILURES ? Number(process.env.HDL_FUZZ_MAX_FAILURES) : undefined,
    runners: process.env.HDL_FUZZ_SELF_ONLY === '1' ? selfTestRunners() : [...selfTestRunners(), ...extraRunners],
    corpusDir: process.env.HDL_FUZZ_CORPUS ?? resolve(import.meta.dirname, '../../../packages/hdl/tests/corpus'),
    shrink: process.env.HDL_FUZZ_NO_SHRINK !== '1',
    concurrency: process.env.HDL_FUZZ_CONCURRENCY ? Number(process.env.HDL_FUZZ_CONCURRENCY) : undefined,
    log: (line) => process.stderr.write(line + '\n'),
  });
  expect(report.failures).toEqual([]);
});
