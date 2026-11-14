import { describe, expect, it } from 'vitest';
import type { Cell, Design, Net, Port } from '../src/design';
import { IrSim, Interp, runDesign } from '../src/interp';

/** A one-module design: `ins` are input ports, `nets` are the rest, `outs` name nets that become output ports. */
function design(spec: { ins?: [string, number][]; nets?: (number | [number, Net['kind']])[]; cells: Cell[]; outs: string[] }): Design {
  const nets: Net[] = [];
  const ports: Port[] = [];
  for (const [name, width] of spec.ins ?? []) {
    nets.push({ id: nets.length, width, names: [name] });
    ports.push({ name, dir: 'in', width, net: nets.length - 1 });
  }
  const base = nets.length;
  for (const n of spec.nets ?? []) {
    const [width, kind] = typeof n === 'number' ? [n, undefined] : n;
    nets.push({ id: nets.length, width, names: [], ...(kind ? { kind } : {}) });
  }
  return { top: 't', modules: [{ name: 't', ports: [...ports, ...spec.outs.map((o, i) => ({ name: `o${i}`, dir: 'out' as const, width: nets[base + Number(o)]!.width, net: base + Number(o) }))], nets, cells: spec.cells }] };
}

/** Evaluate a combinational one-output design with constant inputs given as bit strings. */
function comb(kind: Cell['kind'], widths: number[], outWidth: number, values: string[]): string {
  const ins = values.map((_, i): [string, number] => [`i${i}`, widths[i]!]);
  const out = ins.length;
  const cell = { kind, out } as Record<string, unknown>;
  if (kind === 'shl' || kind === 'shr' || kind === 'sshr') Object.assign(cell, { a: 0, amount: 1 });
  else if (kind === 'not' || kind.startsWith('reduce')) Object.assign(cell, { a: 0 });
  else Object.assign(cell, { a: 0, b: 1 });
  const d: Design = design({ ins, nets: [outWidth], cells: [cell as unknown as Cell], outs: ['0'] });
  const sim = new Interp(d);
  values.forEach((v, i) => sim.set(`i${i}`, v));
  return sim.value('o0');
}

const bin = (n: number, w: number) => (n & (2 ** w - 1)).toString(2).padStart(w, '0');

describe('signed division and remainder', () => {
  it('truncates toward zero and gives the remainder the sign of the dividend: -8 / 3 and -8 % 3', () => {
    expect(comb('divs', [4, 4], 4, [bin(-8, 4), bin(3, 4)])).toBe(bin(-2, 4));
    expect(comb('rems', [4, 4], 4, [bin(-8, 4), bin(3, 4)])).toBe(bin(-2, 4));
  });
  it('covers every sign combination', () => {
    for (const [a, b] of [[7, -2], [-7, 2], [-7, -2], [7, 2], [0, -3], [-1, 1], [5, 5]] as const) {
      expect(comb('divs', [4, 4], 4, [bin(a, 4), bin(b, 4)]), `${a} / ${b}`).toBe(bin(Math.trunc(a / b), 4));
      expect(comb('rems', [4, 4], 4, [bin(a, 4), bin(b, 4)]), `${a} % ${b}`).toBe(bin(a % b, 4));
    }
  });
  it('wraps the one overflow, the minimum divided by -1: the quotient is the minimum again and the remainder is 0', () => {
    expect(comb('divs', [4, 4], 4, ['1000', '1111'])).toBe('1000');
    expect(comb('rems', [4, 4], 4, ['1000', '1111'])).toBe('0000');
    expect(comb('divs', [1, 1], 1, ['1', '1'])).toBe('1');
  });
  it('gives x for a zero divisor and for any unknown input bit, in every division cell', () => {
    for (const kind of ['divu', 'remu', 'divs', 'rems'] as const) {
      expect(comb(kind, [4, 4], 4, ['0101', '0000'])).toBe('xxxx');
      expect(comb(kind, [4, 4], 4, ['01z1', '0011'])).toBe('xxxx');
    }
  });
  it('unsigned division is not signed division', () => {
    expect(comb('divu', [4, 4], 4, ['1000', '0011'])).toBe(bin(2, 4));
    expect(comb('remu', [4, 4], 4, ['1000', '0011'])).toBe(bin(2, 4));
  });
});

