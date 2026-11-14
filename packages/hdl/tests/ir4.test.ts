import { describe, expect, it } from 'vitest';
import type { Cell, Design, Module, Net, NetId } from '../src/design';
import { Ir4Sim, ir4Runner } from './ir4';

class M {
  nets: Net[] = [];
  ports: Module['ports'] = [];
  cells: Cell[] = [];

  net(width: number, kind?: Net['kind']): NetId {
    const id = this.nets.length;
    this.nets.push({ id, width, names: [], ...(kind ? { kind } : {}) });
    return id;
  }

  input(name: string, width: number): NetId {
    const net = this.net(width);
    this.ports.push({ name, dir: 'in', width, net });
    return net;
  }

  output(name: string, net: NetId): void {
    this.ports.push({ name, dir: 'out', width: this.nets[net]!.width, net });
  }

  add<C extends Cell>(c: C): C {
    this.cells.push(c);
    return c;
  }

  width(net: NetId): number {
    return this.nets[net]!.width;
  }

  un(kind: 'not' | 'reduce_and' | 'reduce_or' | 'reduce_xor', a: NetId): NetId {
    const out = this.net(kind === 'not' ? this.width(a) : 1);
    this.add({ kind, a, out } as Cell);
    return out;
  }

  bin(kind: string, a: NetId, b: NetId): NetId {
    const one = kind === 'eq' || kind === 'ne' || kind === 'ltu' || kind === 'lts';
    const out = this.net(one ? 1 : this.width(a));
    this.add({ kind, a, b, out } as Cell);
    return out;
  }

  shift(kind: 'shl' | 'shr' | 'sshr', a: NetId, amount: NetId): NetId {
    const out = this.net(this.width(a));
    this.add({ kind, a, amount, out });
    return out;
  }

  const(bits: string): NetId {
    const out = this.net(bits.length);
    this.add({ kind: 'const', out, bits });
    return out;
  }

  build(name = 'top'): Module {
    return { name, ports: this.ports, nets: this.nets, cells: this.cells };
  }
}

const design = (top: Module, ...callees: Module[]): Design => ({ modules: [...callees, top], top: top.name });

function run(build: (m: M, ins: NetId[]) => NetId, ...ins: string[]): string {
  const m = new M();
  const nets = ins.map((v, i) => m.input(`i${i}`, v.length));
  m.output('y', build(m, nets));
  const sim = new Ir4Sim(design(m.build()));
  ins.forEach((v, i) => sim.set(`i${i}`, v));
  return sim.get('y');
}

const binary = (kind: string) => (a: string, b: string) => run((m, [x, y]) => m.bin(kind, x!, y!), a, b);
const shifter = (kind: 'shl' | 'shr' | 'sshr') => (a: string, amt: string) => run((m, [x, y]) => m.shift(kind, x!, y!), a, amt);
const unary = (kind: 'not' | 'reduce_and' | 'reduce_or' | 'reduce_xor') => (a: string) => run((m, [x]) => m.un(kind, x!), a);

describe('bitwise cells follow the Verilog four-state tables', () => {
  it.each([
    ['and', '0', 'x', '0'],
    ['and', '1', 'x', 'x'],
    ['and', 'x', 'x', 'x'],
    ['and', 'z', '1', 'x'],
    ['and', 'z', '0', '0'],
    ['or', '1', 'x', '1'],
    ['or', '0', 'x', 'x'],
    ['or', 'z', '0', 'x'],
    ['xor', '1', 'x', 'x'],
    ['xor', '0', 'x', 'x'],
    ['xor', '1', '1', '0'],
    ['xnor', '1', '1', '1'],
    ['xnor', 'x', '1', 'x'],
    ['xnor', '0', '1', '0'],
  ])('%s(%s, %s) = %s', (kind, a, b, want) => {
    expect(binary(kind)(a, b)).toBe(want);
  });

  it('works bit by bit across a word', () => {
    expect(binary('and')('01xz', '1111')).toBe('01xx');
    expect(binary('or')('01xz', '0000')).toBe('01xx');
    expect(binary('and')('x0x0', '0x1x')).toBe('00x0');
  });

  it('not maps x and z to x', () => {
    expect(unary('not')('01xz')).toBe('10xx');
  });
});

