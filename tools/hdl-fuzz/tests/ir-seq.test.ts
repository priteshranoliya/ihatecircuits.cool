import type { Design, MemoryCell, Net } from '@ihatecircuits/hdl/design';
import type { Stimulus } from '@ihatecircuits/hdl/trace';
import { Interp } from '@ihatecircuits/hdl/interp';
import { lowerToProject } from '@ihatecircuits/hdl-bridge';
import { describe, expect, it } from 'vitest';
import { compareTraces } from '../src/compare';
import { designOf, ModuleBuilder } from '../src/irbuild';
import { irReference, irRunners } from '../src/ir-runners';
import { iverilogAvailable } from '../src/iverilog';

const haveIcarus = iverilogAvailable();

/** Every runner against the reference. Fails with the first mismatch of each runner. */
async function agree(design: Design, stimulus: Stimulus, expectReference?: (trace: { pre: Record<string, string>; post: Record<string, string> }[]) => void) {
  const req = { design, clock: 'clk', stimulus };
  const ref = await irReference.run(req);
  expect(ref.ok, ref.ok ? '' : ref.error).toBe(true);
  if (ref.ok) expectReference?.(ref.cycles);
  const failures: string[] = [];
  for (const r of irRunners) {
    const verdict = compareTraces(ref, await r.run(req), { strict: r.name === 'interp' });
    if (!verdict.ok) failures.push(`${r.name}: ${verdict.message}`);
  }
  expect(failures).toEqual([]);
}

const bin = (n: number, w: number) => (n & (2 ** w - 1)).toString(2).padStart(w, '0');

function seqModule() {
  const m = new ModuleBuilder('top');
  const clk = m.input('clk', 1);
  return { m, clk };
}

describe.skipIf(!haveIcarus)('registers and latches on every back end', () => {
  it('dff on both edges, with a register chain', async () => {
    const { m, clk } = seqModule();
    const d = m.input('d', 3);
    const pos = m.net(3);
    const neg = m.net(3);
    const chain = m.net(3);
    m.add({ kind: 'dff', clk, edge: 'pos', d, q: pos });
    m.add({ kind: 'dff', clk, edge: 'neg', d, q: neg });
    m.add({ kind: 'dff', clk, edge: 'pos', d: pos, q: chain });
    m.output('pos', pos);
    m.output('neg', neg);
    m.output('chain', chain);
    const stim = [5, 2, 7, 0, 3].map((v) => ({ d: bin(v, 3) }));
    await agree(designOf(m.build()), stim, (t) => {
      expect(t[0]!.pre.pos).toBe('xxx');
      expect(t[0]!.post.pos).toBe('101');
      expect(t[1]!.pre.neg).toBe('101');
      expect(t[2]!.post.chain).toBe('010');
    });
  });

  for (const level of [0, 1] as const) {
    for (const value of ['0000', '1010', '1111']) {
      it(`adff, reset active at ${level}, resets to ${value}`, async () => {
        const { m, clk } = seqModule();
        const d = m.input('d', 4);
        const rst = m.input('rst', 1);
        const q = m.net(4);
        m.add({ kind: 'adff', clk, edge: 'pos', arst: rst, arstLevel: level, arstValue: value, d, q });
        m.output('q', q);
        const stim = Array.from({ length: 14 }, (_, k) => ({ d: bin(k * 5 + 1, 4), rst: String(((k >> 1) + (k % 3 === 0 ? 1 : 0)) & 1) }));
        await agree(designOf(m.build()), stim);
      });
    }
  }

  it('latch on both enable levels, holding and following', async () => {
    const { m, clk } = seqModule();
    const en = m.input('en', 1);
    const dIn = m.input('d', 3);
    // A latch's data should not change while its enable does, so the data comes from a register.
    const held = m.net(3);
    const [hi, lo] = [m.net(3), m.net(3)];
    m.add({ kind: 'dff', clk, edge: 'pos', d: dIn, q: held });
    m.add({ kind: 'latch', en, enLevel: 1, d: held, q: hi });
    m.add({ kind: 'latch', en, enLevel: 0, d: held, q: lo });
    m.output('hi', hi);
    m.output('lo', lo);
    const stim = [0, 1, 1, 0, 0, 1, 0, 1, 1, 0].map((e, k) => ({ en: String(e), d: bin(k * 3 + 1, 3) }));
    await agree(designOf(m.build()), stim);
  });
});

