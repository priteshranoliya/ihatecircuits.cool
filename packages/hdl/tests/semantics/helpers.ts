import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compareTraces } from '../../../../tools/hdl-fuzz/src/compare';
import { parseTopPorts, type HeaderPort } from '../../../../tools/hdl-fuzz/src/header';
import { iverilogAvailable, iverilogRunner } from '../../../../tools/hdl-fuzz/src/iverilog';
import { createRng, type Rng } from '../../../../tools/hdl-fuzz/src/prng';
import { compile, type CompileOptions } from '../../src';
import type { Diagnostic } from '../../src/diagnostics';
import { findModule } from '../../src/design';
import type { CycleSample, Stimulus, TracePort, TraceRequest, TraceResult, TraceRunner } from '../../src/trace';
import { Ir4Sim, ir4Runner } from '../ir4';

export const haveIverilog = iverilogAvailable();

export interface Check3Opts {
  /** Clock input of the top module. Default: the 1-bit input named `clk` if there is one. `false` forces a clock-less run. */
  clock?: string | false;
  seed?: number;
  /** Cycles of random stimulus when the inputs are too wide to enumerate. Default 200. */
  cycles?: number;
  /** Probability that a bit of the named input is 1 in random stimulus (default 0.5), e.g. a rarely asserted reset. */
  ones?: Record<string, number>;
  /** Cycles applied before the generated ones, e.g. an initial reset. */
  prefix?: Stimulus;
  /** Use random stimulus even when the inputs are few enough to enumerate. */
  random?: boolean;
  /** Replaces the generated stimulus entirely. */
  stimulus?: Stimulus;
  /** Files visible to `$readmemh` and `include, by the name used in the source. */
  files?: Record<string, string>;
  defines?: Record<string, string>;
  /** Exact comparison: a reference x must be matched by x. */
  strict?: boolean;
  /**
   * Read the reference's z as x. A z only survives on a net that a tri-state cell or a constant drives directly;
   * through any other cell (a concat that joins the pieces of a partly driven vector) the IR reads z as x.
   */
  zAsX?: boolean;
  /**
   * Ignore the first cycle's samples. Icarus sees the clock's start (x to 0) as a falling edge at time 0, so a
   * falling-edge register already holds a value there; the IR ignores an edge from an unknown clock.
   */
  skipFirstCycle?: boolean;
  /** Fraction of output bits the reference must resolve to 0, 1 or z, so a program cannot hide behind x. Default 0.5. */
  minKnown?: number;
}

export const EXHAUSTIVE_BITS = 10;

const ones = (w: number) => '1'.repeat(w);
const zeros = (w: number) => '0'.repeat(w);

function randomValue(rng: Rng, width: number, p: number): string {
  const corner = rng.next();
  if (p === 0.5 && corner < 0.08) return zeros(width);
  if (p === 0.5 && corner < 0.16) return ones(width);
  let s = '';
  for (let i = 0; i < width; i++) s += rng.next() < p ? '1' : '0';
  return s;
}

export function portsOf(source: string, top: string): HeaderPort[] {
  return parseTopPorts(source, top);
}

export function clockOf(ports: HeaderPort[], opts: Check3Opts): string | undefined {
  if (opts.clock === false) return undefined;
  if (opts.clock !== undefined) return opts.clock;
  return ports.some((p) => p.name === 'clk' && p.dir === 'in' && p.width === 1) ? 'clk' : undefined;
}

