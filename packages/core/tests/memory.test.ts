import { describe, expect, it } from 'vitest';
import { LIBRARY, getDef, pinsOf } from '../src/library';
import { MEMORY, parseRomContents, ramContents, ramSetWord, xorshift32, type RamState } from '../src/parts/memory';
import { T, str } from './helpers';

/** A part under test with a tri-state input pin on each named input. A 'z' bit reads as unknown (x). */
function rig(type: string, props: Record<string, unknown>, inputs: Record<string, number>, init: Record<string, string> = {}) {
  const t = new T();
  const id = t.add(type, props);
  const pins: Record<string, string> = {};
  for (const [name, width] of Object.entries(inputs)) {
    const p = t.add('pin', { io: 'in', bits: width, behavior: 'tristate', value: init[name] ?? '0'.repeat(width) });
    t.wire(p, 'p', id, name);
    pins[name] = p;
  }
  const sim = t.sim();
  const set = (v: Record<string, string>) => {
    for (const [k, val] of Object.entries(v)) sim.setRuntime(pins[k], 'value', val);
    if (!sim.settle().stable) throw new Error('did not settle');
  };
  const out = (pin: string) => str(sim.value(id, pin));
  const rise = (extra: Record<string, string> = {}) => {
    set({ ...extra, clk: '1' });
    set({ clk: '0' });
  };
  return { t, id, sim, set, out, rise, pins };
}

const ff = (type: string, props: Record<string, unknown>, data: Record<string, number>, withAsync = true) =>
  rig(type, props, { ...data, clk: 1, ...(withAsync ? { set: 1, clr: 1 } : {}) });

describe('memory library', () => {
  it('registers every memory part under its documented type id', () => {
    for (const type of ['dff', 'tff', 'jkff', 'srff', 'dlatch', 'srlatch', 'register', 'counter', 'shiftreg', 'random', 'ram', 'rom']) {
      expect(LIBRARY.get(type)?.category).toBe('Memory');
    }
    expect(new Set(MEMORY.map((d) => d.type)).size).toBe(MEMORY.length);
  });

  it('lays pins out on the 10px grid with unique names, for varied props', () => {
    const variants: [string, Record<string, unknown>][] = [
      ['dff', {}],
      ['register', { bits: 32 }],
      ['counter', { bits: 12 }],
      ['shiftreg', { stages: 32, parallel: true, bits: 3 }],
      ['shiftreg', { stages: 1 }],
      ['ram', { bus: 'single' }],
      ['ram', { bus: 'separate', addrBits: 16, dataBits: 32 }],
      ['rom', { addrBits: 16 }],
      ['random', {}],
    ];
    for (const [type, props] of variants) {
      const t = new T();
      const id = t.add(type, props);
      const pins = pinsOf(t.c.components[id]);
      expect(new Set(pins.map((p) => p.name)).size).toBe(pins.length);
      for (const p of pins) {
        expect(p.x % 10, `${type}.${p.name} x`).toBe(0);
        expect(p.y % 10, `${type}.${p.name} y`).toBe(0);
      }
      expect(getDef(type).title?.(t.c.components[id].props)).toBeTruthy();
    }
  });
});

describe('D flip-flop', () => {
  it('captures D on the rising edge and holds otherwise', () => {
    const r = ff('dff', {}, { d: 1 });
    expect(r.out('q')).toBe('0');
    r.set({ d: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ clk: '1' });
    expect([r.out('q'), r.out('qn')]).toEqual(['1', '0']);
    r.set({ d: '0' });
    expect(r.out('q')).toBe('1');
    r.set({ clk: '0' });
    expect(r.out('q')).toBe('1');
    r.rise();
    expect([r.out('q'), r.out('qn')]).toEqual(['0', '1']);
  });

  it('falling trigger captures on the falling edge only', () => {
    const r = ff('dff', { trigger: 'falling' }, { d: 1 });
    r.set({ d: '1', clk: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ clk: '0' });
    expect(r.out('q')).toBe('1');
  });

  it('high level trigger is transparent while the clock is high', () => {
    const r = ff('dff', { trigger: 'high' }, { d: 1 });
    r.set({ clk: '1', d: '1' });
    expect(r.out('q')).toBe('1');
    r.set({ d: '0' });
    expect(r.out('q')).toBe('0');
    r.set({ clk: '0' });
    r.set({ d: '1' });
    expect(r.out('q')).toBe('0');
  });

  it('low level trigger is transparent while the clock is low', () => {
    const r = ff('dff', { trigger: 'low' }, { d: 1 });
    r.set({ d: '1' });
    expect(r.out('q')).toBe('1');
    r.set({ clk: '1' });
    r.set({ d: '0' });
    expect(r.out('q')).toBe('1');
  });

  it('async clear and set act without a clock, clear wins over set', () => {
    const r = ff('dff', {}, { d: 1 });
    r.set({ d: '1' });
    r.rise();
    expect(r.out('q')).toBe('1');
    r.set({ clr: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ set: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ clr: '0' });
    expect(r.out('q')).toBe('1');
    r.set({ set: '0' });
    expect(r.out('q')).toBe('1');
  });

  it('async inputs beat the clock edge, and the value is kept after release', () => {
    const r = ff('dff', {}, { d: 1 });
    r.set({ d: '1', clr: '1' });
    r.rise();
    expect(r.out('q')).toBe('0');
    r.set({ clr: '0' });
    expect(r.out('q')).toBe('0');
    r.set({ d: '0', set: '1' });
    r.rise();
    expect(r.out('q')).toBe('1');
  });

  it('unknown data on a firing clock stores x', () => {
    const r = ff('dff', {}, { d: 1 });
    r.set({ d: 'z' });
    r.rise();
    expect([r.out('q'), r.out('qn')]).toEqual(['x', 'x']);
    r.set({ clr: '1' });
    expect(r.out('q')).toBe('0');
  });

  it('unknown clock stores the merge of old and new: unchanged bits stay known', () => {
    const same = ff('dff', {}, { d: 1 });
    same.set({ clk: 'z' });
    expect(same.out('q')).toBe('0');
    const differ = ff('dff', {}, { d: 1 }, false);
    differ.set({ d: '1', clk: 'z' });
    expect(differ.out('q')).toBe('x');
  });

  it('unknown async inputs merge the forced value with the normal result', () => {
    const a = ff('dff', {}, { d: 1 });
    a.set({ clr: 'z' });
    expect(a.out('q')).toBe('0');
    const b = ff('dff', {}, { d: 1 });
    b.set({ set: 'z' });
    expect(b.out('q')).toBe('x');
    b.set({ set: '1' });
    expect(b.out('q')).toBe('1');
    b.set({ clr: 'z', set: 'z' });
    expect(b.out('q')).toBe('x');
  });

  it('unconnected set and clear read as 0', () => {
    const r = rig('dff', {}, { d: 1, clk: 1 });
    r.set({ d: '1' });
    r.rise();
    expect(r.out('q')).toBe('1');
  });

  it('a flip-flop that powers up with the clock high does not see a phantom edge', () => {
    const r = rig('dff', { trigger: 'falling' }, { d: 1, clk: 1 }, { d: '1', clk: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ clk: '0' });
    expect(r.out('q')).toBe('1');
  });

  it('simulation reset returns it to 0', () => {
    const r = ff('dff', {}, { d: 1 });
    r.set({ d: '1' });
    r.rise();
    r.sim.reset();
    expect(r.out('q')).toBe('0');
  });
});