describe.skipIf(!haveIcarus)('power-on values of registers and latches on every back end', () => {
  it('dff on both edges with a power-on value, unknown bits included, from 1 to 32 bits', async () => {
    for (const init of ['1', '0', 'x', '10', '1x0', '01x10', '1010101010101010', '1x'.repeat(16)]) {
      const w = init.length;
      const { m, clk } = seqModule();
      const d = m.input('d', w);
      const pos = m.net(w);
      const neg = m.net(w);
      m.add({ kind: 'dff', clk, edge: 'pos', d, q: pos, init });
      m.add({ kind: 'dff', clk, edge: 'neg', d, q: neg, init });
      m.output('pos', pos);
      m.output('neg', neg);
      const stim = [5, 2, 7].map((v) => ({ d: bin(v, w) }));
      await agree(designOf(m.build()), stim, (t) => {
        expect(t[0]!.pre.pos).toBe(init.padStart(w, '0'));
        expect(t[0]!.pre.neg).toBe(init.padStart(w, '0'));
        expect(t[0]!.post.pos).toBe(bin(5, w));
      });
    }
  });

  it('adff with a power-on value that is the reset value, and an unknown bit', async () => {
    const { m, clk } = seqModule();
    const d = m.input('d', 4);
    const rst = m.input('rst', 1);
    const q = m.net(4);
    m.add({ kind: 'adff', clk, edge: 'pos', arst: rst, arstLevel: 1, arstValue: '1010', d, q, init: '1x10' });
    m.output('q', q);
    const stim = Array.from({ length: 10 }, (_, k) => ({ d: bin(k * 5 + 1, 4), rst: k === 0 ? '0' : String((k >> 1) & 1) }));
    await agree(designOf(m.build()), stim, (t) => expect(t[0]!.pre.q).toBe('1x10'));
  });

  it('adff whose reset is not active at power-on shows `init` until the first edge', async () => {
    const { m, clk } = seqModule();
    const d = m.input('d', 4);
    const rst = m.input('rst', 1);
    const q = m.net(4);
    m.add({ kind: 'adff', clk, edge: 'pos', arst: rst, arstLevel: 1, arstValue: '0000', d, q, init: '1001' });
    m.output('q', q);
    const stim = [0, 0, 1, 0].map((r, k) => ({ d: bin(k + 3, 4), rst: String(r) }));
    await agree(designOf(m.build()), stim, (t) => {
      expect(t[0]!.pre.q).toBe('1001');
      expect(t[0]!.post.q).toBe('0011');
      expect(t[2]!.pre.q).toBe('0000');
    });
  });

  it('a latch that is closed at power-on holds its value, and one that is open follows its data', async () => {
    for (const en of ['0', '1']) {
      const { m, clk } = seqModule();
      const dReg = m.net(3);
      const dIn = m.input('d', 3);
      m.add({ kind: 'dff', clk, edge: 'pos', d: dIn, q: dReg, init: '101' });
      const enable = m.input('en', 1);
      const q = m.net(3);
      m.add({ kind: 'latch', en: enable, enLevel: 1, d: dReg, q, init: '010' });
      m.output('q', q);
      const stim = [en, en, '1', '0', '1'].map((e, k) => ({ d: bin(k + 1, 3), en: e }));
      await agree(designOf(m.build()), stim, (t) => expect(t[0]!.pre.q).toBe(en === '0' ? '010' : '101'));
    }
  });

  it('the interpreter honours init, and powerOn 0 turns its unknown bits into 0', () => {
    const { m, clk } = seqModule();
    const d = m.input('d', 4);
    const q = m.net(4);
    m.add({ kind: 'dff', clk, edge: 'pos', d, q, init: '1x01' });
    m.output('q', q);
    const design = designOf(m.build());
    expect(new Interp(design).value('q')).toBe('1x01');
    expect(new Interp(design, { powerOn: '0' }).value('q')).toBe('1001');
  });

  it('both views power a register on at `init` in the circuit, and leave a register without one at 0', () => {
    const { m, clk } = seqModule();
    const d = m.input('d', 4);
    const a = m.net(4);
    const b = m.net(4);
    m.add({ kind: 'dff', clk, edge: 'pos', d, q: a, init: '1x01' });
    m.add({ kind: 'dff', clk, edge: 'pos', d, q: b });
    m.output('a', a);
    m.output('b', b);
    const blocks = lowerToProject(designOf(m.build()), { view: 'blocks' }).circuits[0]!;
    expect(Object.values(blocks.components).filter((c) => c.type === 'register').map((c) => c.props.init)).toEqual(['1x01', '']);
    const gates = lowerToProject(designOf(m.build()), { view: 'gates' }).circuits[0]!;
    expect(Object.values(gates.components).filter((c) => c.type === 'dff').map((c) => c.props.init)).toEqual(['1', '0', 'x', '1', '', '', '', '']);
  });
});

