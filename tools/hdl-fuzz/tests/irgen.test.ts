import { cellInputs, cellOutputs, isStateful, type Cell, type Design, type Module } from '@ihatecircuits/hdl/design';
import { describe, expect, it } from 'vitest';
import { generateIrCase } from '../src/irgen';

const ALL_KINDS: Cell['kind'][] = [
  'const', 'not', 'and', 'or', 'xor', 'xnor', 'add', 'sub', 'mul', 'divu', 'remu', 'divs', 'rems', 'shl', 'shr', 'sshr', 'eq', 'ne', 'ltu', 'lts',
  'reduce_and', 'reduce_or', 'reduce_xor', 'mux', 'concat', 'slice', 'dff', 'adff', 'latch', 'tribuf', 'memory', 'instance',
];

/** Problems with a module under the rules in design.ts and the generator's own promises. */
function problems(d: Design, m: Module): string[] {
  const out: string[] = [];
  const width = (n: number) => m.nets[n]!.width;
  const drivers = new Map<number, Cell['kind'][]>();
  for (const p of m.ports) if (p.dir === 'in') drivers.set(p.net, [...(drivers.get(p.net) ?? []), 'const']);
  for (const c of m.cells) for (const n of cellOutputs(c)) drivers.set(n, [...(drivers.get(n) ?? []), c.kind]);
  for (const [net, kinds] of drivers) {
    const nonTri = kinds.filter((k) => k !== 'tribuf');
    if (kinds.length > 1 && nonTri.length > 1) out.push(`net ${net} has ${nonTri.length} ordinary drivers`);
    if (kinds.length > 1 && m.nets[net]!.kind === undefined && kinds.includes('tribuf') === false) out.push(`net ${net} has several drivers`);
  }
  for (const c of m.cells) {
    for (const n of [...cellInputs(c), ...cellOutputs(c)]) if (n < 0 || n >= m.nets.length) out.push(`${c.kind} names net ${n}`);
    if ('a' in c && 'b' in c) {
      if (width(c.a) !== width(c.b)) out.push(`${c.kind} operands differ in width`);
    }
    if (c.kind === 'instance') {
      const callee = d.modules.find((x) => x.name === c.module);
      if (!callee) out.push(`instance of unknown ${c.module}`);
      else for (const [port, net] of Object.entries(c.inputs)) if (callee.ports.find((p) => p.name === port)!.width !== width(net)) out.push(`instance ${c.name} port ${port} width`);
    }
  }
  // Combinational loops may only go through stateful cells.
  const producer = new Map<number, Cell>();
  for (const c of m.cells) if (!isStateful(c)) for (const n of cellOutputs(c)) producer.set(n, c);
  const state = new Map<Cell, 1 | 2>();
  const visit = (c: Cell): boolean => {
    if (state.get(c) === 2) return false;
    if (state.get(c) === 1) return true;
    state.set(c, 1);
    for (const n of cellInputs(c)) {
      const p = producer.get(n);
      if (p && visit(p)) return true;
    }
    state.set(c, 2);
    return false;
  };
  if (m.cells.some((c) => !isStateful(c) && c.kind !== 'instance' && visit(c))) out.push('combinational loop');
  return out;
}

describe('generateIrCase', () => {
  it('is deterministic in the seed and different between seeds', () => {
    expect(JSON.stringify(generateIrCase(11))).toBe(JSON.stringify(generateIrCase(11)));
    expect(JSON.stringify(generateIrCase(11))).not.toBe(JSON.stringify(generateIrCase(12)));
    expect(JSON.stringify(generateIrCase(11, { size: 8 }))).not.toBe(JSON.stringify(generateIrCase(11, { size: 2 })));
  });

  it('produces valid designs: one ordinary driver per net, matching widths, loops only through state', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const c = generateIrCase(seed, { size: 1 + (seed % 8) });
      expect(c.design.top).toBe('top');
      for (const m of c.design.modules) expect(problems(c.design, m), `seed ${seed} module ${m.name}`).toEqual([]);
      const top = c.design.modules.find((m) => m.name === 'top')!;
      expect(top.ports.some((p) => p.name === c.clock && p.dir === 'in' && p.width === 1)).toBe(true);
      for (const cycle of c.stimulus) for (const [name, value] of Object.entries(cycle)) expect(value).toMatch(new RegExp(`^[01]{${top.ports.find((p) => p.name === name)!.width}}$`));
    }
  });

  it('uses every cell kind and every net kind within a few hundred seeds, and several modules with instances', () => {
    const kinds = new Set<string>();
    const netKinds = new Set<string>();
    let modules = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { design } = generateIrCase(seed);
      modules = Math.max(modules, design.modules.length);
      for (const m of design.modules) {
        for (const c of m.cells) kinds.add(c.kind);
        for (const n of m.nets) if (n.kind) netKinds.add(n.kind);
      }
    }
    expect([...kinds].sort()).toEqual([...ALL_KINDS].sort());
    expect([...netKinds].sort()).toEqual(['pull0', 'pull1', 'supply0', 'supply1', 'wand', 'wor']);
    expect(modules).toBeGreaterThanOrEqual(3);
  });

  it('uses memories with both read-port kinds, write ports, initial contents and loops', () => {
    let async = 0;
    let sync = 0;
    let writes = 0;
    let init = 0;
    let twoWrites = 0;
    for (let seed = 1; seed <= 300; seed++) {
      for (const m of generateIrCase(seed).design.modules) {
        for (const c of m.cells) {
          if (c.kind !== 'memory') continue;
          for (const r of c.readPorts) r.clk === undefined ? async++ : sync++;
          writes += c.writePorts.length;
          if (c.writePorts.length > 1) twoWrites++;
          if (c.init) init++;
        }
      }
    }
    expect([async, sync, writes, init, twoWrites].every((n) => n > 0)).toBe(true);
  });
});

describe('IR generator power-on values', () => {
  it('gives dff, adff and latch cells an init sometimes, over 0 1 x and of the width of q, and an adff init agrees with its reset value', () => {
    const seen = { dff: 0, adff: 0, latch: 0, partialX: 0, bare: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const { design } = generateIrCase(seed);
      for (const m of design.modules) {
        for (const c of m.cells) {
          if (c.kind !== 'dff' && c.kind !== 'adff' && c.kind !== 'latch') continue;
          if (c.init === undefined) {
            seen.bare++;
            continue;
          }
          seen[c.kind]++;
          expect(c.init).toMatch(/^[01x]+$/);
          expect(c.init.length).toBe(m.nets[c.q]!.width);
          if (/x/.test(c.init) && /[01]/.test(c.init)) seen.partialX++;
          if (c.kind === 'adff') for (let i = 0; i < c.init.length; i++) if (c.init[i] !== 'x') expect(c.init[i]).toBe(c.arstValue[i]);
        }
      }
    }
    expect(seen.dff).toBeGreaterThan(20);
    expect(seen.adff).toBeGreaterThan(10);
    expect(seen.latch).toBeGreaterThan(10);
    expect(seen.partialX).toBeGreaterThan(5);
    expect(seen.bare).toBeGreaterThan(50);
  });
});