describe('eq and ne', () => {
  it('a known differing bit decides', () => {
    expect(binary('eq')('10x', '011')).toBe('0');
    expect(binary('ne')('10x', '011')).toBe('1');
  });
  it('otherwise unknown bits give x', () => {
    expect(binary('eq')('1x', '10')).toBe('x');
    expect(binary('ne')('1x', '10')).toBe('x');
    expect(binary('eq')('zz', '00')).toBe('x');
  });
  it('known equal operands', () => {
    expect(binary('eq')('11', '11')).toBe('1');
    expect(binary('ne')('11', '11')).toBe('0');
  });
});

describe('mux', () => {
  const mux = (sel: string, f: string, t: string) =>
    run((m, [s, a, b]) => {
      const out = m.net(f.length);
      m.add({ kind: 'mux', sel: s!, onFalse: a!, onTrue: b!, out });
      return out;
    }, sel, f, t);

  it('selects with a known sel', () => {
    expect(mux('0', '1010', '0101')).toBe('1010');
    expect(mux('1', '1010', '0101')).toBe('0101');
    expect(mux('0', '1x10', '0101')).toBe('1x10');
  });
  it('merges bitwise with an unknown sel', () => {
    expect(mux('x', '1010', '1001')).toBe('10xx');
    expect(mux('z', '1010', '1001')).toBe('10xx');
    expect(mux('x', '1x10', '1x10')).toBe('1x10');
  });
});

describe('arithmetic', () => {
  it('add, sub and mul wrap modulo the width', () => {
    expect(binary('add')('0011', '0001')).toBe('0100');
    expect(binary('add')('1111', '0001')).toBe('0000');
    expect(binary('sub')('0000', '0001')).toBe('1111');
    expect(binary('mul')('0011', '0101')).toBe('1111');
    expect(binary('mul')('1111', '1111')).toBe('0001');
  });
  it('any unknown input bit makes every output bit x', () => {
    expect(binary('add')('00x1', '0001')).toBe('xxxx');
    expect(binary('sub')('0001', '000z')).toBe('xxxx');
    expect(binary('mul')('0000', '000x')).toBe('xxxx');
  });
  it('unsigned division and remainder', () => {
    expect(binary('divu')('0111', '0010')).toBe('0011');
    expect(binary('remu')('0111', '0010')).toBe('0001');
  });
  it('signed division truncates toward zero and the remainder takes the dividend sign', () => {
    expect(binary('divs')('1001', '0010')).toBe('1101');
    expect(binary('rems')('1001', '0010')).toBe('1111');
    expect(binary('divs')('0111', '1110')).toBe('1101');
    expect(binary('rems')('0111', '1110')).toBe('0001');
    expect(binary('divs')('1000', '1111')).toBe('1000');
    expect(binary('rems')('1000', '1111')).toBe('0000');
  });
  it('division by zero or an unknown bit gives x', () => {
    for (const k of ['divu', 'remu', 'divs', 'rems']) {
      expect(binary(k)('0111', '0000')).toBe('xxxx');
      expect(binary(k)('01x1', '0010')).toBe('xxxx');
    }
  });
});

describe('shifts', () => {
  it('shifts in zeros, or the sign bit for sshr', () => {
    expect(shifter('shl')('0011', '01')).toBe('0110');
    expect(shifter('shr')('1100', '10')).toBe('0011');
    expect(shifter('sshr')('1000', '01')).toBe('1100');
    expect(shifter('sshr')('0100', '01')).toBe('0010');
  });
  it('a shift by the width or more gives all fill bits', () => {
    expect(shifter('shl')('1111', '100')).toBe('0000');
    expect(shifter('shr')('1111', '1111')).toBe('0000');
    expect(shifter('sshr')('1000', '111')).toBe('1111');
    expect(shifter('sshr')('0100', '1001')).toBe('0000');
  });
  it('an unknown amount bit gives all x, an unknown data bit shifts along', () => {
    expect(shifter('shl')('0011', '0x')).toBe('xxxx');
    expect(shifter('shr')('0011', 'z1')).toBe('xxxx');
    expect(shifter('shl')('x001', '01')).toBe('0010');
    expect(shifter('shr')('x001', '01')).toBe('0x00');
    expect(shifter('sshr')('x001', '01')).toBe('xx00');
  });
});