describe('shifts and comparisons', () => {
  it('sshr fills with the sign bit, shl and shr with 0, and a shift by the width or more gives only fill', () => {
    expect(comb('sshr', [4, 2], 4, ['1010', '01'])).toBe('1101');
    expect(comb('sshr', [4, 3], 4, ['1010', '100'])).toBe('1111');
    expect(comb('sshr', [4, 3], 4, ['0110', '111'])).toBe('0000');
    expect(comb('shl', [4, 3], 4, ['0011', '010'])).toBe('1100');
    expect(comb('shl', [4, 3], 4, ['1111', '100'])).toBe('0000');
    expect(comb('shr', [4, 5], 4, ['1111', '10000'])).toBe('0000');
    expect(comb('shr', [4, 2], 4, ['1010', '01'])).toBe('0101');
  });
  it('an unknown amount bit makes every output bit x, an unknown data bit only moves', () => {
    expect(comb('shl', [4, 2], 4, ['0011', '0z'])).toBe('xxxx');
    expect(comb('shr', [4, 2], 4, ['x011', '01'])).toBe('0x01');
    expect(comb('sshr', [4, 2], 4, ['x011', '01'])).toBe('xx01');
  });
  it('lts orders two complement numbers and ltu orders unsigned ones', () => {
    expect(comb('lts', [4, 4], 1, [bin(-1, 4), bin(0, 4)])).toBe('1');
    expect(comb('ltu', [4, 4], 1, [bin(-1, 4), bin(0, 4)])).toBe('0');
    expect(comb('lts', [4, 4], 1, [bin(-8, 4), bin(7, 4)])).toBe('1');
    expect(comb('lts', [4, 4], 1, [bin(3, 4), bin(3, 4)])).toBe('0');
    expect(comb('lts', [4, 4], 1, ['x000', '0000'])).toBe('x');
  });
  it('eq decides on a known difference and is x only when the rest is unknown', () => {
    expect(comb('eq', [2, 2], 1, ['1x', '0x'])).toBe('0');
    expect(comb('eq', [2, 2], 1, ['1x', '1x'])).toBe('x');
    expect(comb('ne', [2, 2], 1, ['1x', '0x'])).toBe('1');
  });
  it('reductions follow the Verilog tables', () => {
    expect(comb('reduce_or', [3], 1, ['1x0'])).toBe('1');
    expect(comb('reduce_or', [3], 1, ['0x0'])).toBe('x');
    expect(comb('reduce_and', [3], 1, ['0x1'])).toBe('0');
    expect(comb('reduce_xor', [3], 1, ['0x1'])).toBe('x');
    expect(comb('reduce_xor', [3], 1, ['011'])).toBe('0');
  });
  it('sub and mul wrap and any unknown bit makes the result x', () => {
    expect(comb('sub', [4, 4], 4, ['0010', '0101'])).toBe(bin(-3, 4));
    expect(comb('mul', [4, 4], 4, ['0111', '0011'])).toBe(bin(21, 4));
    expect(comb('mul', [4, 4], 4, ['01x1', '0000'])).toBe('xxxx');
    expect(comb('sub', [4, 4], 4, ['0010', '01z1'])).toBe('xxxx');
  });
});

const CLK_DESIGN = (cells: Cell[], nets: (number | [number, Net['kind']])[], outs: string[], ins: [string, number][] = []) => design({ ins: [['clk', 1], ...ins], nets, cells, outs });

