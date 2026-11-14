import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceRequest, TraceRunner } from '@ihatecircuits/hdl/trace';
import { afterEach, describe, expect, it } from 'vitest';
import { compareTraces } from '../src/compare';
import { runFuzz, selfTestRunners, wrapPassThrough } from '../src/fuzz';
import { generateCase } from '../src/gen';
import { iverilogAvailable, iverilogRunner } from '../src/iverilog';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'hdl-fuzz-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!iverilogAvailable())('fuzz driver', () => {
  it('iverilog agrees with itself on 20 seeds: rerun and pass-through wrapper', async () => {
    const corpusDir = tempDir();
    const report = await runFuzz({ n: 20, seed: 1, runners: selfTestRunners(), corpusDir });
    expect(report.failures).toEqual([]);
    expect(report.programs).toBe(20);
    expect(readdirSync(corpusDir)).toEqual([]);
  });

  it('iverilog agrees with itself in strict mode with every feature on, 30 seeds', async () => {
    const corpusDir = tempDir();
    const report = await runFuzz({ n: 30, seed: 500, runners: selfTestRunners(), corpusDir, strict: true, features: { clocks: true, undriven: true } });
    expect(report.failures).toEqual([]);
    expect(readdirSync(corpusDir)).toEqual([]);
  });

  it('strict mode reports a difference that the default comparator forgives, and records both in the corpus', async () => {
    const forgiving: TraceRunner = async (req) => {
      const r = await iverilogRunner(req);
      if (!r.ok) return r;
      const settle = (v: string) => v.replace(/x/g, '0');
      const fix = (s: Record<string, string>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, settle(v)]));
      return { ...r, cycles: r.cycles.map((c) => ({ pre: fix(c.pre), post: fix(c.post) })) };
    };
    const base = { n: 40, seed: 1, runners: [{ name: 'x-to-zero', run: forgiving }], shrink: false, features: { unreset: true } as const };
    const loose = await runFuzz({ ...base, corpusDir: tempDir() });
    expect(loose.failures).toEqual([]);
    const corpusDir = tempDir();
    const strict = await runFuzz({ ...base, corpusDir, strict: true, maxFailures: 1, concurrency: 1 });
    expect(strict.failures.length).toBe(1);
    expect(JSON.parse(readFileSync(strict.failures[0]!.corpusFile, 'utf8'))).toMatchObject({ strict: true, kind: 'value', features: { unreset: true } });
  });

  it('the pass-through wrapper keeps the ports and the trace', async () => {
    const g = generateCase(3);
    const req: TraceRequest = { source: g.source, top: g.top, clock: g.clock, stimulus: g.stimulus };
    const wrapped = wrapPassThrough(req);
    expect(wrapped.source).toContain('assign');
    expect(wrapped.top).not.toBe(req.top);
    const a = await iverilogRunner(req);
    const b = await iverilogRunner(wrapped);
    expect(a.ok && b.ok).toBe(true);
    expect(compareTraces(a, b)).toEqual({ ok: true });
  });

  it('writes a shrunk reproduction to <seed>.json when a runner disagrees', async () => {
    const corpusDir = tempDir();
    const broken: TraceRunner = async (req) => {
      const r = await iverilogRunner(req);
      if (!r.ok) return r;
      const out = r.ports.find((p) => p.dir === 'out')!.name;
      const flip = (v: string) => (v[0] === '0' ? '1' : v[0] === '1' ? '0' : v[0]!) + v.slice(1);
      return { ...r, cycles: r.cycles.map((c, k) => (k < 2 ? c : { pre: c.pre, post: { ...c.post, [out]: flip(c.post[out]!) } })) };
    };
    const report = await runFuzz({ n: 4, seed: 100, size: 4, runners: [{ name: 'broken', run: broken }], corpusDir, maxFailures: 1, concurrency: 1 });
    expect(report.failures).toHaveLength(1);
    const f = report.failures[0]!;
    expect(f.corpusFile).toBe(join(corpusDir, `${f.seed}.json`));
    const json = JSON.parse(readFileSync(f.corpusFile, 'utf8'));
    expect(json).toMatchObject({ seed: f.seed, runner: 'broken', kind: 'value' });
    expect(json.shrunk.programSizeAfter).toBeLessThan(json.shrunk.programSizeBefore);
    expect(json.stimulus.length).toBeLessThanOrEqual(json.shrunk.cyclesBefore);
    const again = await iverilogRunner({ source: json.source, top: json.top, clock: json.clock, stimulus: json.stimulus });
    expect(again.ok).toBe(true);
    expect(again).toEqual(json.reference);
    expect(compareTraces(json.reference, json.ours)).toMatchObject({ ok: false });
  });
});