describe('T flip-flop', () => {
  it('toggles on every edge while T=1 and holds while T=0', () => {
    const r = ff('tff', {}, { t: 1 });
    r.set({ t: '1' });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      r.rise();
      seen.push(r.out('q'));
    }
    expect(seen).toEqual(['1', '0', '1', '0']);
    r.set({ t: '0' });
    r.rise();
    r.rise();
    expect(r.out('q')).toBe('0');
  });

  it('offers edge triggers only and falling works', () => {
    expect(getDef('tff').props.find((p) => p.key === 'trigger')!.options!.map((o) => o.value)).toEqual(['rising', 'falling']);
    expect(getDef('jkff').props.find((p) => p.key === 'trigger')!.options!.map((o) => o.value)).toEqual(['rising', 'falling']);
    const r = ff('tff', { trigger: 'falling' }, { t: 1 });
    r.set({ t: '1', clk: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ clk: '0' });
    expect(r.out('q')).toBe('1');
  });

  it('unknown T makes q unknown, set and clear still win', () => {
    const r = ff('tff', {}, { t: 1 });
    r.set({ t: 'z' });
    r.rise();
    expect(r.out('q')).toBe('x');
    r.set({ clr: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ clr: '0', set: '1' });
    r.rise();
    expect(r.out('q')).toBe('1');
  });

  it('unknown clock merges toggled and held values', () => {
    const r = ff('tff', {}, { t: 1 });
    r.set({ t: '1', clk: 'z' });
    expect(r.out('q')).toBe('x');
    const h = ff('tff', {}, { t: 1 });
    h.set({ clk: 'z' });
    expect(h.out('q')).toBe('0');
  });
});

describe('JK flip-flop', () => {
  it('follows the J/K table on a rising edge', () => {
    const r = ff('jkff', {}, { j: 1, k: 1 });
    const cycle = (j: string, k: string) => {
      r.rise({ j, k });
      return r.out('q');
    };
    expect(cycle('0', '0')).toBe('0');
    expect(cycle('1', '0')).toBe('1');
    expect(cycle('0', '0')).toBe('1');
    expect(cycle('0', '1')).toBe('0');
    expect(cycle('1', '1')).toBe('1');
    expect(cycle('1', '1')).toBe('0');
  });

  it('falling edge trigger', () => {
    const r = ff('jkff', { trigger: 'falling' }, { j: 1, k: 1 });
    r.set({ j: '1', clk: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ clk: '0' });
    expect(r.out('q')).toBe('1');
  });

  it('unknown inputs give x only when the result depends on them', () => {
    const r = ff('jkff', {}, { j: 1, k: 1 });
    r.rise({ j: 'z', k: '0' });
    expect(r.out('q')).toBe('x');
    const s = ff('jkff', {}, { j: 1, k: 1 });
    s.rise({ j: '1', k: '0' });
    s.rise({ j: 'z', k: '0' });
    expect(s.out('q')).toBe('1');
    s.rise({ j: '0', k: 'z' });
    expect(s.out('q')).toBe('x');
  });

  it('async clear beats set beats the clock', () => {
    const r = ff('jkff', {}, { j: 1, k: 1 });
    r.set({ set: '1' });
    r.rise({ j: '0', k: '1' });
    expect(r.out('q')).toBe('1');
    r.set({ clr: '1' });
    expect(r.out('q')).toBe('0');
    r.rise({ j: '1', k: '0' });
    expect(r.out('q')).toBe('0');
  });
});