describe('comparisons and reductions', () => {
  it('ltu and lts', () => {
    expect(binary('ltu')('0011', '0100')).toBe('1');
    expect(binary('ltu')('1111', '0001')).toBe('0');
    expect(binary('lts')('1111', '0001')).toBe('1');
    expect(binary('lts')('0100', '0100')).toBe('0');
    expect(binary('ltu')('0x11', '0100')).toBe('x');
    expect(binary('lts')('0011', '010z')).toBe('x');
  });
  it('reduce_and', () => {
    expect(unary('reduce_and')('111')).toBe('1');
    expect(unary('reduce_and')('0x1')).toBe('0');
    expect(unary('reduce_and')('1x1')).toBe('x');
  });
  it('reduce_or', () => {
    expect(unary('reduce_or')('000')).toBe('0');
    expect(unary('reduce_or')('1x0')).toBe('1');
    expect(unary('reduce_or')('0x0')).toBe('x');
  });
  it('reduce_xor', () => {
    expect(unary('reduce_xor')('101')).toBe('0');
    expect(unary('reduce_xor')('111')).toBe('1');
    expect(unary('reduce_xor')('1x')).toBe('x');
  });
});

describe('const, concat, slice and undriven nets', () => {
  it('concat puts parts[0] in the high bits and slice picks from lsb', () => {
    expect(run((m, [a, b]) => {
      const out = m.net(4);
      m.add({ kind: 'concat', parts: [a!, b!], out });
      return out;
    }, '10', 'x1')).toBe('10x1');
    expect(run((m, [a]) => {
      const out = m.net(2);
      m.add({ kind: 'slice', a: a!, lsb: 1, out });
      return out;
    }, '1011')).toBe('01');
  });
  it('a const keeps z at an output but cells read it as x', () => {
    const m = new M();
    const c = m.const('1z0x');
    m.output('raw', c);
    m.output('inv', m.un('not', c));
    const sim = new Ir4Sim(design(m.build()));
    expect(sim.get('raw')).toBe('1z0x');
    expect(sim.get('inv')).toBe('0x1x');
  });
  it('an undriven net reads z at an output and x to cells', () => {
    const m = new M();
    const n = m.net(3);
    m.output('raw', n);
    m.output('inv', m.un('not', n));
    const sim = new Ir4Sim(design(m.build()));
    expect(sim.get('raw')).toBe('zzz');
    expect(sim.get('inv')).toBe('xxx');
  });
  it('an input port that was never set reads x', () => {
    const m = new M();
    const a = m.input('a', 2);
    m.output('y', a);
    expect(new Ir4Sim(design(m.build())).get('y')).toBe('xx');
  });
});

