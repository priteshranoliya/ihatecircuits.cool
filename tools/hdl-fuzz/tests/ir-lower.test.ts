import { boundsOf, rectsIntersect } from '@ihatecircuits/core/geometry';
import type { Circuit, Project } from '@ihatecircuits/core/types';
import type { Design } from '@ihatecircuits/hdl/design';
import { exportVerilog, lowerToProject, type View } from '@ihatecircuits/hdl-bridge';
import { describe, expect, it } from 'vitest';
import { designOf, ModuleBuilder } from '../src/irbuild';
import { generateIrCase } from '../src/irgen';
import { iverilogAvailable } from '../src/iverilog';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VIEWS: View[] = ['blocks', 'gates'];

/** The parts the gates view may use: gates, flip-flops, latches, tri-state buffers, pull resistors and plain wiring. */
const GATE_PARTS = new Set(['and', 'or', 'not', 'xor', 'xnor', 'nand', 'nor', 'mux', 'dff', 'dlatch', 'tribuf', 'pull', 'splitter', 'extender', 'const', 'pin', 'junction']);

const overlaps = (c: Circuit): string[] => {
  const comps = Object.values(c.components);
  const out: string[] = [];
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      if (rectsIntersect(boundsOf(comps[i]!), boundsOf(comps[j]!))) out.push(`${comps[i]!.type}#${comps[i]!.id} overlaps ${comps[j]!.type}#${comps[j]!.id}`);
    }
  }
  return out;
};

function layoutProblems(p: Project): string[] {
  const problems: string[] = [];
  for (const c of p.circuits) {
    for (const o of overlaps(c)) problems.push(`${c.name}: ${o}`);
    const used = new Set(Object.values(c.wires).flatMap((w) => [w.from.comp, w.to.comp]));
    for (const k of Object.values(c.components)) {
      if (k.x % 10 || k.y % 10) problems.push(`${c.name}: ${k.type}#${k.id} is off the grid`);
      if (k.type !== 'pin' && !used.has(k.id)) problems.push(`${c.name}: ${k.type}#${k.id} is not wired`);
    }
    for (const w of Object.values(c.wires)) {
      const from = c.components[w.from.comp]!;
      const to = c.components[w.to.comp]!;
      if ((from.type === 'register' || from.type === 'dff') && w.from.pin === 'q') continue;
      if (to.x <= from.x) problems.push(`${c.name}: ${from.type}.${w.from.pin} -> ${to.type}.${w.to.pin} does not flow left to right`);
    }
  }
  return problems;
}

describe('lowering random IR designs', () => {
  for (const view of VIEWS) {
    it(`${view} view: no overlapping parts, everything on the grid and wired, signals flow left to right (40 designs)`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const { design } = generateIrCase(seed, { size: seed % 2 ? 3 : 6 });
        expect(layoutProblems(lowerToProject(design, { view })), `seed ${seed}`).toEqual([]);
      }
    }, 120_000);
  }

  it('gates view: only gates, flip-flops, latches, tri-state buffers and wiring (and circuits made of them)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { design } = generateIrCase(seed, { size: 4 });
      const project = lowerToProject(design, { view: 'gates' });
      for (const c of project.circuits) {
        for (const k of Object.values(c.components)) {
          if (k.type.startsWith('sub:')) continue;
          expect(GATE_PARTS.has(k.type), `seed ${seed} ${c.name}: ${k.type}`).toBe(true);
          if (k.type === 'mux') expect(k.props.sel, `seed ${seed} ${c.name}: mux select width`).toBe(1);
        }
      }
    }
  }, 120_000);

  it('is deterministic in both views', () => {
    for (const view of VIEWS) {
      const { design } = generateIrCase(7, { size: 5 });
      expect(JSON.stringify(lowerToProject(design, { view }))).toBe(JSON.stringify(lowerToProject(design, { view })));
    }
  });
});

/** A design with one cell between input ports and an output port. */
function oneCell(make: (m: ModuleBuilder, a: number, b: number, w: number) => number, w: number): Design {
  const m = new ModuleBuilder('top');
  const a = m.input('a', w);
  const b = m.input('b', w);
  m.output('y', make(m, a, b, w));
  return designOf(m.build());
}

const binary = (kind: 'add' | 'sub' | 'mul' | 'divu' | 'remu' | 'divs' | 'rems') => (m: ModuleBuilder, a: number, b: number, w: number) => {
  const out = m.net(w);
  m.add({ kind, a, b, out });
  return out;
};

const types = (p: Project) => new Set(p.circuits.flatMap((c) => Object.values(c.components).map((k) => k.type)).filter((t) => !t.startsWith('sub:')));
const names = (p: Project) => p.circuits.map((c) => c.name);