describe('SR flip-flop', () => {
  it('sets, resets and holds on a rising edge', () => {
    const r = ff('srff', {}, { s: 1, r: 1 });
    r.rise({ s: '1', r: '0' });
    expect(r.out('q')).toBe('1');
    r.rise({ s: '0', r: '0' });
    expect(r.out('q')).toBe('1');
    r.rise({ s: '0', r: '1' });
    expect(r.out('q')).toBe('0');
  });

  it('S=R=1 on a trigger makes q unknown; it recovers on a later set', () => {
    const r = ff('srff', {}, { s: 1, r: 1 });
    r.rise({ s: '1', r: '1' });
    expect([r.out('q'), r.out('qn')]).toEqual(['x', 'x']);
    r.rise({ s: '0', r: '0' });
    expect(r.out('q')).toBe('x');
    r.rise({ s: '1', r: '0' });
    expect(r.out('q')).toBe('1');
  });

  it('level triggers act while active and ignore S=R=1 outside it', () => {
    const r = ff('srff', { trigger: 'high' }, { s: 1, r: 1 });
    r.set({ s: '1', r: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ clk: '1', r: '0' });
    expect(r.out('q')).toBe('1');
    r.set({ s: '0', r: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ clk: '0', s: '1', r: '0' });
    expect(r.out('q')).toBe('0');
    const lo = ff('srff', { trigger: 'low' }, { s: 1, r: 1 });
    lo.set({ s: '1' });
    expect(lo.out('q')).toBe('1');
  });

  it('unknown S with R=0 is x unless q is already 1', () => {
    const r = ff('srff', {}, { s: 1, r: 1 });
    r.rise({ s: 'z', r: '0' });
    expect(r.out('q')).toBe('x');
    const s = ff('srff', {}, { s: 1, r: 1 });
    s.rise({ s: '1', r: '0' });
    s.rise({ s: 'z', r: '0' });
    expect(s.out('q')).toBe('1');
  });

  it('async clear and set priority', () => {
    const r = ff('srff', {}, { s: 1, r: 1 });
    r.set({ set: '1', clr: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ clr: '0' });
    expect(r.out('q')).toBe('1');
  });
});

describe('latches', () => {
  it('D latch is transparent while EN=1 and holds while EN=0', () => {
    const r = rig('dlatch', {}, { d: 1, en: 1 });
    r.set({ d: '1' });
    expect(r.out('q')).toBe('0');
    r.set({ en: '1' });
    expect([r.out('q'), r.out('qn')]).toEqual(['1', '0']);
    r.set({ d: '0' });
    expect(r.out('q')).toBe('0');
    r.set({ d: '1' });
    r.set({ en: '0' });
    r.set({ d: '0' });
    expect(r.out('q')).toBe('1');
  });

  it('D latch with EN unconnected is always transparent', () => {
    const r = rig('dlatch', {}, { d: 1 });
    r.set({ d: '1' });
    expect(r.out('q')).toBe('1');
  });

  it('D latch with unknown EN is x only if D differs from the stored bit', () => {
    const r = rig('dlatch', {}, { d: 1, en: 1 });
    r.set({ en: 'z' });
    expect(r.out('q')).toBe('0');
    r.set({ d: '1' });
    expect(r.out('q')).toBe('x');
  });

  it('D latch with unknown D while transparent stores x', () => {
    const r = rig('dlatch', {}, { d: 1, en: 1 }, { en: '1' });
    r.set({ d: 'z' });
    expect(r.out('q')).toBe('x');
  });

  it('SR latch sets, clears and holds', () => {
    const r = rig('srlatch', {}, { s: 1, r: 1 });
    r.set({ s: '1' });
    expect([r.out('q'), r.out('qn')]).toEqual(['1', '0']);
    r.set({ s: '0' });
    expect([r.out('q'), r.out('qn')]).toEqual(['1', '0']);
    r.set({ r: '1' });
    expect([r.out('q'), r.out('qn')]).toEqual(['0', '1']);
    r.set({ r: '0' });
    expect([r.out('q'), r.out('qn')]).toEqual(['0', '1']);
  });

  it('SR latch with S=R=1 drives both outputs 0 and becomes unknown once released', () => {
    const r = rig('srlatch', {}, { s: 1, r: 1 });
    r.set({ s: '1', r: '1' });
    expect([r.out('q'), r.out('qn')]).toEqual(['0', '0']);
    r.set({ s: '0', r: '0' });
    expect([r.out('q'), r.out('qn')]).toEqual(['x', 'x']);
    r.set({ s: '1' });
    expect([r.out('q'), r.out('qn')]).toEqual(['1', '0']);
  });
});