describe('registers', () => {
  it('a dff is x until its first edge, loads on the chosen edge only, and ignores the power-on clock', () => {
    const d = CLK_DESIGN(
      [
        { kind: 'dff', clk: 0, edge: 'pos', d: 1, q: 2 },
        { kind: 'dff', clk: 0, edge: 'neg', d: 1, q: 3 },
      ],
      [2, 2],
      ['0', '1'],
      [['d', 2]],
    );
    // nets: 0 clk, 1 d, 2 q(pos), 3 q(neg)
    const sim = new Interp(d);
    expect([sim.value('o0'), sim.value('o1')]).toEqual(['xx', 'xx']);
    sim.set('d', '10');
    sim.set('clk', 1);
    expect([sim.value('o0'), sim.value('o1')]).toEqual(['10', 'xx']);
    sim.set('d', '01');
    sim.set('clk', 0);
    expect([sim.value('o0'), sim.value('o1')]).toEqual(['10', '01']);
  });

  it('all registers sample before any changes: a swap through two registers works', () => {
    const d = CLK_DESIGN(
      [
        { kind: 'dff', clk: 0, edge: 'pos', d: 2, q: 1 },
        { kind: 'dff', clk: 0, edge: 'pos', d: 1, q: 2 },
      ],
      [1, 1],
      ['0', '1'],
    );
    const sim = new Interp(d, { powerOn: '0' });
    expect([sim.value('o0'), sim.value('o1')]).toEqual(['0', '0']);
    const e = CLK_DESIGN(
      [
        { kind: 'const', out: 3, bits: '1' },
        { kind: 'dff', clk: 0, edge: 'pos', d: 3, q: 1 },
        { kind: 'dff', clk: 0, edge: 'pos', d: 1, q: 2 },
      ],
      [1, 1, 1],
      ['0', '1'],
    );
    const s2 = new Interp(e, { powerOn: '0' });
    s2.set('clk', 1);
    expect([s2.value('o0'), s2.value('o1')]).toEqual(['1', '0']);
    s2.set('clk', 0);
    s2.set('clk', 1);
    expect([s2.value('o0'), s2.value('o1')]).toEqual(['1', '1']);
  });

  it('an adff is at its reset value from time 0 while the reset is active, and an unknown reset merges', () => {
    const nets: Net[] = [
      { id: 0, width: 1, names: ['clk'] },
      { id: 1, width: 4, names: ['d'] },
      { id: 2, width: 1, names: ['rst'] },
      { id: 3, width: 4, names: [] },
      { id: 4, width: 1, names: [] },
    ];
    const mk = (arst: number): Design => ({
      top: 't',
      modules: [
        {
          name: 't',
          ports: [
            { name: 'clk', dir: 'in', width: 1, net: 0 },
            { name: 'd', dir: 'in', width: 4, net: 1 },
            { name: 'rst', dir: 'in', width: 1, net: 2 },
            { name: 'q', dir: 'out', width: 4, net: 3 },
          ],
          nets,
          cells: [{ kind: 'adff', clk: 0, edge: 'pos', arst, arstLevel: 0, arstValue: '1010', d: 1, q: 3 }],
        },
      ],
    });
    const sim = new Interp(mk(2));
    expect(sim.value('q')).toBe('1010');
    sim.set('rst', 1);
    expect(sim.value('q')).toBe('xxxx');
    sim.set('d', '0110');
    sim.set('clk', 1);
    expect(sim.value('q')).toBe('0110');
    sim.set('rst', 0);
    expect(sim.value('q')).toBe('1010');
    const floating = new Interp(mk(4));
    floating.set('d', '1000');
    floating.set('clk', 1);
    expect(floating.value('q')).toBe('10x0');
  });

  it('a latch follows d while enabled, holds otherwise, and merges when the enable is unknown', () => {
    const nets: Net[] = [
      { id: 0, width: 1, names: ['en'] },
      { id: 1, width: 2, names: ['d'] },
      { id: 2, width: 2, names: [] },
      { id: 3, width: 2, names: [] },
    ];
    const d: Design = {
      top: 't',
      modules: [
        {
          name: 't',
          ports: [
            { name: 'en', dir: 'in', width: 1, net: 0 },
            { name: 'd', dir: 'in', width: 2, net: 1 },
            { name: 'q', dir: 'out', width: 2, net: 2 },
            { name: 'ql', dir: 'out', width: 2, net: 3 },
          ],
          nets,
          cells: [
            { kind: 'latch', en: 0, enLevel: 1, d: 1, q: 2 },
            { kind: 'latch', en: 0, enLevel: 0, d: 1, q: 3 },
          ],
        },
      ],
    };
    const sim = new Interp(d);
    expect([sim.value('q'), sim.value('ql')]).toEqual(['xx', '00']);
    sim.set('d', '11');
    expect([sim.value('q'), sim.value('ql')]).toEqual(['xx', '11']);
    sim.set('en', 1);
    expect([sim.value('q'), sim.value('ql')]).toEqual(['11', '11']);
    sim.set('d', '01');
    sim.set('en', 0);
    sim.set('d', '10');
    expect([sim.value('q'), sim.value('ql')]).toEqual(['01', '10']);
  });
});