export function buildStimulus(ports: HeaderPort[], clock: string | undefined, opts: Check3Opts = {}): Stimulus {
  if (opts.stimulus) return opts.stimulus;
  const inputs = ports.filter((p) => p.dir === 'in' && p.name !== clock);
  const bits = inputs.reduce((n, p) => n + p.width, 0);
  const rng = createRng(opts.seed ?? 1);
  const out: Stimulus = [...(opts.prefix ?? [])];
  const split = (v: number): Record<string, string> => {
    const cycle: Record<string, string> = {};
    let rest = v;
    for (const p of inputs) {
      cycle[p.name] = (rest % 2 ** p.width).toString(2).padStart(p.width, '0');
      rest = Math.floor(rest / 2 ** p.width);
    }
    return cycle;
  };
  if (inputs.length === 0) {
    for (let i = 0; i < (opts.cycles ?? 40); i++) out.push({});
  } else if (bits <= EXHAUSTIVE_BITS && !opts.random) {
    const all = Array.from({ length: 2 ** bits }, (_, v) => v);
    for (const v of all) out.push(split(v));
    if (clock !== undefined) for (const v of rng.shuffle(all)) out.push(split(v));
  } else {
    for (let i = 0; i < (opts.cycles ?? 200); i++) {
      const cycle: Record<string, string> = {};
      for (const p of inputs) cycle[p.name] = randomValue(rng, p.width, opts.ones?.[p.name] ?? 0.5);
      out.push(cycle);
    }
  }
  return out;
}

function withFiles<T>(files: Record<string, string> | undefined, source: string, body: (source: string) => Promise<T>): Promise<T> {
  if (!files || Object.keys(files).length === 0) return body(source);
  const dir = mkdtempSync(join(tmpdir(), 'hdl-sem-'));
  let rewritten = source;
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
    rewritten = rewritten.split(`"${name}"`).join(`"${join(dir, name)}"`);
  }
  return body(rewritten).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Our pipeline as a TraceRunner: ir4Runner, or the same loop with `files` and `defines` when the program needs them. */