describe('register', () => {
  const reg = (props: Record<string, unknown> = {}, inputs: Record<string, number> = { d: 4, en: 1, clk: 1, clr: 1 }) => rig('register', { bits: 4, ...props }, inputs);

  it('loads D on the rising edge when enabled', () => {
    const r = reg();
    r.set({ d: '1010', en: '1' });
    expect(r.out('q')).toBe('0000');
    r.rise();
    expect(r.out('q')).toBe('1010');
    r.set({ d: '0101' });
    expect(r.out('q')).toBe('1010');
  });

  it('holds while EN=0 and loads when EN is left unconnected', () => {
    const r = reg();
    r.rise({ d: '1111', en: '0' });
    expect(r.out('q')).toBe('0000');
    const u = reg({}, { d: 4, clk: 1 });
    u.rise({ d: '0110' });
    expect(u.out('q')).toBe('0110');
  });

  it('async clear beats the clock and holds q at 0', () => {
    const r = reg();
    r.rise({ d: '1111', en: '1' });
    r.set({ clr: '1' });
    expect(r.out('q')).toBe('0000');
    r.rise({ d: '1001' });
    expect(r.out('q')).toBe('0000');
    r.set({ clr: '0' });
    expect(r.out('q')).toBe('0000');
  });

  it('falling, high and low triggers', () => {
    const f = reg({ trigger: 'falling' });
    f.set({ d: '0011', en: '1', clk: '1' });
    expect(f.out('q')).toBe('0000');
    f.set({ clk: '0' });
    expect(f.out('q')).toBe('0011');
    const h = reg({ trigger: 'high' });
    h.set({ d: '0111', en: '1', clk: '1' });
    expect(h.out('q')).toBe('0111');
    h.set({ d: '0001' });
    expect(h.out('q')).toBe('0001');
    h.set({ clk: '0', d: '1111' });
    expect(h.out('q')).toBe('0001');
    const l = reg({ trigger: 'low' });
    l.set({ d: '1000', en: '1' });
    expect(l.out('q')).toBe('1000');
  });

  it('unknown data bits become x, unknown clock merges, unknown EN merges', () => {
    const r = reg();
    r.rise({ d: '01z1', en: '1' });
    expect(r.out('q')).toBe('01x1');
    const c = reg();
    c.rise({ d: '0101', en: '1' });
    c.set({ d: '0111', clk: 'z' });
    expect(c.out('q')).toBe('01x1');
    const e = reg();
    e.rise({ d: '0101', en: '1' });
    e.rise({ d: '0111', en: 'z' });
    expect(e.out('q')).toBe('01x1');
  });

  it('is as wide as configured', () => {
    const r = rig('register', { bits: 32 }, { d: 32, clk: 1 });
    r.rise({ d: '1'.repeat(32) });
    expect(r.out('q')).toBe('1'.repeat(32));
  });
});

describe('counter', () => {
  type Mode = 'wrap' | 'stay' | 'continue' | 'load';
  /** 4-bit counter with maximum 0xA, started at `start` by a load pulse, then D left at 0011. */
  function counterAt(mode: Mode, start: number, up: boolean) {
    const r = rig('counter', { bits: 4, max: 'A', overflow: mode }, { clk: 1, clr: 1, ld: 1, d: 4, en: 1, ud: 1 }, { en: '1', ud: up ? '1' : '0' });
    r.rise({ ld: '1', d: start.toString(2).padStart(4, '0') });
    r.set({ ld: '0', d: '0011' });
    expect(r.out('q')).toBe(start.toString(2).padStart(4, '0'));
    return r;
  }
  const q = (r: ReturnType<typeof counterAt>) => parseInt(r.out('q'), 2);

  it('counts up with carry only at the maximum', () => {
    const r = counterAt('wrap', 8, true);
    expect(r.out('co')).toBe('0');
    r.rise();
    expect([q(r), r.out('co')]).toEqual([9, '0']);
    r.rise();
    expect([q(r), r.out('co')]).toEqual([10, '1']);
  });

  it('wrap: max goes to 0 counting up, 0 goes to max counting down', () => {
    const up = counterAt('wrap', 10, true);
    up.rise();
    expect(q(up)).toBe(0);
    const down = counterAt('wrap', 0, false);
    expect(down.out('co')).toBe('1');
    down.rise();
    expect(q(down)).toBe(10);
    down.rise();
    expect([q(down), down.out('co')]).toEqual([9, '0']);
  });

  it('stay: saturates at max going up and at 0 going down', () => {
    const up = counterAt('stay', 9, true);
    up.rise();
    up.rise();
    up.rise();
    expect([q(up), up.out('co')]).toEqual([10, '1']);
    const down = counterAt('stay', 1, false);
    down.rise();
    down.rise();
    expect([q(down), down.out('co')]).toEqual([0, '1']);
  });

  it('continue: ignores max and wraps at the full bit width in both directions', () => {
    const up = counterAt('continue', 10, true);
    expect(up.out('co')).toBe('1');
    up.rise();
    expect([q(up), up.out('co')]).toEqual([11, '0']);
    for (let i = 0; i < 4; i++) up.rise();
    expect([q(up), up.out('co')]).toEqual([15, '1']);
    up.rise();
    expect(q(up)).toBe(0);
    const down = counterAt('continue', 0, false);
    down.rise();
    expect(q(down)).toBe(15);
    down.rise();
    expect(q(down)).toBe(14);
  });

  it('load: loads D on overflow in both directions', () => {
    const up = counterAt('load', 10, true);
    up.rise();
    expect(q(up)).toBe(3);
    const down = counterAt('load', 0, false);
    down.rise();
    expect(q(down)).toBe(3);
  });

  it('default max is all ones for the bit width', () => {
    const r = rig('counter', { bits: 3 }, { clk: 1, ld: 1, d: 3 });
    r.rise({ ld: '1', d: '110' });
    r.set({ ld: '0' });
    expect(r.out('co')).toBe('0');
    r.rise();
    expect([r.out('q'), r.out('co')]).toEqual(['111', '1']);
    r.rise();
    expect(r.out('q')).toBe('000');
  });

  it('LD wins over counting, EN=0 holds, unconnected EN and UD count up', () => {
    const r = rig('counter', { bits: 4 }, { clk: 1, ld: 1, d: 4, en: 1 }, { en: '1' });
    r.rise({ ld: '1', d: '0101' });
    expect(r.out('q')).toBe('0101');
    r.set({ ld: '0', en: '0' });
    r.rise();
    r.rise();
    expect(r.out('q')).toBe('0101');
    expect(r.out('co')).toBe('0');
    r.set({ en: '1' });
    r.rise();
    expect(r.out('q')).toBe('0110');
    const bare = rig('counter', { bits: 4 }, { clk: 1 });
    bare.rise();
    bare.rise();
    expect(bare.out('q')).toBe('0010');
  });

  it('carry needs the counter to be enabled', () => {
    const r = counterAt('wrap', 10, true);
    expect(r.out('co')).toBe('1');
    r.set({ en: '0' });
    expect(r.out('co')).toBe('0');
  });

  it('async clear beats load and clock', () => {
    const r = counterAt('wrap', 5, true);
    r.set({ clr: '1' });
    expect(r.out('q')).toBe('0000');
    r.rise({ ld: '1', d: '1111' });
    expect(r.out('q')).toBe('0000');
    r.set({ clr: '0', ld: '0' });
    r.rise();
    expect(r.out('q')).toBe('0001');
  });

  it('falling edge trigger counts on the falling edge', () => {
    const r = rig('counter', { bits: 4, trigger: 'falling' }, { clk: 1 });
    r.set({ clk: '1' });
    expect(r.out('q')).toBe('0000');
    r.set({ clk: '0' });
    expect(r.out('q')).toBe('0001');
  });

  it('unknown clock merges, unknown load data goes to x, unknown UD makes differing bits x', () => {
    const c = rig('counter', { bits: 4 }, { clk: 1 });
    c.set({ clk: 'z' });
    expect(c.out('q')).toBe('000x');
    const l = rig('counter', { bits: 4 }, { clk: 1, ld: 1, d: 4 });
    l.rise({ ld: '1', d: '10z0' });
    expect(l.out('q')).toBe('10x0');
    const u = rig('counter', { bits: 4 }, { clk: 1, ld: 1, d: 4, ud: 1 });
    u.rise({ ld: '1', d: '0100' });
    u.set({ ld: '0' });
    u.rise({ ud: 'z' });
    expect(u.out('q')).toBe('0xx1');
  });

  it('unknown counter value stays unknown until cleared', () => {
    const r = rig('counter', { bits: 4 }, { clk: 1, ld: 1, d: 4, clr: 1 });
    r.rise({ ld: '1', d: 'zzzz' });
    expect(r.out('q')).toBe('xxxx');
    r.set({ ld: '0' });
    r.rise();
    expect([r.out('q'), r.out('co')]).toEqual(['xxxx', 'x']);
    r.set({ clr: '1' });
    expect(r.out('q')).toBe('0000');
  });
});