describe('multi-driver nets and tribuf', () => {
  function bus(kind: Net['kind'], width = 2) {
    const m = new M();
    const a0 = m.input('a0', width);
    const e0 = m.input('e0', 1);
    const a1 = m.input('a1', width);
    const e1 = m.input('e1', 1);
    const n = m.net(width, kind);
    m.add({ kind: 'tribuf', a: a0, en: e0, out: n });
    m.add({ kind: 'tribuf', a: a1, en: e1, out: n });
    m.output('y', n);
    const sim = new Ir4Sim(design(m.build()));
    return (a: string, ea: string, b: string, eb: string) => sim.set('a0', a).set('e0', ea).set('a1', b).set('e1', eb).get('y');
  }

  it('wire: z yields, equal values agree, different values give x', () => {
    const y = bus('wire');
    expect(y('10', '1', '01', '0')).toBe('10');
    expect(y('10', '0', '01', '1')).toBe('01');
    expect(y('10', '1', '10', '1')).toBe('10');
    expect(y('10', '1', '11', '1')).toBe('1x');
    expect(y('10', '0', '01', '0')).toBe('zz');
    expect(y('1x', '1', '11', '1')).toBe('1x');
  });
  it('the default kind behaves as wire', () => {
    expect(bus(undefined)('10', '1', '11', '1')).toBe('1x');
  });
  it('tribuf: unknown en drives x where a is not z, z stays z', () => {
    const y = bus('wire');
    expect(y('1z', 'x', '00', '0')).toBe('xz');
    expect(y('10', 'z', '00', '0')).toBe('xx');
  });
  it('wand and wor combine driven values and ignore z', () => {
    const wand = bus('wand', 4);
    expect(wand('1100', '1', '1010', '1')).toBe('1000');
    expect(wand('1100', '1', '1010', '0')).toBe('1100');
    expect(wand('1x11', '1', '1111', '1')).toBe('1x11');
    expect(wand('0x11', '1', '1111', '1')).toBe('0x11');
    const wor = bus('wor', 4);
    expect(wor('1100', '1', '1010', '1')).toBe('1110');
    expect(wor('1x00', '1', '0000', '1')).toBe('1x00');
    expect(wor('0x00', '1', '0100', '1')).toBe('0100');
    expect(wor('0000', '0', '0000', '0')).toBe('zzzz');
  });
  it('pull0 and pull1 read a constant where every driver is z', () => {
    expect(bus('pull0')('10', '0', '01', '0')).toBe('00');
    expect(bus('pull1')('10', '0', '01', '0')).toBe('11');
    expect(bus('pull1')('1z', '1', '01', '0')).toBe('11');
    expect(bus('pull0')('10', '1', '11', '1')).toBe('1x');
  });
  it('pull nets read as their constant even to cells, supply nets are constant', () => {
    const m = new M();
    const p = m.net(2, 'pull1');
    const s0 = m.net(3, 'supply0');
    const s1 = m.net(3, 'supply1');
    m.output('p', p);
    m.output('s0', s0);
    m.output('s1', s1);
    m.output('np', m.un('not', p));
    const sim = new Ir4Sim(design(m.build()));
    expect(sim.get('p')).toBe('11');
    expect(sim.get('np')).toBe('00');
    expect(sim.get('s0')).toBe('000');
    expect(sim.get('s1')).toBe('111');
  });
  it('an input port and a tribuf may share a net', () => {
    const m = new M();
    const a = m.input('a', 2);
    const en = m.input('en', 1);
    const d = m.input('d', 2);
    m.add({ kind: 'tribuf', a: d, en, out: a });
    m.output('y', a);
    const sim = new Ir4Sim(design(m.build()));
    sim.set('a', '10').set('d', '10').set('en', '1');
    expect(sim.get('y')).toBe('10');
    sim.set('d', '11');
    expect(sim.get('y')).toBe('1x');
    sim.set('en', '0');
    expect(sim.get('y')).toBe('10');
  });
});

