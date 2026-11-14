import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Stimulus, TraceRequest, TraceResult, TraceRunner } from '@ihatecircuits/hdl/trace';
import { programProblems } from './analysis';
import { compareTraces, type CompareResult } from './compare';
import { generateCase, requestOf, resolveFeatures, type Features, type Program } from './gen';
import { parseTopPorts } from './header';
import { iverilogRunner } from './iverilog';
import { programSize, shrink } from './shrink';

export interface NamedRunner {
  name: string;
  run: TraceRunner;
}

export interface FuzzOptions {
  /** Number of programs; program i uses seed `seed + i`. */
  n: number;
  seed: number;
  size?: number;
  /** Which generator features are on; see `DEFAULT_FEATURES`. */
  features?: Partial<Features>;
  /** Exact trace equality, so a reference x must be matched by x. For targeted runs. Default false. */
  strict?: boolean;
  /** Ground truth. Default: iverilog. */
  reference?: TraceRunner;
  /** Compared against the reference, each on every program. */
  runners: NamedRunner[];
  /** Where mismatch reproductions go, as `<seed>.json`. */
  corpusDir: string;
  shrink?: boolean;
  maxShrinkChecks?: number;
  /** Stop starting new programs after this many failing seeds. Default 5. */
  maxFailures?: number;
  /** Programs in flight at once. Default 4. */
  concurrency?: number;
  log?: (line: string) => void;
}

export interface FuzzFailure {
  seed: number;
  runner: string;
  kind: string;
  message: string;
  corpusFile: string;
}

export interface FuzzReport {
  programs: number;
  firstSeed: number;
  failures: FuzzFailure[];
  elapsedMs: number;
  msPerProgram: number;
}

/** Wraps the top module in a pass-through module: same ports, every non-clock port routed through an assign. Semantics are unchanged. */
export function wrapPassThrough(req: TraceRequest): TraceRequest {
  const ports = parseTopPorts(req.source, req.top);
  const wrapName = '__gw_wrap';
  const range = (w: number) => (w > 1 ? `[${w - 1}:0] ` : '');
  const header = ports.map((p) => `  ${p.dir === 'in' ? 'input' : 'output'} ${range(p.width)}${p.name}`).join(',\n');
  const body: string[] = [];
  const conns: string[] = [];
  for (const p of ports) {
    if (p.name === req.clock) {
      conns.push(`.${p.name}(${p.name})`);
      continue;
    }
    body.push(`  wire ${range(p.width)}${p.name}__w;`);
    body.push(p.dir === 'in' ? `  assign ${p.name}__w = ${p.name};` : `  assign ${p.name} = ${p.name}__w;`);
    conns.push(`.${p.name}(${p.name}__w)`);
  }
  const wrapper = `module ${wrapName} (\n${header}\n);\n${body.join('\n')}\n  ${req.top} __gw_inner (${conns.join(', ')});\nendmodule\n`;
  return { ...req, source: req.source + '\n' + wrapper, top: wrapName };
}

/** Self-tests that need no second implementation: a rerun, and a semantics-preserving rewrite. */
export function selfTestRunners(base: TraceRunner = iverilogRunner): NamedRunner[] {
  return [
    { name: 'iverilog-rerun', run: base },
    { name: 'iverilog-passthrough-wrapper', run: (req) => base(wrapPassThrough(req)) },
  ];
}

interface Evidence {
  ref: TraceResult;
  ours: TraceResult;
  cmp: Extract<CompareResult, { ok: false }>;
}

/** What makes two failures "the same": the kind, and for a compile error the compiler's error codes, so a reduction cannot swap one bug for another. */
function failureSignature(cmp: Extract<CompareResult, { ok: false }>): string {
  if (cmp.kind !== 'ours-error' && cmp.kind !== 'ref-error') return cmp.kind;
  const codes = new Set([...cmp.message.matchAll(/error \[([\w-]+)\]/g)].map((m) => m[1]!));
  return codes.size > 0 ? `${cmp.kind}:${[...codes].sort().join(',')}` : cmp.kind;
}

async function evaluate(reference: TraceRunner, runner: TraceRunner, req: TraceRequest, strict: boolean): Promise<Evidence | null> {
  const ref = await reference(req);
  const ours = await runner(req);
  const cmp = compareTraces(ref, ours, { strict });
  return cmp.ok ? null : { ref, ours, cmp };
}