describe('shift register', () => {
  it('shifts serial data through the stages; SO is the last stage', () => {
    const r = rig('shiftreg', { stages: 4, bits: 1 }, { clk: 1, si: 1, sh: 1, clr: 1 }, { sh: '1' });
    const so: string[] = [];
    for (const bit of '1011000') {
      r.rise({ si: bit });
      so.push(r.out('so'));
    }
    expect(so.join('')).toBe('0001011');
  });

  it('SH=0 holds, unconnected SH shifts', () => {
    const r = rig('shiftreg', { stages: 2 }, { clk: 1, si: 1, sh: 1 });
    r.rise({ si: '1', sh: '0' });
    r.rise({ si: '1', sh: '0' });
    expect(r.out('so')).toBe('0');
    const u = rig('shiftreg', { stages: 2 }, { clk: 1, si: 1 });
    u.rise({ si: '1' });
    u.rise({ si: '1' });
    expect(u.out('so')).toBe('1');
  });

  it('parallel mode exposes every stage; stage 0 receives SI', () => {
    const r = rig('shiftreg', { stages: 4, parallel: true }, { clk: 1, si: 1, clr: 1 });
    const stages = () => ['q0', 'q1', 'q2', 'q3'].map((n) => r.out(n)).join('');
    r.rise({ si: '1' });
    expect(stages()).toBe('1000');
    r.rise({ si: '0' });
    expect(stages()).toBe('0100');
    r.rise({ si: '1' });
    expect(stages()).toBe('1010');
  });

  it('parallel load takes priority over shifting; clear over load', () => {
    const r = rig('shiftreg', { stages: 3, parallel: true, bits: 2 }, { clk: 1, si: 2, ld: 1, d0: 2, d1: 2, d2: 2, clr: 1 }, { si: '11' });
    const stages = () => ['q0', 'q1', 'q2'].map((n) => r.out(n)).join(' ');
    r.rise({ ld: '1', d0: '01', d1: '10', d2: '11' });
    expect(stages()).toBe('01 10 11');
    expect(r.out('so')).toBe('11');
    r.set({ ld: '0' });
    r.rise();
    expect(stages()).toBe('11 01 10');
    r.set({ clr: '1' });
    expect(stages()).toBe('00 00 00');
    r.rise({ ld: '1', d0: '01', d1: '01', d2: '01' });
    expect(stages()).toBe('00 00 00');
    r.set({ clr: '0', ld: '0' });
    expect(stages()).toBe('00 00 00');
  });

  it('unknown clock merges per stage; unknown input bits are stored as x', () => {
    const r = rig('shiftreg', { stages: 2, parallel: true }, { clk: 1, si: 1 }, { si: '1' });
    r.set({ clk: 'z' });
    expect([r.out('q0'), r.out('q1')]).toEqual(['x', '0']);
    const u = rig('shiftreg', { stages: 2, parallel: true }, { clk: 1, si: 1 });
    u.rise({ si: 'z' });
    expect([u.out('q0'), u.out('q1')]).toEqual(['x', '0']);
  });

  it('a single stage behaves as a register on SI', () => {
    const r = rig('shiftreg', { stages: 1 }, { clk: 1, si: 1 });
    r.rise({ si: '1' });
    expect(r.out('so')).toBe('1');
  });
});