describe('dff', () => {
  function reg(edge: 'pos' | 'neg' = 'pos', width = 4) {
    const m = new M();
    const clk = m.input('clk', 1);
    const d = m.input('d', width);
    const q = m.net(width);
    m.add({ kind: 'dff', clk, edge, d, q });
    m.output('q', q);
    return new Ir4Sim(design(m.build()));
  }

  it('q is x before the first edge, then loads d on each edge and holds in between', () => {
    const sim = reg();
    sim.set('clk', '0').set('d', '1010');
    expect(sim.get('q')).toBe('xxxx');
    sim.tick('clk');
    expect(sim.get('q')).toBe('1010');
    sim.set('d', '0101');
    expect(sim.get('q')).toBe('1010');
    sim.tick('clk');
    expect(sim.get('q')).toBe('0101');
  });
  it('leaves the clock low after a tick', () => {
    const sim = reg();
    sim.set('d', '0001').tick('clk');
    expect(sim.get('clk')).toBe('0');
  });
  it('a clock that never had a known level ignores x -> 1, a known 0 -> 1 fires', () => {
    const sim = reg();
    sim.set('d', '1111');
    sim.set('clk', '1');
    expect(sim.get('q')).toBe('xxxx');
    sim.set('clk', '0');
    expect(sim.get('q')).toBe('xxxx');
    sim.set('clk', '1');
    expect(sim.get('q')).toBe('1111');
  });
  it('a falling edge does not fire a positive-edge flop', () => {
    const sim = reg();
    sim.set('clk', '1').set('d', '1111').set('clk', '0');
    expect(sim.get('q')).toBe('xxxx');
  });
  it('a negative-edge flop loads on 1 -> 0', () => {
    const sim = reg('neg');
    sim.set('clk', '0').set('d', '0110');
    sim.set('clk', '1');
    expect(sim.get('q')).toBe('xxxx');
    sim.set('clk', '0');
    expect(sim.get('q')).toBe('0110');
    sim.set('d', '1111').tick('clk', 'neg');
    expect(sim.get('q')).toBe('1111');
  });
  it('z and x on d load as x', () => {
    const sim = reg();
    sim.set('d', '1z0x').tick('clk');
    expect(sim.get('q')).toBe('1x0x');
  });
  it('a chain of flops shifts one stage per edge (D is sampled before the edge)', () => {
    const m = new M();
    const clk = m.input('clk', 1);
    const d = m.input('d', 2);
    const q1 = m.net(2);
    const q2 = m.net(2);
    m.add({ kind: 'dff', clk, edge: 'pos', d, q: q1 });
    m.add({ kind: 'dff', clk, edge: 'pos', d: q1, q: q2 });
    m.output('q2', q2);
    const sim = new Ir4Sim(design(m.build()));
    sim.set('d', '01').tick('clk');
    expect(sim.get('q2')).toBe('xx');
    sim.set('d', '10').tick('clk');
    expect(sim.get('q2')).toBe('01');
  });
  it('a flop behind a gated clock still sees the data from before the edge', () => {
    const m = new M();
    const clk = m.input('clk', 1);
    const en = m.input('en', 1);
    const d = m.input('d', 2);
    const gated = m.bin('and', clk, en);
    const qa = m.net(2);
    const qb = m.net(2);
    m.add({ kind: 'dff', clk, edge: 'pos', d, q: qa });
    m.add({ kind: 'dff', clk: gated, edge: 'pos', d: qa, q: qb });
    m.output('qa', qa);
    m.output('qb', qb);
    const sim = new Ir4Sim(design(m.build()));
    sim.set('en', '1').set('d', '01').tick('clk');
    sim.set('d', '10').tick('clk');
    expect(sim.get('qa')).toBe('10');
    expect(sim.get('qb')).toBe('01');
    sim.set('en', '0').set('d', '11').tick('clk');
    expect(sim.get('qa')).toBe('11');
    expect(sim.get('qb')).toBe('01');
  });
  it('a ripple clock samples the settled values after the previous edge', () => {
    const m = new M();
    const clk = m.input('clk', 1);
    const run = m.input('run', 1);
    const q1 = m.net(1);
    const q2 = m.net(1);
    m.add({ kind: 'dff', clk, edge: 'pos', d: m.bin('and', m.un('not', q1), run), q: q1 });
    m.add({ kind: 'dff', clk: q1, edge: 'pos', d: q1, q: q2 });
    m.output('q2', q2);
    const sim = new Ir4Sim(design(m.build()));
    sim.set('run', '0').tick('clk');
    expect(sim.get('q2')).toBe('x');
    sim.set('run', '1').tick('clk');
    expect(sim.get('q2')).toBe('1');
  });
});

