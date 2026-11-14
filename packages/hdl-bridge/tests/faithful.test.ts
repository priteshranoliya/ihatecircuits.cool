import { compile } from '@ihatecircuits/hdl';
import { IrSim } from '@ihatecircuits/hdl/interp';
import { describe, expect, it } from 'vitest';
import { ALL } from './corpus';
import { trace } from './helpers';

/**
 * The lowered circuit, run in the iHateCircuits simulator, must compute what the
 * IR says. The IR is run by the independent two-state interpreter in @ihatecircuits/hdl.
 */

function stimulusFor(ports: { name: string; width: number; dir: string }[], clock: string | undefined, cycles: number) {
  let seed = 987654321n;
  const next = () => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return seed >> 11n;
  };
  const inputs = ports.filter((p) => p.dir === 'in' && p.name !== clock);
  return Array.from({ length: cycles }, (_, k) =>
    Object.fromEntries(
      inputs.map((p) => {
        const v = p.name === 'rst' ? (k === 0 || next() % 11n === 0n ? 1n : 0n) : p.name === 'en' ? next() % 4n !== 0n ? 1n : 0n : next() & ((1n << BigInt(p.width)) - 1n);
        return [p.name, v.toString(2).padStart(p.width, '0')];
      }),
    ),
  );
}

describe('lowered circuits agree with the IR', () => {
  for (const [name, { source, top }] of Object.entries(ALL)) {
    it(name, () => {
      const design = compile(source, { top }).design!;
      const topModule = design.modules.find((m) => m.name === design.top)!;
      const clock = topModule.ports.some((p) => p.name === 'clk') ? 'clk' : undefined;
      const ports = topModule.ports.map((p) => ({ name: p.name, width: p.width, dir: p.dir }));
      const stimulus = stimulusFor(ports, clock, 80);
      const res = trace({ source, top, clock, stimulus });

      const ir = new IrSim(design);
      const outputs = ports.filter((p) => p.dir === 'out');
      const read = () => Object.fromEntries(outputs.map((p) => [p.name, ir.get(p.name).toString(2).padStart(p.width, '0')]));
      let known = 0;
      let compared = 0;
      stimulus.forEach((step, k) => {
        for (const [port, v] of Object.entries(step)) ir.set(port, BigInt('0b' + v));
        const pre = read();
        let post = pre;
        if (clock) {
          ir.tick(clock);
          post = read();
        }
        for (const [which, want, got] of [['pre', pre, res.cycles[k]!.pre], ['post', post, res.cycles[k]!.post]] as const) {
          for (const p of outputs) {
            compared++;
            if (got[p.name]!.includes('x')) {
              // Unknown power-on state: only allowed while the first values are still working their way into registers.
              expect(k, `${name} cycle ${k} ${which} ${p.name} is unknown`).toBeLessThan(6);
              continue;
            }
            known++;
            expect(got[p.name], `${name} cycle ${k} ${which} ${p.name}`).toBe(want[p.name]);
          }
        }
      });
      expect(known).toBeGreaterThan(compared * 0.9);
    });
  }
});