describe.skipIf(!haveIcarus)('tri-state buffers and net kinds on every back end', () => {
  const kinds: Net['kind'][] = ['wire', 'pull0', 'pull1', 'wand', 'wor'];
  for (const kind of kinds) {
    it(`two buffers and a third driver on a ${kind} net`, async () => {
      const { m } = seqModule();
      const [a, b] = [m.input('a', 3), m.input('b', 3)];
      const [ea, eb] = [m.input('ea', 1), m.input('eb', 1)];
      const net = m.net(3, { kind });
      m.add({ kind: 'tribuf', a, en: ea, out: net });
      m.add({ kind: 'tribuf', a: b, en: eb, out: net });
      m.output('y', net);
      const stim = Array.from({ length: 16 }, (_, k) => ({ a: bin(k * 5 + 3, 3), b: bin(k * 3 + 1, 3), ea: String(k & 1), eb: String((k >> 1) & 1) }));
      await agree(designOf(m.build()), stim);
    });
  }

  it('a wand or wor net with one ordinary driver beside the buffer', async () => {
    for (const kind of ['wand', 'wor'] as const) {
      const { m } = seqModule();
      const [a, b, e] = [m.input('a', 2), m.input('b', 2), m.input('e', 1)];
      const net = m.net(2, { kind });
      m.add({ kind: 'tribuf', a, en: e, out: net });
      m.add({ kind: 'not', a: b, out: net });
      m.output('y', net);
      const stim = Array.from({ length: 12 }, (_, k) => ({ a: bin(k, 2), b: bin(k >> 1, 2), e: String(k & 1) }));
      await agree(designOf(m.build()), stim);
    }
  });

  it('supply nets are constants and a floating net reads z', async () => {
    const { m } = seqModule();
    const s1 = m.net(3, { kind: 'supply1' });
    const s0 = m.net(2, { kind: 'supply0' });
    const f = m.net(2);
    m.output('one', s1);
    m.output('zero', s0);
    m.output('float', f);
    await agree(designOf(m.build()), [{}, {}], (t) => {
      expect(t[0]!.pre).toEqual({ one: '111', zero: '00', float: 'zz' });
    });
  });
});

function memory(overrides: Partial<MemoryCell>, widths: { addr: number; data: number }) {
  const { m, clk } = seqModule();
  const wa = m.input('wa', widths.addr);
  const ra = m.input('ra', widths.addr);
  const wd = m.input('wd', widths.data);
  const we = m.input('we', 1);
  const cell: MemoryCell = { kind: 'memory', name: 'mem', width: widths.data, depth: 8, readPorts: [], writePorts: [], ...overrides };
  return { m, clk, wa, ra, wd, we, cell };
}

function memStim(n: number, addrBits: number, dataBits: number): Stimulus {
  let s = 99;
  const next = (bits: number) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 9) & (2 ** bits - 1);
  };
  return Array.from({ length: n }, () => ({ wa: bin(next(addrBits), addrBits), ra: bin(next(addrBits), addrBits), wd: bin(next(dataBits), dataBits), we: String(next(2) & 1) }));
}