describe('adff', () => {
  function areg(level: 0 | 1 = 1, value = '1010', edge: 'pos' | 'neg' = 'pos') {
    const m = new M();
    const clk = m.input('clk', 1);
    const arst = m.input('arst', 1);
    const d = m.input('d', 4);
    const q = m.net(4);
    m.add({ kind: 'adff', clk, edge, arst, arstLevel: level, arstValue: value, d, q });
    m.output('q', q);
    return new Ir4Sim(design(m.build()));
  }
  const idle = (level: 0 | 1) => String(1 - level);

  it('resets asynchronously, as a level, without a clock edge', () => {
    const sim = areg();
    sim.set('clk', '0').set('d', '0000').set('arst', '0');
    expect(sim.get('q')).toBe('xxxx');
    sim.set('arst', '1');
    expect(sim.get('q')).toBe('1010');
    sim.set('arst', '0');
    expect(sim.get('q')).toBe('1010');
  });
  it('is forced to arstValue at power-on when arst starts active', () => {
    const sim = areg();
    sim.set('clk', '0').set('d', '0000').set('arst', '1');
    expect(sim.get('q')).toBe('1010');
  });
  it('reset has priority over the clock edge', () => {
    const sim = areg();
    sim.set('d', '0011').set('arst', '1').tick('clk');
    expect(sim.get('q')).toBe('1010');
    sim.tick('clk');
    expect(sim.get('q')).toBe('1010');
    sim.set('arst', '0').tick('clk');
    expect(sim.get('q')).toBe('0011');
  });
  it('honours an active-low reset and a negative clock edge', () => {
    const sim = areg(0, '0110', 'neg');
    sim.set('clk', '1').set('d', '1111').set('arst', idle(0));
    sim.tick('clk', 'neg');
    expect(sim.get('q')).toBe('1111');
    sim.set('arst', '0');
    expect(sim.get('q')).toBe('0110');
  });
  it('an unknown arst makes the bits where arstValue and the held value differ x', () => {
    const sim = areg(1, '1100');
    sim.set('arst', '0').set('d', '1010').tick('clk');
    expect(sim.get('q')).toBe('1010');
    sim.set('arst', 'x');
    expect(sim.get('q')).toBe('1xx0');
  });
  it('an unknown arst at an edge merges arstValue with d', () => {
    const sim = areg(1, '1100');
    sim.set('d', '1010').set('arst', 'x').tick('clk');
    expect(sim.get('q')).toBe('1xx0');
  });
});

describe('latch', () => {
  function lat(level: 0 | 1 = 1) {
    const m = new M();
    const en = m.input('en', 1);
    const d = m.input('d', 4);
    const q = m.net(4);
    m.add({ kind: 'latch', en, enLevel: level, d, q });
    m.output('q', q);
    return new Ir4Sim(design(m.build()));
  }

  it('is x until first enabled, transparent while enabled and holds otherwise', () => {
    const sim = lat();
    sim.set('en', '0').set('d', '1010');
    expect(sim.get('q')).toBe('xxxx');
    sim.set('en', '1');
    expect(sim.get('q')).toBe('1010');
    sim.set('d', '0110');
    expect(sim.get('q')).toBe('0110');
    sim.set('en', '0').set('d', '1111');
    expect(sim.get('q')).toBe('0110');
  });
  it('an unknown en turns the bits where d differs from q into x', () => {
    const sim = lat();
    sim.set('en', '1').set('d', '1010').set('en', '0').set('d', '1100');
    expect(sim.get('q')).toBe('1010');
    sim.set('en', 'x');
    expect(sim.get('q')).toBe('1xx0');
  });
  it('supports an active-low enable', () => {
    const sim = lat(0);
    sim.set('en', '0').set('d', '0011');
    expect(sim.get('q')).toBe('0011');
    sim.set('en', '1').set('d', '1100');
    expect(sim.get('q')).toBe('0011');
  });
});

describe('combinational loops', () => {
  it('an SR latch built from NOR gates keeps its state', () => {
    const m = new M();
    const s = m.input('s', 1);
    const r = m.input('r', 1);
    const q = m.net(1);
    const qn = m.net(1);
    m.add({ kind: 'not', a: m.bin('or', r, qn), out: q });
    m.add({ kind: 'not', a: m.bin('or', s, q), out: qn });
    m.output('q', q);
    const sim = new Ir4Sim(design(m.build()));
    sim.set('s', '1').set('r', '0');
    expect(sim.get('q')).toBe('1');
    sim.set('s', '0');
    expect(sim.get('q')).toBe('1');
    sim.set('r', '1');
    expect(sim.get('q')).toBe('0');
    sim.set('r', '0');
    expect(sim.get('q')).toBe('0');
  });
  it('an unstable loop terminates and settles at x', () => {
    const m = new M();
    const n = m.net(1);
    m.add({ kind: 'not', a: n, out: n });
    m.output('y', n);
    expect(new Ir4Sim(design(m.build())).get('y')).toBe('x');
  });
});