function memoryDesign(extra: Partial<Extract<Cell, { kind: 'memory' }>>): Design {
  const nets: Net[] = [
    { id: 0, width: 1, names: ['clk'] },
    { id: 1, width: 2, names: ['wa'] },
    { id: 2, width: 3, names: ['wd'] },
    { id: 3, width: 1, names: ['we'] },
    { id: 4, width: 2, names: ['ra'] },
    { id: 5, width: 3, names: [] },
    { id: 6, width: 3, names: [] },
  ];
  return {
    top: 't',
    modules: [
      {
        name: 't',
        ports: [
          { name: 'clk', dir: 'in', width: 1, net: 0 },
          { name: 'wa', dir: 'in', width: 2, net: 1 },
          { name: 'wd', dir: 'in', width: 3, net: 2 },
          { name: 'we', dir: 'in', width: 1, net: 3 },
          { name: 'ra', dir: 'in', width: 2, net: 4 },
          { name: 'async', dir: 'out', width: 3, net: 5 },
          { name: 'sync', dir: 'out', width: 3, net: 6 },
        ],
        nets,
        cells: [
          {
            kind: 'memory',
            name: 'm',
            width: 3,
            depth: 3,
            readPorts: [{ addr: 4, data: 5 }, { addr: 4, data: 6, clk: 0, edge: 'pos' }],
            writePorts: [{ addr: 1, data: 2, en: 3, clk: 0, edge: 'pos' }],
            ...extra,
          },
        ],
      },
    ],
  };
}

describe('memories', () => {
  it('words start as x unless init gives them, an address past the depth reads x, and a read port is asynchronous or registered', () => {
    const sim = new Interp(memoryDesign({ init: ['101'] }));
    sim.set('ra', '00');
    expect([sim.value('async'), sim.value('sync')]).toEqual(['101', 'xxx']);
    sim.set('ra', '01');
    expect(sim.value('async')).toBe('xxx');
    sim.set('ra', '11');
    expect(sim.value('async')).toBe('xxx');
  });

  it('a synchronous read returns the OLD word when the same edge writes it', () => {
    const sim = new Interp(memoryDesign({ init: ['101'] }));
    sim.set('ra', '00');
    sim.set('wa', '00');
    sim.set('wd', '010');
    sim.set('we', 1);
    sim.set('clk', 1);
    expect([sim.value('async'), sim.value('sync')]).toEqual(['010', '101']);
    sim.set('clk', 0);
    sim.set('clk', 1);
    expect(sim.value('sync')).toBe('010');
  });

  it('a write needs the enable, and an address past the depth writes nothing', () => {
    const sim = new Interp(memoryDesign({ init: ['000', '000', '000'] }));
    sim.set('wd', '111');
    sim.set('wa', '01');
    sim.set('clk', 1);
    sim.set('clk', 0);
    sim.set('ra', '01');
    expect(sim.value('async')).toBe('000');
    sim.set('we', 1);
    sim.set('wa', '11');
    sim.set('clk', 1);
    sim.set('clk', 0);
    for (const a of ['00', '01', '10']) {
      sim.set('ra', a);
      expect(sim.value('async')).toBe('000');
    }
    sim.set('wa', '10');
    sim.set('clk', 1);
    sim.set('ra', '10');
    expect(sim.value('async')).toBe('111');
  });

  it('with two write ports on one word the later port wins', () => {
    const d = memoryDesign({ init: ['000'] });
    const m = d.modules[0]!;
    m.nets.push({ id: 7, width: 3, names: ['wd2'] });
    m.ports.push({ name: 'wd2', dir: 'in', width: 3, net: 7 });
    const cell = m.cells[0] as Extract<Cell, { kind: 'memory' }>;
    cell.writePorts.push({ addr: 1, data: 7, en: 3, clk: 0, edge: 'pos' });
    const sim = new Interp(d);
    sim.set('wd', '001');
    sim.set('wd2', '110');
    sim.set('we', 1);
    sim.set('clk', 1);
    sim.set('ra', '00');
    expect(sim.value('async')).toBe('110');
  });
});