async function shrinkFailure(
  o: FuzzOptions,
  reference: TraceRunner,
  runner: NamedRunner,
  program: Program,
  stimulus: Stimulus,
  ev: Evidence,
): Promise<{ program: Program; stimulus: Stimulus; evidence: Evidence; checks: number }> {
  if (o.shrink === false) return { program, stimulus, evidence: ev, checks: 0 };
  return shrink<Evidence>(
    program,
    stimulus,
    ev,
    async (p, s) => {
      if (programProblems(p).length > 0) return null;
      const e = await evaluate(reference, runner.run, requestOf(p, s), o.strict === true);
      return e && failureSignature(e.cmp) === failureSignature(ev.cmp) ? e : null;
    },
    o.maxShrinkChecks,
  );
}

const featureSummary = (f?: Partial<Features>) =>
  Object.entries(resolveFeatures(f))
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(' ');

export async function runFuzz(o: FuzzOptions): Promise<FuzzReport> {
  const reference = o.reference ?? iverilogRunner;
  const log = o.log ?? (() => {});
  const maxFailures = o.maxFailures ?? 5;
  const concurrency = Math.max(1, o.concurrency ?? 4);
  const failures: FuzzFailure[] = [];
  const started = performance.now();
  let next = 0;
  let done = 0;

  const one = async (i: number) => {
    const seed = o.seed + i;
    const gen = generateCase(seed, { size: o.size, features: o.features });
    const req: TraceRequest = { source: gen.source, top: gen.top, clock: gen.clock, stimulus: gen.stimulus };
    for (const runner of o.runners) {
      const ev = await evaluate(reference, runner.run, req, o.strict === true);
      if (!ev) continue;
      const small = await shrinkFailure(o, reference, runner, gen.program, gen.stimulus, ev);
      const final = small.evidence;
      const shrunkReq = requestOf(small.program, small.stimulus);
      mkdirSync(o.corpusDir, { recursive: true });
      const corpusFile = join(o.corpusDir, `${seed}.json`);
      writeFileSync(
        corpusFile,
        JSON.stringify(
          {
            seed,
            size: gen.size,
            features: gen.features,
            strict: o.strict === true,
            runner: runner.name,
            kind: final.cmp.kind,
            message: final.cmp.message,
            mismatch: final.cmp.mismatch,
            top: shrunkReq.top,
            clock: shrunkReq.clock,
            source: shrunkReq.source,
            stimulus: shrunkReq.stimulus,
            reference: final.ref,
            ours: final.ours,
            shrunk: { checks: small.checks, programSizeBefore: programSize(gen.program), programSizeAfter: programSize(small.program), cyclesBefore: gen.stimulus.length, cyclesAfter: small.stimulus.length },
          },
          null,
          2,
        ) + '\n',
      );
      const failure: FuzzFailure = { seed, runner: runner.name, kind: final.cmp.kind, message: final.cmp.message, corpusFile };
      failures.push(failure);
      log(`FAIL seed ${seed} [${runner.name}] ${final.cmp.message} -> ${corpusFile}`);
      return;
    }
  };

  const worker = async () => {
    while (next < o.n && failures.length < maxFailures) {
      const i = next++;
      await one(i);
      done++;
      if (done % 50 === 0) log(`... ${done}/${o.n} programs`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, o.n) }, worker));

  const elapsedMs = performance.now() - started;
  failures.sort((a, b) => a.seed - b.seed);
  const report: FuzzReport = { programs: done, firstSeed: o.seed, failures, elapsedMs, msPerProgram: done ? elapsedMs / done : 0 };
  log(
    `hdl-fuzz: ${done} programs (seeds ${o.seed}..${o.seed + Math.max(done, 1) - 1}, size ${o.size ?? 3}), runners [${o.runners.map((r) => r.name).join(', ')}], features [${featureSummary(o.features)}]${o.strict ? ', strict' : ''}, ` +
      `${failures.length} failing, ${(elapsedMs / 1000).toFixed(1)} s total, ${report.msPerProgram.toFixed(0)} ms/program wall`,
  );
  return report;
}
