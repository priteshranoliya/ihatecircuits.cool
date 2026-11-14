import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runIrFuzz } from '../src/irfuzz';
import { iverilogAvailable } from '../src/iverilog';

const env = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);

it.skipIf(!iverilogAvailable())('ir fuzz: reference vs interpreter and both lowerings', async () => {
  const report = await runIrFuzz({
    n: env('IR_FUZZ_N', 100),
    seed: env('IR_FUZZ_SEED', 1),
    size: process.env.IR_FUZZ_SIZE ? Number(process.env.IR_FUZZ_SIZE) : undefined,
    maxFailures: process.env.IR_FUZZ_MAX_FAILURES ? Number(process.env.IR_FUZZ_MAX_FAILURES) : undefined,
    concurrency: process.env.IR_FUZZ_CONCURRENCY ? Number(process.env.IR_FUZZ_CONCURRENCY) : undefined,
    corpusDir: process.env.IR_FUZZ_CORPUS ?? resolve(import.meta.dirname, '../corpus-ir'),
    log: (line) => process.stderr.write(line + '\n'),
  });
  expect(report.failures).toEqual([]);
});