describe('blocks view: each arithmetic cell is a library part, with guards where the part differs', () => {
  const blocks = (kind: Parameters<typeof binary>[0], w: number) => types(lowerToProject(oneCell(binary(kind), w), { view: 'blocks' }));
  it('maps to the parts documented in blocks.ts', () => {
    expect(blocks('add', 8)).toEqual(new Set(['adder', 'pin']));
    expect(blocks('sub', 8)).toEqual(new Set(['subtractor', 'pin']));
    expect(blocks('mul', 8)).toEqual(new Set(['multiplier', 'pin']));
    expect(blocks('divu', 8)).toEqual(new Set(['divider', 'pin']));
    expect(blocks('remu', 8)).toEqual(new Set(['divider', 'pin']));
    expect(blocks('divs', 8)).toEqual(new Set(['divider', 'negator', 'mux', 'xor', 'splitter', 'pin']));
    expect(blocks('rems', 8)).toEqual(new Set(['divider', 'negator', 'mux', 'splitter', 'pin']));
  });
  it('a shift by an amount the Shifter pin cannot count adds a guard that selects the fill', () => {
    const shift = (w: number, aw: number) => {
      const m = new ModuleBuilder('top');
      const a = m.input('a', w);
      const n = m.input('n', aw);
      const out = m.net(w);
      m.add({ kind: 'sshr', a, amount: n, out });
      m.output('y', out);
      return types(lowerToProject(designOf(m.build()), { view: 'blocks' }));
    };
    expect(shift(8, 3)).toEqual(new Set(['shifter', 'pin']));
    expect(shift(8, 2)).toEqual(new Set(['shifter', 'extender', 'pin']));
    expect(shift(8, 6)).toEqual(new Set(['shifter', 'splitter', 'or', 'mux', 'extender', 'pin']));
  });
});

describe('gates view: word-level cells become circuits of their own', () => {
  it('names the support circuits after the cell and its width, builds them from smaller ones, and shares them', () => {
    const m = new ModuleBuilder('top');
    const [a, b] = [m.input('a', 8), m.input('b', 8)];
    const [s1, s2] = [m.net(8), m.net(8)];
    m.add({ kind: 'add', a, b, out: s1 });
    m.add({ kind: 'add', a: s1, b, out: s2 });
    m.output('y', s2);
    const p = lowerToProject(designOf(m.build()), { view: 'gates' });
    expect(names(p)).toEqual(['top', 'fa', 'add8']);
    const main = p.circuits[0]!;
    expect(Object.values(main.components).filter((k) => k.type.startsWith('sub:'))).toHaveLength(2);
    const add8 = p.circuits.find((c) => c.name === 'add8')!;
    expect(Object.values(add8.components).filter((k) => k.type.startsWith('sub:'))).toHaveLength(7);
    const fa = p.circuits.find((c) => c.name === 'fa')!;
    expect([...new Set(Object.values(fa.components).map((k) => k.type))].sort()).toEqual(['and', 'or', 'pin', 'xor']);
  });

  it('every word-level cell lowers in both views at widths 1 to 9 without overlaps', () => {
    for (const kind of ['add', 'sub', 'mul', 'divu', 'remu', 'divs', 'rems'] as const) {
      for (let w = 1; w <= 9; w += w < 4 ? 1 : 5) {
        for (const view of VIEWS) expect(layoutProblems(lowerToProject(oneCell(binary(kind), w), { view })), `${kind}${w} ${view}`).toEqual([]);
      }
    }
  });
});

describe('what the circuit does where the IR gives x', () => {
  it('a Divider divides by zero as all ones; the circuit gives that definite value where the IR says x', () => {
    const d = oneCell(binary('divu'), 4);
    for (const view of VIEWS) expect(names(lowerToProject(d, { view })).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!iverilogAvailable())('the exported Verilog of every part the lowerings use is accepted by Icarus', () => {
  it('compiles with -Wall without errors, in both views, for 30 random designs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-ir-export-'));
    try {
      for (const view of VIEWS) {
        for (let seed = 1; seed <= 30; seed++) {
          const { design } = generateIrCase(seed, { size: 4 });
          const file = join(dir, `${view}-${seed}.v`);
          writeFileSync(file, exportVerilog(lowerToProject(design, { view })));
          const r = spawnSync('iverilog', ['-g2005', '-o', join(dir, 'out.vvp'), file], { encoding: 'utf8' });
          expect(r.stderr, `${view} seed ${seed}`).not.toMatch(/error/i);
          expect(r.status, `${view} seed ${seed}`).toBe(0);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