describe('nets with several drivers', () => {
  function tri(kind: Net['kind'], drivers: [string, string][]) {
    // nets: one 2-bit data net and one enable per driver, then the shared net
    const nets: Net[] = [];
    const ports: Port[] = [];
    const cells: Cell[] = [];
    const shared = drivers.length * 2;
    drivers.forEach((_, i) => {
      nets.push({ id: i * 2, width: 2, names: [`a${i}`] }, { id: i * 2 + 1, width: 1, names: [`e${i}`] });
      ports.push({ name: `a${i}`, dir: 'in', width: 2, net: i * 2 }, { name: `e${i}`, dir: 'in', width: 1, net: i * 2 + 1 });
      cells.push({ kind: 'tribuf', a: i * 2, en: i * 2 + 1, out: shared });
    });
    nets.push({ id: shared, width: 2, names: [], ...(kind ? { kind } : {}) });
    ports.push({ name: 'y', dir: 'out', width: 2, net: shared });
    const sim = new Interp({ top: 't', modules: [{ name: 't', ports, nets, cells }] });
    drivers.forEach(([a, e], i) => {
      sim.set(`a${i}`, a);
      sim.set(`e${i}`, e);
    });
    return sim.value('y');
  }
  it('a wire lets z yield, agrees on equal values and is x on different ones', () => {
    expect(tri('wire', [['10', '1'], ['01', '0']])).toBe('10');
    expect(tri('wire', [['10', '0'], ['01', '0']])).toBe('zz');
    expect(tri('wire', [['10', '1'], ['10', '1']])).toBe('10');
    expect(tri('wire', [['10', '1'], ['11', '1']])).toBe('1x');
  });
  it('wand ANDs and wor ORs the driven values, and an all-z bit stays z', () => {
    expect(tri('wand', [['11', '1'], ['01', '1']])).toBe('01');
    expect(tri('wor', [['10', '1'], ['01', '1']])).toBe('11');
    expect(tri('wand', [['11', '1'], ['01', '0']])).toBe('11');
    expect(tri('wand', [['11', '0'], ['01', '0']])).toBe('zz');
  });
  it('pull0 and pull1 turn z into a level and supply nets are constants', () => {
    expect(tri('pull1', [['00', '0']])).toBe('11');
    expect(tri('pull0', [['11', '0']])).toBe('00');
    expect(tri('pull1', [['00', '1']])).toBe('00');
    expect(tri('supply1', [['00', '1']])).toBe('11');
    expect(tri('supply0', [['11', '1']])).toBe('00');
  });
});

describe('runDesign follows the cycle-trace protocol', () => {
  it('samples before and after the rising edge and reports the registered value only after it', () => {
    const nets: Net[] = [
      { id: 0, width: 1, names: ['clk'] },
      { id: 1, width: 1, names: ['d'] },
      { id: 2, width: 1, names: [] },
    ];
    const r = runDesign({
      design: { top: 't', modules: [{ name: 't', ports: [{ name: 'clk', dir: 'in', width: 1, net: 0 }, { name: 'd', dir: 'in', width: 1, net: 1 }, { name: 'q', dir: 'out', width: 1, net: 2 }], nets, cells: [{ kind: 'dff', clk: 0, edge: 'pos', d: 1, q: 2 }] }] },
      clock: 'clk',
      stimulus: [{ d: '1' }, { d: '0' }],
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.cycles).toEqual([{ pre: { q: 'x' }, post: { q: '1' } }, { pre: { q: '1' }, post: { q: '0' } }]);
  });
  it('rejects stimulus for the clock or with the wrong width', () => {
    const nets: Net[] = [{ id: 0, width: 1, names: ['clk'] }, { id: 1, width: 2, names: ['a'] }];
    const design: Design = { top: 't', modules: [{ name: 't', ports: [{ name: 'clk', dir: 'in', width: 1, net: 0 }, { name: 'a', dir: 'in', width: 2, net: 1 }], nets, cells: [] }] };
    expect(runDesign({ design, clock: 'clk', stimulus: [{ clk: '1' }] })).toMatchObject({ ok: false });
    expect(runDesign({ design, clock: 'clk', stimulus: [{ a: '1' }] })).toMatchObject({ ok: false });
  });
});

describe('IrSim, the two-state view', () => {
  it('starts registers at 0, takes numbers and returns unsigned values', () => {
    const nets: Net[] = [
      { id: 0, width: 1, names: ['clk'] },
      { id: 1, width: 4, names: ['a'] },
      { id: 2, width: 4, names: [] },
      { id: 3, width: 4, names: [] },
    ];
    const d: Design = {
      top: 't',
      modules: [
        {
          name: 't',
          ports: [{ name: 'clk', dir: 'in', width: 1, net: 0 }, { name: 'a', dir: 'in', width: 4, net: 1 }, { name: 'q', dir: 'out', width: 4, net: 2 }, { name: 's', dir: 'out', width: 4, net: 3 }],
          nets,
          cells: [{ kind: 'dff', clk: 0, edge: 'pos', d: 1, q: 2 }, { kind: 'add', a: 1, b: 2, out: 3 }],
        },
      ],
    };
    const sim = new IrSim(d);
    expect(sim.get('q')).toBe(0n);
    sim.set('a', 5);
    expect(sim.get('s')).toBe(5n);
    sim.tick('clk');
    expect([sim.get('q'), sim.get('s')]).toEqual([5n, 10n]);
  });
});