export function oursRunner(opts: { files?: Record<string, string>; defines?: Record<string, string> } = {}): TraceRunner {
  if (!opts.files && !opts.defines) return ir4Runner();
  return (req) => {
    const copts: CompileOptions = { top: req.top, files: opts.files, defines: opts.defines };
    const res = compile(req.source, copts);
    if (!res.design) {
      const errors = res.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.span.line}:${d.span.col} ${d.message}`);
      return { ok: false, error: errors.join('\n') || 'compile failed' };
    }
    try {
      const top = findModule(res.design, res.design.top)!;
      const ports: TracePort[] = top.ports.map((p) => ({ name: p.name, width: p.width, dir: p.dir }));
      const outs = ports.filter((p) => p.dir === 'out');
      const sim = new Ir4Sim(res.design);
      sim.setMany(Object.fromEntries(ports.filter((p) => p.dir === 'in').map((p) => [p.name, '0'.repeat(p.width)])));
      const sample = () => Object.fromEntries(outs.map((p) => [p.name, sim.get(p.name)]));
      const cycles: CycleSample[] = [];
      for (const stim of req.stimulus) {
        sim.setMany(stim);
        const pre = sample();
        if (req.clock !== undefined) sim.set(req.clock, '1');
        const post = sample();
        if (req.clock !== undefined) sim.set(req.clock, '0');
        cycles.push({ pre, post });
      }
      return { ok: true, ports, cycles };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

function requestFor(source: string, top: string, opts: Check3Opts): TraceRequest {
  const ports = portsOf(source, top);
  const clock = clockOf(ports, opts);
  return { source, top, ...(clock !== undefined ? { clock } : {}), stimulus: buildStimulus(ports, clock, opts) };
}

export async function referenceTrace(source: string, top: string, opts: Check3Opts = {}): Promise<TraceResult> {
  const req = requestFor(source, top, opts);
  return withFiles(opts.files, source, async (src) => iverilogRunner({ ...req, source: src }));
}

export async function oursTrace(source: string, top: string, opts: Check3Opts = {}): Promise<TraceResult> {
  return oursRunner({ files: opts.files, defines: opts.defines })(requestFor(source, top, opts));
}

/** Fraction of output samples bits that are not x. */
export function knownFraction(t: TraceResult): number {
  if (!t.ok) return 0;
  let known = 0;
  let total = 0;
  for (const c of t.cycles) {
    for (const phase of [c.pre, c.post]) {
      for (const v of Object.values(phase)) {
        total += v.length;
        for (const ch of v) if (ch !== 'x') known++;
      }
    }
  }
  return total === 0 ? 0 : known / total;
}

function adjustReference(ref: TraceResult, opts: Check3Opts): TraceResult {
  if (!ref.ok || (!opts.zAsX && !opts.skipFirstCycle)) return ref;
  const cycles = ref.cycles.map((c, i) => {
    const fix = (m: Record<string, string>, skip: boolean) =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, skip ? v.replace(/./g, 'x') : opts.zAsX ? v.replace(/z/g, 'x') : v]));
    const skip = opts.skipFirstCycle === true && i === 0;
    return { pre: fix(c.pre, skip), post: fix(c.post, skip) };
  });
  return { ...ref, cycles };
}

/** The reference alone must accept the program and resolve most of its output bits. */
export async function checkReference(source: string, top: string, opts: Check3Opts = {}): Promise<TraceResult> {
  const ref = await referenceTrace(source, top, opts);
  expect(ref.ok ? 'ok' : `iverilog failed: ${ref.error}`).toBe('ok');
  expect(ref.ok && ref.ports.some((p) => p.dir === 'out'), 'the top module has an output').toBe(true);
  expect(knownFraction(ref), 'fraction of output bits the reference resolves').toBeGreaterThanOrEqual(opts.minKnown ?? 0.5);
  return ref;
}

/**
 * Runs `source` through Icarus (reference) and through our compiler plus the four-state IR evaluator, on one
 * stimulus, and asserts the traces agree under compareTraces. Both the pre-clock and post-clock samples count.
 * Overloads: check3(source, top, opts?) and check3(name, source, top, opts?).
 */
export function check3(source: string, top: string, opts?: Check3Opts): Promise<void>;
export function check3(name: string, source: string, top: string, opts?: Check3Opts): Promise<void>;
export async function check3(a: string, b: string, c?: string | Check3Opts, d?: Check3Opts): Promise<void> {
  const named = typeof c === 'string';
  const source = named ? b : a;
  const top = named ? c : b;
  const opts = (named ? d : (c as Check3Opts | undefined)) ?? {};
  const ref = await checkReference(source, top, opts);
  const ours = await oursTrace(source, top, opts);
  const cmp = compareTraces(adjustReference(ref, opts), ours, { strict: opts.strict });
  expect(cmp.ok ? 'traces agree' : `${named ? `${a}: ` : ''}${cmp.message}`).toBe('traces agree');
}

const itRef = it.skipIf(!haveIverilog);
const TIMEOUT = 30_000;

/**
 * Registers two tests for one program: the reference alone (the program is valid Verilog 2005 and its outputs
 * are mostly known), then the three-way comparison. A typo in a program fails the first, an elaborator gap
 * fails the second.
 */
export function sem(name: string, source: string, top: string, opts: Check3Opts = {}): void {
  let memo: Promise<TraceResult> | undefined;
  const ref = () => (memo ??= checkReference(source, top, opts));
  itRef(`${name} [iverilog]`, async () => void (await ref()), TIMEOUT);
  itRef(name, async () => check3(name, source, top, opts), TIMEOUT);
}

export function compileDiags(source: string, opts: CompileOptions = {}): Diagnostic[] {
  return compile(source, opts).diagnostics;
}

export function compileResult(source: string, opts: CompileOptions = {}) {
  return compile(source, opts);
}

export const codesOf = (diags: Diagnostic[]): string[] => diags.map((d) => d.code as string);

export function diagsWithCode(source: string, code: string, opts: CompileOptions = {}): Diagnostic[] {
  return compileDiags(source, opts).filter((d) => (d.code as string) === code);
}

export const severities = (diags: Diagnostic[]) => diags.map((d) => `${d.code}:${d.severity}`);