describe('random generator', () => {
  const rnd = (props: Record<string, unknown>, inputs: Record<string, number> = { clk: 1, en: 1, clr: 1 }, init: Record<string, string> = { en: '1' }) => rig('random', props, inputs, init);
  const run = (r: ReturnType<typeof rnd>, n: number) =>
    Array.from({ length: n }, () => {
      r.rise();
      return parseInt(r.out('out'), 2);
    });

  it('xorshift32 matches the reference value for state 1', () => {
    expect(xorshift32(1)).toBe(270369);
  });

  it('outputs the low bits of the xorshift32 sequence starting from the seed', () => {
    const r = rnd({ bits: 32, seed: 1 });
    expect(r.out('out')).toBe('1'.padStart(32, '0'));
    const expected: number[] = [];
    let s = 1;
    for (let i = 0; i < 5; i++) expected.push((s = xorshift32(s)));
    expect(run(r, 5)).toEqual(expected);
  });

  it('same seed gives the same sequence, different seeds differ', () => {
    const a = run(rnd({ bits: 16, seed: 77 }), 12);
    const b = run(rnd({ bits: 16, seed: 77 }), 12);
    const c = run(rnd({ bits: 16, seed: 78 }), 12);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('seed 0 means a fixed default, and is deterministic', () => {
    const a = run(rnd({ bits: 16, seed: 0 }), 6);
    const b = run(rnd({ bits: 16 }), 6);
    expect(a).toEqual(b);
    expect(a.some((v) => v !== 0)).toBe(true);
    const r = rnd({ bits: 8 });
    expect(parseInt(r.out('out'), 2)).toBe(0x2545f491 & 0xff);
  });

  it('EN=0 holds and unconnected EN advances', () => {
    const r = rnd({ bits: 8, seed: 5 }, { clk: 1, en: 1 }, { en: '0' });
    const before = r.out('out');
    r.rise();
    r.rise();
    expect(r.out('out')).toBe(before);
    const u = rnd({ bits: 8, seed: 5 }, { clk: 1 }, {});
    u.rise();
    expect(u.out('out')).not.toBe(before);
  });

  it('CLR returns to the seed and replays the same sequence; simulation reset does too', () => {
    const r = rnd({ bits: 12, seed: 9 });
    const first = run(r, 4);
    r.set({ clr: '1' });
    expect(r.out('out')).toBe((9 & 0xfff).toString(2).padStart(12, '0'));
    r.set({ clr: '0' });
    expect(run(r, 4)).toEqual(first);
    r.sim.reset();
    r.set({ en: '1' });
    expect(run(r, 4)).toEqual(first);
  });

  it('unknown clock makes the output unknown until cleared', () => {
    const r = rnd({ bits: 4, seed: 3 });
    r.set({ clk: 'z' });
    expect(r.out('out')).toBe('xxxx');
    r.set({ clk: '0' });
    r.rise();
    expect(r.out('out')).toBe('xxxx');
    r.set({ clr: '1' });
    expect(r.out('out')).toBe('0011');
  });
});

describe('RAM', () => {
  const bin = (n: number, w: number) => n.toString(2).padStart(w, '0');
  const ramRig = (props: Record<string, unknown> = {}, inputs: Record<string, number> = { a: 4, din: 8, we: 1, clk: 1, clr: 1 }, init: Record<string, string> = {}) =>
    rig('ram', { addrBits: 4, dataBits: 8, ...props }, inputs, init);
  const write = (r: ReturnType<typeof ramRig>, a: number, v: number) => r.rise({ a: bin(a, 4), din: bin(v, 8), we: '1' });

  it('writes on the clock edge only when WE=1 and reads back asynchronously', () => {
    const r = ramRig();
    expect(r.out('dout')).toBe('00000000');
    r.set({ a: bin(3, 4), din: bin(0xab, 8), we: '1' });
    expect(r.out('dout')).toBe('00000000');
    r.set({ clk: '1' });
    expect(r.out('dout')).toBe(bin(0xab, 8));
    r.set({ clk: '0' });
    r.set({ a: bin(4, 4) });
    expect(r.out('dout')).toBe('00000000');
    r.set({ a: bin(3, 4) });
    expect(r.out('dout')).toBe(bin(0xab, 8));
    r.rise({ din: bin(0xff, 8), we: '0' });
    expect(r.out('dout')).toBe(bin(0xab, 8));
  });

  it('data changing while the clock is steady does not write', () => {
    const r = ramRig();
    r.set({ we: '1', a: bin(1, 4), din: bin(5, 8), clk: '1' });
    r.set({ din: bin(9, 8) });
    expect(r.out('dout')).toBe(bin(5, 8));
  });

  it('falling edge trigger writes on the falling edge', () => {
    const r = ramRig({ trigger: 'falling' });
    r.set({ we: '1', a: bin(2, 4), din: bin(7, 8), clk: '1' });
    expect(r.out('dout')).toBe('00000000');
    r.set({ clk: '0' });
    expect(r.out('dout')).toBe(bin(7, 8));
  });

  it('clocked read updates the output only on the clock edge, after the write', () => {
    const r = ramRig({ asyncRead: false });
    write(r, 5, 0x5a);
    expect(r.out('dout')).toBe(bin(0x5a, 8));
    r.set({ a: bin(6, 4) });
    expect(r.out('dout')).toBe(bin(0x5a, 8));
    r.rise({ we: '0' });
    expect(r.out('dout')).toBe('00000000');
    r.set({ a: bin(5, 4) });
    expect(r.out('dout')).toBe('00000000');
    r.rise({ we: '0' });
    expect(r.out('dout')).toBe(bin(0x5a, 8));
  });

  it('OE=0 floats the output, OE=unknown is x', () => {
    const r = ramRig({}, { a: 4, din: 8, we: 1, oe: 1, clk: 1 }, { oe: '1' });
    r.rise({ a: bin(1, 4), din: bin(1, 8), we: '1' });
    expect(r.out('dout')).toBe('00000001');
    r.set({ oe: '0' });
    expect(r.out('dout')).toBe('zzzzzzzz');
    r.set({ oe: 'z' });
    expect(r.out('dout')).toBe('xxxxxxxx');
  });

  it('unknown address reads as x and a write to it changes nothing', () => {
    const r = ramRig();
    write(r, 0, 0xff);
    r.rise({ a: '00z0', din: bin(0x11, 8), we: '1' });
    expect(r.out('dout')).toBe('xxxxxxxx');
    expect(ramContents(r.sim.stateOf(r.id) as RamState)).toEqual({ 0: 0xff });
    r.set({ a: bin(2, 4) });
    expect(r.out('dout')).toBe('00000000');
  });

  it('unknown WE or clock on a known address merges old and new data', () => {
    const r = ramRig();
    r.set({ a: bin(1, 4), din: bin(0x0f, 8), we: 'z', clk: '1' });
    expect(r.out('dout')).toBe('0000xxxx');
    const c = ramRig();
    c.set({ a: bin(1, 4), din: bin(0x0f, 8), we: '1', clk: 'z' });
    expect(c.out('dout')).toBe('0000xxxx');
    const same = ramRig();
    same.set({ a: bin(1, 4), din: bin(0, 8), we: 'z', clk: '1' });
    expect(same.out('dout')).toBe('00000000');
  });

  it('writing unknown data stores unknown bits; a later write fixes them', () => {
    const r = ramRig();
    r.rise({ a: bin(2, 4), din: '1z1z1z1z', we: '1' });
    expect(r.out('dout')).toBe('1x1x1x1x');
    write(r, 2, 0x81);
    expect(r.out('dout')).toBe(bin(0x81, 8));
  });

  it('CLR empties the memory at once and beats a simultaneous write', () => {
    const r = ramRig();
    write(r, 1, 1);
    write(r, 2, 2);
    r.set({ a: bin(2, 4), clr: '1' });
    expect(r.out('dout')).toBe('00000000');
    write(r, 1, 9);
    r.set({ clr: '0', a: bin(1, 4) });
    expect(r.out('dout')).toBe('00000000');
    expect(ramContents(r.sim.stateOf(r.id) as RamState)).toEqual({});
  });

  it('CLR also clears a clocked read register', () => {
    const r = ramRig({ asyncRead: false });
    write(r, 1, 3);
    expect(r.out('dout')).toBe('00000011');
    r.set({ clr: '1' });
    expect(r.out('dout')).toBe('00000000');
  });

  it('state stays sparse and ramSetWord edits leave the original untouched', () => {
    const r = ramRig({ addrBits: 16, dataBits: 32 }, { a: 16, din: 32, we: 1, clk: 1 });
    r.rise({ a: '1111111111111111', din: '1'.repeat(32), we: '1' });
    const s = r.sim.stateOf(r.id) as RamState;
    expect(ramContents(s)).toEqual({ 65535: 0xffffffff });
    const edited = ramSetWord(s, 7, 0x1_0000_0005);
    expect(ramContents(edited)).toEqual({ 65535: 0xffffffff, 7: 5 });
    expect(ramContents(s)).toEqual({ 65535: 0xffffffff });
    expect(ramContents(ramSetWord(edited, 7, 0))).toEqual({ 65535: 0xffffffff });
    const copy = ramContents(s);
    copy[1] = 1;
    expect(ramContents(s)[1]).toBeUndefined();
  });

  it('UI edits through setState show up on the output', () => {
    const r = ramRig();
    r.set({ a: bin(9, 4) });
    r.sim.setState(r.id, ramSetWord(r.sim.stateOf(r.id) as RamState, 9, 0x42));
    r.sim.settle();
    expect(r.out('dout')).toBe(bin(0x42, 8));
  });

  it('simulation reset empties the RAM', () => {
    const r = ramRig();
    write(r, 4, 4);
    r.sim.reset();
    r.set({ a: bin(4, 4) });
    expect(r.out('dout')).toBe('00000000');
  });

  describe('single shared bus', () => {
    function busRig(props: Record<string, unknown> = {}) {
      const t = new T();
      const id = t.add('ram', { addrBits: 4, dataBits: 8, bus: 'single', ...props });
      const pins: Record<string, string> = {};
      const mk = (name: string, width: number, value: string, to: string, tri = true) => {
        const p = t.add('pin', { io: 'in', bits: width, behavior: tri ? 'tristate' : 'simple', value });
        t.wire(p, 'p', id, to);
        pins[name] = p;
      };
      mk('a', 4, '0000', 'a');
      mk('we', 1, '0', 'we');
      mk('oe', 1, '0', 'oe');
      mk('clk', 1, '0', 'clk');
      mk('ext', 8, 'zzzzzzzz', 'd');
      const probe = t.add('probe');
      t.wire(id, 'd', probe, 'p');
      const sim = t.sim();
      const set = (v: Record<string, string>) => {
        for (const [k, val] of Object.entries(v)) sim.setRuntime(pins[k], 'value', val);
        sim.settle();
      };
      return { sim, set, id, bus: () => str(sim.value(probe, 'p')), t };
    }

    it('has one io data pin and no din/dout', () => {
      const r = busRig();
      const pins = pinsOf(r.t.c.components[r.id]).map((p) => [p.name, p.dir]);
      expect(pins).toContainEqual(['d', 'io']);
      expect(pins.map(([n]) => n)).not.toContain('dout');
      expect(pins.map(([n]) => n)).not.toContain('din');
    });

    it('writes the bus value on the edge, then drives it only while OE=1 and WE=0', () => {
      const r = busRig();
      r.set({ a: '0101', ext: bin(0xc3, 8), we: '1', oe: '1' });
      expect(r.bus()).toBe(bin(0xc3, 8));
      r.set({ clk: '1' });
      r.set({ clk: '0' });
      r.set({ we: '0', ext: 'zzzzzzzz' });
      expect(r.bus()).toBe(bin(0xc3, 8));
      r.set({ oe: '0' });
      expect(r.bus()).toBe('zzzzzzzz');
      r.set({ oe: '1', we: '1' });
      expect(r.bus()).toBe('zzzzzzzz');
      r.set({ oe: '1', we: '0', a: '0110' });
      expect(r.bus()).toBe('00000000');
    });

    it('floats when OE or WE are unknown only if one of them forces release', () => {
      const r = busRig();
      r.set({ oe: 'z', we: '0' });
      expect(r.bus()).toBe('xxxxxxxx');
      r.set({ oe: 'z', we: '1' });
      expect(r.bus()).toBe('zzzzzzzz');
    });

    it('clocked read mode drives the output register', () => {
      const r = busRig({ asyncRead: false });
      r.set({ a: '0001', ext: bin(0x77, 8), we: '1' });
      r.set({ clk: '1' });
      r.set({ clk: '0' });
      r.set({ we: '0', ext: 'zzzzzzzz', oe: '1', a: '0010' });
      expect(r.bus()).toBe(bin(0x77, 8));
      r.set({ clk: '1' });
      r.set({ clk: '0' });
      expect(r.bus()).toBe('00000000');
    });
  });
});

describe('ROM', () => {
  const romRig = (contents: string, props: Record<string, unknown> = {}, inputs: Record<string, number> = { a: 4 }) =>
    rig('rom', { addrBits: 4, dataBits: 8, contents, ...props }, inputs);
  const at = (r: ReturnType<typeof romRig>, a: number) => {
    r.set({ a: a.toString(2).padStart(4, '0') });
    return r.out('d');
  };

  it('reads whitespace-separated hex words, address 0 first', () => {
    const r = romRig('1 2\nff   10\t7');
    expect([0, 1, 2, 3, 4].map((a) => parseInt(at(r, a), 2))).toEqual([1, 2, 0xff, 0x10, 7]);
  });

  it('missing words read as 0, including past the end of short contents', () => {
    const r = romRig('A5');
    expect(at(r, 0)).toBe('10100101');
    expect(at(r, 1)).toBe('00000000');
    expect(at(r, 15)).toBe('00000000');
    expect(at(romRig(''), 3)).toBe('00000000');
  });

  it('words are cut to the data width and case does not matter', () => {
    const r = romRig('ff aB', { dataBits: 4 });
    expect(at(r, 0)).toBe('1111');
    expect(at(r, 1)).toBe('1011');
    expect(parseRomContents('1FF', 8)).toEqual([0xff]);
  });

  it('is 32 bits wide at most and exact', () => {
    const r = romRig('DEADBEEF', { dataBits: 32 });
    expect(parseInt(at(r, 0), 2) >>> 0).toBe(0xdeadbeef);
  });

  it('unknown address reads as x', () => {
    const r = romRig('1 2 3');
    expect(at(r, 1)).toBe('00000010');
    r.set({ a: '00z1' });
    expect(r.out('d')).toBe('xxxxxxxx');
  });

  it('unconnected address reads as x', () => {
    const t = new T();
    const id = t.add('rom', { contents: '5' });
    expect(str(t.sim().value(id, 'd'))).toBe('xxxxxxxx');
  });

  it('OE=0 floats the output, unknown OE is x, unconnected OE reads as 1', () => {
    const r = romRig('9', {}, { a: 4, oe: 1 });
    r.set({ oe: '1' });
    expect(r.out('d')).toBe('00001001');
    r.set({ oe: '0' });
    expect(r.out('d')).toBe('zzzzzzzz');
    r.set({ oe: 'z' });
    expect(r.out('d')).toBe('xxxxxxxx');
  });

  it('is persistent: contents survive a simulation reset', () => {
    expect(getDef('rom').persistent).toBe(true);
    expect(getDef('rom').sequential).toBeFalsy();
    const r = romRig('3C');
    r.sim.reset();
    expect(at(r, 0)).toBe('00111100');
  });

  it('re-parses when contents or width change', () => {
    expect(parseRomContents('1 2', 8)).toEqual([1, 2]);
    expect(parseRomContents('1 2', 1)).toEqual([1, 0]);
    expect(parseRomContents('3', 8)).toEqual([3]);
  });
});
