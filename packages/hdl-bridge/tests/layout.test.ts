import { boundsOf, rectsIntersect } from '@ihatecircuits/core/geometry';
import { serialize } from '@ihatecircuits/core/serialize';
import type { Circuit } from '@ihatecircuits/core/types';
import type { Design } from '@ihatecircuits/hdl';
import { describe, expect, it } from 'vitest';
import { LowerError, lowerToProject } from '../src';
import { ALL } from './corpus';
import { project } from './helpers';

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

describe('layout', () => {
  for (const [name, { source, top }] of Object.entries(ALL)) {
    describe(name, () => {
      const p = project(source, top);

      it('puts no two parts on top of each other', () => {
        for (const c of p.circuits) expect(overlaps(c), c.name).toEqual([]);
      });

      it('keeps every part on the 10px grid', () => {
        for (const c of p.circuits) {
          for (const k of Object.values(c.components)) {
            expect([k.x % 10, k.y % 10], `${c.name}/${k.type}`).toEqual([0, 0]);
            const b = boundsOf(k);
            expect([b.w % 10, b.h % 10]).toEqual([0, 0]);
          }
        }
      });

      it('lays parts out in columns by logic depth: signals flow left to right except out of a register', () => {
        for (const c of p.circuits) {
          for (const w of Object.values(c.wires)) {
            const from = c.components[w.from.comp]!;
            const to = c.components[w.to.comp]!;
            if (from.type === 'register' && w.from.pin === 'q') continue;
            expect(to.x, `${c.name}: ${from.type}.${w.from.pin} -> ${to.type}.${w.to.pin}`).toBeGreaterThan(from.x);
          }
        }
      });

      it('wires every part except ports nothing uses', () => {
        for (const c of p.circuits) {
          const used = new Set(Object.values(c.wires).flatMap((w) => [w.from.comp, w.to.comp]));
          for (const k of Object.values(c.components)) if (k.type !== 'pin') expect(used.has(k.id), `${c.name}/${k.type}#${k.id}`).toBe(true);
        }
      });
    });
  }

  it('is deterministic: the same source gives an identical Project JSON', () => {
    for (const [name, { source, top }] of Object.entries(ALL)) {
      const a = JSON.stringify(project(source, top));
      project(ALL.busy!.source, ALL.busy!.top);
      const b = JSON.stringify(project(source, top));
      expect(b, name).toBe(a);
      expect(serialize(project(source, top)), name).toBe(serialize(project(source, top)));
    }
  });
});

describe('project structure', () => {
  it('makes the top module main, one circuit per module, and instances sub: parts', () => {
    const p = project(ALL.twice!.source, 'top');
    expect(p.main).toBe('main');
    expect(p.circuits.map((c) => c.name)).toEqual(['top', 'add4']);
    const main = p.circuits[0]!;
    const subs = Object.values(main.components).filter((k) => k.type.startsWith('sub:'));
    expect(subs.map((k) => [k.type, k.label])).toEqual([
      ['sub:k2', 'u1'],
      ['sub:k2', 'u2'],
    ]);
    expect(p.circuits[1]!.id).toBe('k2');
  });

  it('turns ports into pin parts labelled with the port names and set to the right width', () => {
    const p = project(ALL.adder!.source, 'add');
    const pins = Object.values(p.circuits[0]!.components).filter((k) => k.type === 'pin');
    expect(pins.map((k) => [k.label, k.props.io, k.props.bits])).toEqual([
      ['a', 'in', 8],
      ['b', 'in', 8],
      ['y', 'out', 9],
    ]);
  });

  it('lowers a module with no ports and no cells to an empty circuit', () => {
    const p = project('module m; endmodule', 'm');
    expect(Object.keys(p.circuits[0]!.components)).toEqual([]);
  });

  it('refuses a literal with unknown bits, which a library constant cannot hold', () => {
    const design: Design = {
      top: 'm',
      modules: [
        {
          name: 'm',
          ports: [{ name: 'y', dir: 'out', width: 2, net: 0 }],
          nets: [{ id: 0, width: 2, names: ['y'] }],
          cells: [{ kind: 'const', out: 0, bits: '1x' }],
        },
      ],
    };
    expect(() => lowerToProject(design)).toThrow(LowerError);
  });
});
