import { describe, expect, it } from 'vitest';
import { programProblems } from '../src/analysis';
import { generateCase, renderProgram } from '../src/gen';
import { programSize, shrink } from '../src/shrink';

describe('shrink', () => {
  it('reduces a derived-clock program to little more than the gate, keeping every candidate valid', async () => {
    const g = generateCase(9269, { features: { clocks: true } });
    const keeps = (src: string) => /wire g\d = clk & en\d;|assign g\d = clk & en\d;/.test(src);
    expect(keeps(g.source)).toBe(true);
    let candidates = 0;
    const r = await shrink(g.program, g.stimulus, true, async (p) => {
      candidates++;
      if (programProblems(p).length > 0) return null;
      return keeps(renderProgram(p)) ? true : null;
    });
    expect(programSize(r.program)).toBeLessThan(programSize(g.program) / 3);
    expect(programSize(r.program)).toBeLessThanOrEqual(12);
    expect(programProblems(r.program)).toEqual([]);
    expect(candidates).toBeGreaterThan(10);
  });

  it('simplifies a large expression down to the sub-expression that matters', async () => {
    const g = generateCase(21, { size: 5, features: { deep: true } });
    const mark = /\+/;
    const r = await shrink(g.program, g.stimulus, true, async (p) => (programProblems(p).length === 0 && mark.test(renderProgram(p)) ? true : null));
    expect(renderProgram(r.program).length).toBeLessThan(renderProgram(g.program).length / 4);
    expect(mark.test(renderProgram(r.program))).toBe(true);
  });
});
