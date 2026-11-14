import type { TraceResult } from '@ihatecircuits/hdl/trace';
import { describe, expect, it } from 'vitest';
import { compareTraces } from '../src/compare';

const ports = [
  { name: 'a', width: 1, dir: 'in' as const },
  { name: 'y', width: 4, dir: 'out' as const },
  { name: 'z', width: 1, dir: 'out' as const },
];

type Ok = Extract<TraceResult, { ok: true }>;

function trace(...cycles: Array<{ pre: [string, string]; post: [string, string] }>): Ok {
  return { ok: true, ports, cycles: cycles.map((c) => ({ pre: { y: c.pre[0], z: c.pre[1] }, post: { y: c.post[0], z: c.post[1] } })) };
}

describe('compareTraces', () => {
  const base = trace({ pre: ['0101', '1'], post: ['0101', '1'] }, { pre: ['0101', '1'], post: ['1111', '0'] });

  it('accepts identical traces', () => {
    expect(compareTraces(base, structuredClone(base))).toEqual({ ok: true });
  });

  it('lets a reference x accept any value, bit by bit', () => {
    const ref = trace({ pre: ['x1x0', 'x'], post: ['0101', '1'] });
    expect(compareTraces(ref, trace({ pre: ['0110', '0'], post: ['0101', '1'] }))).toEqual({ ok: true });
    expect(compareTraces(ref, trace({ pre: ['z1x0', 'z'], post: ['0101', '1'] }))).toEqual({ ok: true });
    const bad = compareTraces(ref, trace({ pre: ['0111', '0'], post: ['0101', '1'] }));
    expect(bad).toMatchObject({ ok: false, kind: 'value', mismatch: { cycle: 0, phase: 'pre', port: 'y', ref: 'x1x0', ours: '0111' } });
  });

  it('strict mode demands exact equality: a reference x must be matched by x', () => {
    const ref = trace({ pre: ['x1x0', 'x'], post: ['0101', '1'] });
    const loose = trace({ pre: ['0110', '0'], post: ['0101', '1'] });
    expect(compareTraces(ref, loose)).toEqual({ ok: true });
    expect(compareTraces(ref, loose, { strict: true })).toMatchObject({ ok: false, kind: 'value', mismatch: { cycle: 0, phase: 'pre', port: 'y', ref: 'x1x0', ours: '0110' } });
    expect(compareTraces(ref, structuredClone(ref), { strict: true })).toEqual({ ok: true });
    expect(compareTraces(ref, trace({ pre: ['x1x0', 'z'], post: ['0101', '1'] }), { strict: true })).toMatchObject({ ok: false, mismatch: { port: 'z', ref: 'x', ours: 'z' } });
    expect(compareTraces(base, structuredClone(base), { strict: true })).toEqual({ ok: true });
    expect(compareTraces(base, structuredClone(base), { strict: false })).toEqual({ ok: true });
  });

  it('rejects x or z from us where the reference is 0 or 1', () => {
    for (const bit of ['x', 'z']) {
      const ours = trace({ pre: ['0101', '1'], post: [`0${bit}01`, '1'] }, { pre: ['0101', '1'], post: ['1111', '0'] });
      expect(compareTraces(base, ours)).toMatchObject({ ok: false, mismatch: { cycle: 0, phase: 'post', port: 'y', ref: '0101', ours: `0${bit}01` } });
    }
  });

  it('rejects a reference z unless ours is also z', () => {
    const ref = trace({ pre: ['zzzz', 'z'], post: ['zzzz', 'z'] });
    expect(compareTraces(ref, trace({ pre: ['zzzz', 'z'], post: ['zzzz', 'z'] }))).toEqual({ ok: true });
    expect(compareTraces(ref, trace({ pre: ['zzzz', 'x'], post: ['zzzz', 'z'] }))).toMatchObject({ ok: false, mismatch: { port: 'z', ref: 'z', ours: 'x' } });
  });

  it('reports the first mismatch: earliest cycle, pre before post, reference port order', () => {
    const ours = trace({ pre: ['0101', '1'], post: ['0101', '1'] }, { pre: ['0101', '0'], post: ['0000', '1'] });
    expect(compareTraces(base, ours)).toMatchObject({ ok: false, mismatch: { cycle: 1, phase: 'pre', port: 'z', ref: '1', ours: '0' } });
    const both = trace({ pre: ['0101', '1'], post: ['0101', '1'] }, { pre: ['0101', '1'], post: ['0000', '1'] });
    expect(compareTraces(base, both)).toMatchObject({ ok: false, mismatch: { cycle: 1, phase: 'post', port: 'y', ref: '1111', ours: '0000' } });
  });

  it('flags failed runs, shape differences and wrong widths', () => {
    expect(compareTraces({ ok: false, error: 'boom' }, base)).toMatchObject({ ok: false, kind: 'ref-error' });
    expect(compareTraces(base, { ok: false, error: 'boom' })).toMatchObject({ ok: false, kind: 'ours-error', message: expect.stringContaining('boom') });
    expect(compareTraces(base, trace({ pre: ['0101', '1'], post: ['0101', '1'] }))).toMatchObject({ ok: false, kind: 'length' });
    expect(compareTraces(base, { ...structuredClone(base), ports: ports.slice(0, 2) })).toMatchObject({ ok: false, kind: 'ports' });
    expect(compareTraces(base, trace({ pre: ['010', '1'], post: ['0101', '1'] }, { pre: ['0101', '1'], post: ['1111', '0'] }))).toMatchObject({ ok: false, kind: 'value' });
  });
});
