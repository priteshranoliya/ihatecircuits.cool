import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareTraces } from './compare';
import { generateIrCase } from './irgen';
import { type DesignRunner, irReference, irRunners } from './ir-runners';

export interface IrFuzzOptions {
  /** Number of designs; design i uses seed `seed + i`. */
  n: number;
  seed: number;
  size?: number;
  /** Ground truth. Default: Icarus on the IR printed as Verilog. */
  reference?: DesignRunner;
  /** Compared against the reference on every design. The interpreter is held to exact equality. */
  runners?: DesignRunner[];
  corpusDir: string;
  maxFailures?: number;
  concurrency?: number;
  log?: (line: string) => void;
}

export interface IrFuzzFailure {
  seed: number;
  runner: string;
  message: string;
  corpusFile: string;
}

export interface IrFuzzReport {
  designs: number;
  firstSeed: number;
  failures: IrFuzzFailure[];
  elapsedMs: number;
  summary: string;
}

export async function runIrFuzz(o: IrFuzzOptions): Promise<IrFuzzReport> {
  const reference = o.reference ?? irReference;
  const runners = o.runners ?? irRunners;
  const log = o.log ?? (() => {});
  const maxFailures = o.maxFailures ?? 5;
  const concurrency = Math.max(1, o.concurrency ?? 4);
  const failures: IrFuzzFailure[] = [];
  const started = performance.now();
  let next = 0;
  let done = 0;

  const one = async (i: number) => {
    const seed = o.seed + i;
    const c = generateIrCase(seed, { size: o.size });
    const req = { design: c.design, clock: c.clock, stimulus: c.stimulus };
    const ref = await reference.run(req);
    for (const runner of runners) {
      const ours = await runner.run(req);
      const cmp = compareTraces(ref, ours, { strict: runner.name === 'interp' });
      if (cmp.ok) continue;
      mkdirSync(o.corpusDir, { recursive: true });
      const corpusFile = join(o.corpusDir, `${seed}.json`);
      writeFileSync(corpusFile, JSON.stringify({ seed, size: c.size, runner: runner.name, message: cmp.message, clock: c.clock, stimulus: c.stimulus, design: c.design, reference: ref, ours }, null, 2) + '\n');
      failures.push({ seed, runner: runner.name, message: cmp.message, corpusFile });
      log(`FAIL seed ${seed} [${runner.name}] ${cmp.message} -> ${corpusFile}`);
      return;
    }
  };

  const worker = async () => {
    while (next < o.n && failures.length < maxFailures) {
      const i = next++;
      await one(i);
      done++;
      if (done % 100 === 0) log(`... ${done}/${o.n} designs`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, o.n) }, worker));

  const elapsedMs = performance.now() - started;
  failures.sort((a, b) => a.seed - b.seed);
  const summary =
    `ir-fuzz: ${done} designs (seeds ${o.seed}..${o.seed + Math.max(done, 1) - 1}, size ${o.size ?? 3}), reference ${reference.name}, runners [${runners.map((r) => r.name).join(', ')}], ` +
    `${failures.length} failing, ${(elapsedMs / 1000).toFixed(1)} s total, ${done ? (elapsedMs / done).toFixed(0) : 0} ms/design wall`;
  log(summary);
  return { designs: done, firstSeed: o.seed, failures, elapsedMs, summary };
}
