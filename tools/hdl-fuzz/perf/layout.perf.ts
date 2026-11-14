import { lowerToProject, type View } from '@ihatecircuits/hdl-bridge';
import { expect, it } from 'vitest';
import { bigDesign, constsDesign, wideDesign } from './bigdesign';

/**
 * Lowering and layout must stay close to linear in the size of a circuit. A 1,500-cell circuit lowers in under 2 s and a
 * 5,000-cell one in under 10 s, in both views, whatever the shape: a constant at every pin, one wide column, a net with
 * thousands of readers, a long chain, registers and memories. (Before the fix a 1,500-cell constant-heavy circuit took 17 s.)
 *   npx vitest run --config tools/hdl-fuzz/vitest.perf.config.ts layout
 */
const SHAPES = { mixed: bigDesign, wide: wideDesign, consts: constsDesign };
const LIMIT_MS = { 1500: 2000, 5000: 10_000 } as const;

for (const view of ['blocks', 'gates'] as View[]) {
  for (const [name, make] of Object.entries(SHAPES)) {
    for (const cells of [1500, 5000] as const) {
      it(`${name}, ${cells} cells, ${view} view`, () => {
        const design = make(cells);
        const t0 = performance.now();
        const project = lowerToProject(design, { view });
        const ms = performance.now() - t0;
        const parts = project.circuits.reduce((k, c) => k + Object.keys(c.components).length, 0);
        process.stderr.write(`layout ${name} ${view} cells=${cells}: ${ms.toFixed(0)} ms, ${parts} parts\n`);
        expect(ms).toBeLessThan(LIMIT_MS[cells]);
      });
    }
  }
}