describe('memory', () => {
  function mem(init?: string[]) {
    const m = new M();
    const clk = m.input('clk', 1);
    const wa = m.input('wa', 2);
    const wd = m.input('wd', 4);
    const we = m.input('we', 1);
    const ra = m.input('ra', 2);
    const sa = m.input('sa', 2);
    const ad = m.net(4);
    const sd = m.net(4);
    m.add({
      kind: 'memory',
      name: 'mem',
      width: 4,
      depth: 3,
      ...(init ? { init } : {}),
      readPorts: [
        { addr: ra, data: ad },
        { addr: sa, data: sd, clk, edge: 'pos' },
      ],
      writePorts: [{ addr: wa, data: wd, en: we, clk, edge: 'pos' }],
    });
    m.output('ad', ad);
    m.output('sd', sd);
    const sim = new Ir4Sim(design(m.build()));
    sim.set('clk', '0').set('we', '0').set('wa', '00').set('wd', '0000').set('ra', '00').set('sa', '00');
    return sim;
  }

  it('words start as x unless init gives them', () => {
    expect(mem().get('ad')).toBe('xxxx');
    const sim = mem(['0001', '0010']);
    expect(sim.get('ad')).toBe('0001');
    sim.set('ra', '01');
    expect(sim.get('ad')).toBe('0010');
    sim.set('ra', '10');
    expect(sim.get('ad')).toBe('xxxx');
  });
  it('an out of range or unknown read address reads x', () => {
    const sim = mem(['0001', '0010', '0011']);
    sim.set('ra', '11');
    expect(sim.get('ad')).toBe('xxxx');
    sim.set('ra', '1x');
    expect(sim.get('ad')).toBe('xxxx');
    sim.set('ra', '10');
    expect(sim.get('ad')).toBe('0011');
  });
  it('the synchronous read starts x and registers on the clock edge', () => {
    const sim = mem(['0001', '0010', '0011']);
    expect(sim.get('sd')).toBe('xxxx');
    sim.set('sa', '10');
    expect(sim.get('sd')).toBe('xxxx');
    sim.tick('clk');
    expect(sim.get('sd')).toBe('0011');
  });
  it('a synchronous read of the word being written returns the old data', () => {
    const sim = mem(['0001', '0010', '0011']);
    sim.set('we', '1').set('wa', '01').set('wd', '1111').set('sa', '01').set('ra', '01');
    sim.tick('clk');
    expect(sim.get('ad')).toBe('1111');
    expect(sim.get('sd')).toBe('0010');
    sim.set('we', '0').tick('clk');
    expect(sim.get('sd')).toBe('1111');
  });
  it('en low writes nothing, unknown en makes the word x, bad addresses write nothing', () => {
    const sim = mem(['0001', '0010', '0011']);
    sim.set('wa', '00').set('wd', '1111').set('we', '0').tick('clk');
    expect(sim.get('ad')).toBe('0001');
    sim.set('wa', '1x').set('we', '1').tick('clk');
    sim.set('wa', '11').tick('clk');
    sim.set('wa', '01').set('ra', '01').set('we', '1').set('wd', '0100').tick('clk');
    expect(sim.get('ad')).toBe('0100');
    sim.set('we', 'x').set('wd', '0000').tick('clk');
    expect(sim.get('ad')).toBe('xxxx');
    sim.set('ra', '00');
    expect(sim.get('ad')).toBe('0001');
    sim.set('ra', '10');
    expect(sim.get('ad')).toBe('0011');
  });
});