describe.skipIf(!haveIcarus)('memories on every back end', () => {
  it('a ROM: asynchronous and registered read ports, partial contents, an address past the depth', async () => {
    const { m, clk, ra, cell } = memory({ depth: 6, init: ['0101', '1111', '0011'] }, { addr: 3, data: 4 });
    const a = m.net(4);
    const s = m.net(4);
    cell.readPorts.push({ addr: ra, data: a }, { addr: ra, data: s, clk, edge: 'pos' });
    m.add(cell);
    m.output('async', a);
    m.output('sync', s);
    await agree(designOf(m.build()), memStim(16, 3, 4), (t) => {
      expect(t[0]!.pre.sync).toBe('xxxx');
    });
  });

  it('a RAM part fits one write port and an asynchronous read on the same address', async () => {
    const { m, clk, wa, wd, we, cell } = memory({}, { addr: 3, data: 4 });
    const q = m.net(4);
    cell.writePorts.push({ addr: wa, data: wd, en: we, clk, edge: 'pos' });
    cell.readPorts.push({ addr: wa, data: q });
    m.add(cell);
    m.output('q', q);
    const design = designOf(m.build());
    await agree(design, memStim(24, 3, 4));
    const types = lowerToProject(design, { view: 'blocks' }).circuits[0]!;
    expect(Object.values(types.components).map((c) => c.type)).toContain('ram');
  });

  it('writes and reads at different addresses: registers and a multiplexer tree, old data on a clocked read', async () => {
    const { m, clk, wa, ra, wd, we, cell } = memory({ depth: 5 }, { addr: 3, data: 4 });
    const [a, s] = [m.net(4), m.net(4)];
    cell.writePorts.push({ addr: wa, data: wd, en: we, clk, edge: 'pos' });
    cell.readPorts.push({ addr: ra, data: a }, { addr: ra, data: s, clk, edge: 'pos' });
    m.add(cell);
    m.output('async', a);
    m.output('sync', s);
    await agree(designOf(m.build()), memStim(40, 3, 4));
  });

  it('with initial contents and a write port, the contents show until written', async () => {
    const { m, clk, wa, ra, wd, we, cell } = memory({ depth: 4, init: ['1001', '0110'] }, { addr: 2, data: 4 });
    const a = m.net(4);
    cell.writePorts.push({ addr: wa, data: wd, en: we, clk, edge: 'neg' });
    cell.readPorts.push({ addr: ra, data: a });
    m.add(cell);
    m.output('async', a);
    const design = designOf(m.build());
    await agree(design, memStim(30, 2, 4), (t) => {
      expect([t[0]!.pre.async, t[0]!.post.async].some((v) => v === '1001' || v === '0110' || v === 'xxxx')).toBe(true);
    });
    const main = lowerToProject(design, { view: 'blocks' }).circuits[0]!;
    const words = Object.values(main.components).filter((c) => c.type === 'register');
    expect(words.map((c) => c.props.init)).toEqual(['1001', '0110', '', '']);
  });

  it('two write ports on one memory: the later port wins', async () => {
    const { m, clk, wa, ra, wd, we, cell } = memory({ depth: 4 }, { addr: 2, data: 3 });
    const wd2 = m.input('wd2', 3);
    const a = m.net(3);
    cell.writePorts.push({ addr: wa, data: wd, en: we, clk, edge: 'pos' }, { addr: wa, data: wd2, en: we, clk, edge: 'pos' });
    cell.readPorts.push({ addr: ra, data: a });
    m.add(cell);
    m.output('async', a);
    const stim = memStim(24, 2, 3).map((s, k) => ({ ...s, wd2: bin(k * 3 + 2, 3) }));
    await agree(designOf(m.build()), stim);
  });
});

describe.skipIf(!haveIcarus)('wide values (up to 32 bits) on every back end', () => {
  const stimulus = (width: number, cycles: number): Stimulus => {
    let s = 4242;
    const next = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s;
    };
    const mask = (1n << BigInt(width)) - 1n;
    const word = () => {
      const r = next() % 8;
      const base = r === 0 ? 0n : r === 1 ? mask : r === 2 ? 1n << BigInt(width - 1) : (BigInt(next()) << 32n) | BigInt(next());
      return (base & mask).toString(2).padStart(width, '0');
    };
    return Array.from({ length: cycles }, () => ({ a: word(), b: word(), n: bin(next() % 40, 6) }));
  };

  function wide(width: number, kinds: readonly ('add' | 'sub' | 'mul' | 'divu' | 'remu' | 'divs' | 'rems' | 'and' | 'or' | 'xor' | 'xnor')[], shifts: boolean, cycles: number) {
    const { m } = seqModule();
    const a = m.input('a', width);
    const b = m.input('b', width);
    const n = m.input('n', 6);
    for (const kind of kinds) {
      const out = m.net(width);
      m.add({ kind, a, b, out });
      m.output(`r_${kind}`, out);
    }
    if (shifts) {
      for (const kind of ['shl', 'shr', 'sshr'] as const) {
        const out = m.net(width);
        m.add({ kind, a, amount: n, out });
        m.output(`r_${kind}`, out);
      }
      for (const kind of ['ltu', 'lts', 'eq'] as const) {
        const out = m.net(1);
        m.add({ kind, a, b, out });
        m.output(`r_${kind}`, out);
      }
    }
    return agree(designOf(m.build()), stimulus(width, cycles));
  }

  it('every arithmetic cell, the shifts and the comparisons at 16 bits', () => wide(16, ['add', 'sub', 'mul', 'divu', 'remu', 'divs', 'rems', 'and', 'or', 'xor', 'xnor'], true, 24), 300_000);
  it('addition, subtraction, multiplication, logic, shifts and comparisons at 32 bits', () => wide(32, ['add', 'sub', 'mul', 'and', 'or', 'xor', 'xnor'], true, 24), 300_000);
  it('signed division and remainder at 32 bits', () => wide(32, ['divs', 'rems'], false, 6), 300_000);
});