describe('instances', () => {
  function child(): Module {
    const m = new M();
    const clk = m.input('clk', 1);
    const d = m.input('d', 3);
    const q = m.net(3);
    m.add({ kind: 'dff', clk, edge: 'pos', d, q });
    m.output('q', q);
    m.output('inv', m.un('not', q));
    return m.build('stage');
  }

  it('gives each instance its own state', () => {
    const m = new M();
    const clk = m.input('clk', 1);
    const a = m.input('a', 3);
    const b = m.input('b', 3);
    const qa = m.net(3);
    const qb = m.net(3);
    const ia = m.net(3);
    m.add({ kind: 'instance', module: 'stage', name: 'u0', inputs: { clk, d: a }, outputs: { q: qa, inv: ia } });
    m.add({ kind: 'instance', module: 'stage', name: 'u1', inputs: { clk, d: b }, outputs: { q: qb } });
    m.output('qa', qa);
    m.output('qb', qb);
    m.output('ia', ia);
    const sim = new Ir4Sim(design(m.build(), child()));
    expect(sim.get('qa')).toBe('xxx');
    sim.set('a', '001').set('b', '110').tick('clk');
    expect(sim.get('qa')).toBe('001');
    expect(sim.get('qb')).toBe('110');
    expect(sim.get('ia')).toBe('110');
    sim.set('a', '111').tick('clk');
    sim.set('b', '000');
    expect(sim.get('qa')).toBe('111');
    expect(sim.get('qb')).toBe('110');
  });
  it('an unconnected callee input reads x to the callee', () => {
    const m = new M();
    const clk = m.input('clk', 1);
    const q = m.net(3);
    m.add({ kind: 'instance', module: 'stage', name: 'u0', inputs: { clk }, outputs: { q } });
    m.output('q', q);
    const sim = new Ir4Sim(design(m.build(), child()));
    sim.tick('clk');
    expect(sim.get('q')).toBe('xxx');
  });
  it('a callee tribuf can drive a z through the hierarchy', () => {
    const c = new M();
    const a = c.input('a', 2);
    const en = c.input('en', 1);
    const out = c.net(2);
    c.add({ kind: 'tribuf', a, en, out });
    c.output('y', out);
    const m = new M();
    const x = m.input('x', 2);
    const e = m.input('e', 1);
    const y = m.net(2);
    m.add({ kind: 'instance', module: 'drv', name: 'u', inputs: { a: x, en: e }, outputs: { y } });
    m.output('y', y);
    const sim = new Ir4Sim(design(m.build(), c.build('drv')));
    sim.set('x', '10').set('e', '0');
    expect(sim.get('y')).toBe('zz');
    sim.set('e', '1');
    expect(sim.get('y')).toBe('10');
  });
});

describe('Ir4Sim input checks', () => {
  it('rejects unknown ports, outputs and malformed values', () => {
    const m = new M();
    const a = m.input('a', 2);
    m.output('y', a);
    const sim = new Ir4Sim(design(m.build()));
    expect(() => sim.set('nope', '00')).toThrow();
    expect(() => sim.set('y', '00')).toThrow();
    expect(() => sim.set('a', '0')).toThrow();
    expect(() => sim.set('a', '02')).toThrow();
    expect(() => sim.get('nope')).toThrow();
    expect(sim.set('a', 'XZ').get('y')).toBe('xz');
  });
});

describe('ir4Runner', () => {
  const COUNTER = 'module c(input clk, input rst, output reg [3:0] q); always @(posedge clk) if (rst) q <= 0; else q <= q + 1; endmodule';

  it('runs the cycle protocol on a counter', async () => {
    const res = await ir4Runner()({
      source: COUNTER,
      top: 'c',
      clock: 'clk',
      stimulus: [{ rst: '1' }, { rst: '0' }, {}, {}, { rst: '1' }, { rst: '0' }],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.ports.map((p) => p.name).sort()).toEqual(['clk', 'q', 'rst']);
    expect(res.cycles.map((c) => c.pre.q)).toEqual(['xxxx', '0000', '0001', '0010', '0011', '0000']);
    expect(res.cycles.map((c) => c.post.q)).toEqual(['0000', '0001', '0010', '0011', '0000', '0001']);
  });
  it('keeps a stimulus value until it is changed', async () => {
    const res = await ir4Runner()({ source: COUNTER, top: 'c', clock: 'clk', stimulus: [{ rst: '1' }, {}, {}] });
    if (!res.ok) throw new Error(res.error);
    expect(res.cycles.map((c) => c.post.q)).toEqual(['0000', '0000', '0000']);
  });
  it('reports compile errors', async () => {
    const res = await ir4Runner()({ source: 'module c(; endmodule', top: 'c', clock: 'clk', stimulus: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
  });
  it('runs a thousand cycles of a fuzz-sized design', async () => {
    const stimulus = Array.from({ length: 1000 }, (_, i) => ({ rst: i === 0 ? '1' : '0' }));
    const res = await ir4Runner()({ source: COUNTER, top: 'c', clock: 'clk', stimulus });
    if (!res.ok) throw new Error(res.error);
    expect(res.cycles[999]!.post.q).toBe((999 % 16).toString(2).padStart(4, '0'));
  });
});
