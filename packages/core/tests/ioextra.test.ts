import { describe, expect, it } from 'vitest';
import { bits, fromStates, type Bits } from '../src/bits';
import { LIBRARY, getDef, pinsOf, sanitizeProps } from '../src/library';
import { IO_EXTRA, keyboardType, matrixPixels, ttyWrite, type KeyboardState, type TtyState } from '../src/parts/ioextra';
import { T, str } from './helpers';

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
  const rise = (extra: Record<string, string> = {}) => {
    set({ ...extra, clk: '1' });
    set({ clk: '0' });
  };
  return { t, id, sim, set, rise, out: (pin: string) => str(sim.value(id, pin)) };
}

const bin = (n: number, w: number) => n.toString(2).padStart(w, '0');

describe('extra I/O library', () => {
  it('registers the parts with the right categories and flags', () => {
    expect(LIBRARY.get('keyboard')?.category).toBe('Inputs');
    expect(LIBRARY.get('slider')?.category).toBe('Inputs');
    expect(LIBRARY.get('tty')?.category).toBe('Outputs');
    expect(LIBRARY.get('ledmatrix')?.category).toBe('Outputs');
    expect(getDef('ledmatrix').sink).toBe(true);
    expect(getDef('slider').source).toBe(true);
    expect(getDef('keyboard').sequential).toBe(true);
    expect(getDef('tty').sequential).toBe(true);
    expect(new Set(IO_EXTRA.map((d) => d.type)).size).toBe(IO_EXTRA.length);
  });

  it('pins sit on the 10px grid with unique names, in every matrix mode', () => {
    const variants: [string, Record<string, unknown>][] = [
      ['keyboard', {}],
      ['tty', { rows: 32, cols: 64 }],
      ['slider', { bits: 8 }],
      ['ledmatrix', { input: 'columns', rows: 16, cols: 16 }],
      ['ledmatrix', { input: 'rows', rows: 7, cols: 3 }],
      ['ledmatrix', { input: 'select', rows: 5, cols: 8 }],
    ];
    for (const [type, props] of variants) {
      const t = new T();
      const id = t.add(type, props);
      const comp = t.c.components[id];
      const pins = pinsOf(comp);
      expect(new Set(pins.map((p) => p.name)).size).toBe(pins.length);
      const size = getDef(type).size(comp.props);
      for (const p of pins) {
        expect(p.x % 10, `${type}.${p.name} x`).toBe(0);
        expect(p.y % 10, `${type}.${p.name} y`).toBe(0);
        expect(p.x).toBeLessThanOrEqual(size.w);
        expect(p.y).toBeLessThanOrEqual(size.h);
      }
    }
  });
});

describe('keyboard', () => {
  const kb = (props: Record<string, unknown> = {}) => {
    const r = rig('keyboard', props, { clk: 1, re: 1, clr: 1 }, { re: '1' });
    const type = (s: string) => {
      for (const ch of s) r.sim.setState(r.id, keyboardType(r.sim.stateOf(r.id) as KeyboardState, ch, (props.length as number) ?? 32));
      r.sim.settle();
    };
    return { ...r, type };
  };

  it('is empty at start: data 0, avail 0', () => {
    const r = kb();
    expect([r.out('data'), r.out('avail')]).toEqual(['0000000', '0']);
  });

  it('shows the oldest typed character and removes it on each read edge, in order', () => {
    const r = kb();
    r.type('Hi!');
    expect([r.out('data'), r.out('avail')]).toEqual([bin(72, 7), '1']);
    r.rise();
    expect(r.out('data')).toBe(bin(105, 7));
    r.rise();
    expect(r.out('data')).toBe(bin(33, 7));
    r.rise();
    expect([r.out('data'), r.out('avail')]).toEqual(['0000000', '0']);
    r.rise();
    expect(r.out('avail')).toBe('0');
  });

  it('does not remove anything while RE=0, but does when RE is unconnected', () => {
    const r = kb();
    r.type('ab');
    r.set({ re: '0' });
    r.rise();
    expect(r.out('data')).toBe(bin(97, 7));
    const u = rig('keyboard', {}, { clk: 1 });
    u.sim.setState(u.id, keyboardType(u.sim.stateOf(u.id) as KeyboardState, 'q'));
    u.sim.settle();
    u.rise();
    expect(u.out('avail')).toBe('0');
  });

  it('removes only on the chosen edge', () => {
    const r = kb({ trigger: 'falling' });
    r.type('xy');
    r.set({ clk: '1' });
    expect(r.out('data')).toBe(bin(120, 7));
    r.set({ clk: '0' });
    expect(r.out('data')).toBe(bin(121, 7));
  });

  it('CLR empties the buffer at once and beats a simultaneous read', () => {
    const r = kb();
    r.type('abc');
    r.set({ clr: '1' });
    expect([r.out('data'), r.out('avail')]).toEqual(['0000000', '0']);
    r.set({ clr: '0' });
    r.type('z');
    expect(r.out('data')).toBe(bin(122, 7));
  });

  it('ignores an unknown clock or unknown RE (nothing is removed)', () => {
    const r = kb();
    r.type('ab');
    r.set({ clk: 'z' });
    expect(r.out('data')).toBe(bin(97, 7));
    r.set({ clk: '0', re: 'z' });
    r.rise();
    expect(r.out('data')).toBe(bin(97, 7));
  });

  it('keyboardType is pure, limits the buffer, and rejects non-ASCII', () => {
    const s0: KeyboardState = { buffer: '', clk: null };
    const s1 = keyboardType(s0, 'a', 3);
    expect(s0.buffer).toBe('');
    expect(s1.buffer).toBe('a');
    const full = keyboardType(keyboardType(keyboardType(s1, 'b', 3), 'c', 3), 'd', 3);
    expect(full.buffer).toBe('abc');
    expect(keyboardType(s0, 'é').buffer).toBe('');
    expect(keyboardType(s0, '').buffer).toBe('');
    expect(keyboardType(s0, '\n').buffer).toBe('\n');
    expect(keyboardType(s0, 'x', 0).buffer).toBe('x');
    expect(sanitizeProps('keyboard', { length: 999 }).length).toBe(256);
  });
});

describe('terminal', () => {
  const tty = (props: Record<string, unknown> = {}) => {
    const r = rig('tty', { rows: 3, cols: 4, ...props }, { data: 7, clk: 1, we: 1, clr: 1 }, { we: '1' });
    const lines = () => (r.sim.stateOf(r.id) as TtyState).lines;
    const put = (...codes: number[]) => codes.forEach((c) => r.rise({ data: bin(c, 7) }));
    const text = (s: string) => put(...[...s].map((c) => c.charCodeAt(0)));
    return { ...r, lines, put, text };
  };

  it('starts with one empty line and appends printable characters on the clock edge', () => {
    const r = tty();
    expect(r.lines()).toEqual(['']);
    r.set({ data: bin(65, 7) });
    expect(r.lines()).toEqual(['']);
    r.text('ab');
    expect(r.lines()).toEqual(['ab']);
  });

  it('newline (10) starts a new line', () => {
    const r = tty();
    r.text('ab');
    r.put(10);
    r.text('c');
    expect(r.lines()).toEqual(['ab', 'c']);
  });

  it('backspace (8) deletes within the line and stops at the start of a line', () => {
    const r = tty();
    r.text('abc');
    r.put(8);
    expect(r.lines()).toEqual(['ab']);
    r.put(10, 8, 8);
    expect(r.lines()).toEqual(['ab', '']);
    r.text('x');
    expect(r.lines()).toEqual(['ab', 'x']);
  });

  it('form feed (12) clears the screen', () => {
    const r = tty();
    r.text('abc');
    r.put(10);
    r.text('de');
    r.put(12);
    expect(r.lines()).toEqual(['']);
    r.text('z');
    expect(r.lines()).toEqual(['z']);
  });

  it('wraps at the column limit and scrolls the oldest line away', () => {
    const r = tty();
    r.text('abcd');
    expect(r.lines()).toEqual(['abcd']);
    r.text('e');
    expect(r.lines()).toEqual(['abcd', 'e']);
    r.text('fghijklmn');
    expect(r.lines()).toEqual(['efgh', 'ijkl', 'mn']);
    r.put(10);
    expect(r.lines()).toEqual(['ijkl', 'mn', '']);
  });

  it('ignores other control and non-printable codes', () => {
    const r = tty();
    r.text('a');
    r.put(0, 7, 13, 27, 127);
    expect(r.lines()).toEqual(['a']);
  });

  it('WE=0 blocks writes; unconnected WE writes; falling trigger writes on the falling edge', () => {
    const r = tty();
    r.set({ we: '0' });
    r.text('a');
    expect(r.lines()).toEqual(['']);
    const u = rig('tty', { rows: 2, cols: 4 }, { data: 7, clk: 1 });
    u.rise({ data: bin(66, 7) });
    expect((u.sim.stateOf(u.id) as TtyState).lines).toEqual(['B']);
    const f = tty({ trigger: 'falling' });
    f.set({ data: bin(67, 7), clk: '1' });
    expect(f.lines()).toEqual(['']);
    f.set({ clk: '0' });
    expect(f.lines()).toEqual(['C']);
  });

  it('CLR clears at once and beats a simultaneous write', () => {
    const r = tty();
    r.text('abc');
    r.set({ clr: '1' });
    expect(r.lines()).toEqual(['']);
    r.text('d');
    expect(r.lines()).toEqual(['']);
    r.set({ clr: '0' });
    r.text('e');
    expect(r.lines()).toEqual(['e']);
  });

  it('unknown data, unknown clock and unknown WE write nothing', () => {
    const r = tty();
    r.rise({ data: '10z0001' });
    r.set({ data: bin(65, 7), clk: 'z' });
    r.set({ clk: '0', we: 'z' });
    r.rise();
    expect(r.lines()).toEqual(['']);
  });

  it('ttyWrite is pure and handles a single row', () => {
    const before = ['ab'];
    expect(ttyWrite(before, 99, 1, 4)).toEqual(['abc']);
    expect(before).toEqual(['ab']);
    expect(ttyWrite(['abcd'], 101, 1, 4)).toEqual(['e']);
    expect(ttyWrite(['ab'], 10, 1, 4)).toEqual(['']);
    expect(ttyWrite([], 65, 2, 4)).toEqual(['A']);
  });
});

describe('LED matrix', () => {
  const reader = (m: Record<string, Bits>) => (name: string) => m[name] ?? fromStates([...Array(8)].map(() => 'z' as const));
  const grid = (px: boolean[][]) => px.map((row) => row.map((b) => (b ? '#' : '.')).join(''));
  const props = (p: Record<string, unknown>) => sanitizeProps('ledmatrix', p);

  it('columns mode: one pin per column, bit 0 is the bottom row', () => {
    const px = matrixPixels(props({ rows: 3, cols: 4, input: 'columns' }), reader({ c0: bits(3, 0b001), c1: bits(3, 0b110), c2: bits(3, 0b111), c3: bits(3, 0) }));
    expect(grid(px)).toEqual(['.##.', '.##.', '#.#.']);
  });

  it('rows mode: one pin per row, bit 0 is the rightmost column', () => {
    const px = matrixPixels(props({ rows: 3, cols: 4, input: 'rows' }), reader({ r0: bits(4, 0b0001), r1: bits(4, 0b1000), r2: bits(4, 0b0110) }));
    expect(grid(px)).toEqual(['...#', '#...', '.##.']);
  });

  it('select mode: a pixel lights when both its row bit and column bit are 1', () => {
    const px = matrixPixels(props({ rows: 3, cols: 4, input: 'select' }), reader({ r: bits(3, 0b101), c: bits(4, 0b0011) }));
    expect(grid(px)).toEqual(['..##', '....', '..##']);
    expect(grid(matrixPixels(props({ rows: 3, cols: 4, input: 'select' }), reader({ r: bits(3, 0b111), c: bits(4, 0) })))).toEqual(['....', '....', '....']);
  });

  it('unknown, floating and conflicting bits are dark, known neighbours still light', () => {
    const mixed = fromStates([1, 'x', 'z', 'e']);
    const px = matrixPixels(props({ rows: 4, cols: 1, input: 'columns' }), reader({ c0: mixed }));
    expect(grid(px)).toEqual(['.', '.', '.', '#']);
    const sel = matrixPixels(props({ rows: 2, cols: 2, input: 'select' }), reader({ r: fromStates([1, 'x']), c: bits(2, 3) }));
    expect(grid(sel)).toEqual(['..', '##']);
  });

  it('returns rows by columns for every size and has no pins named outside its mode', () => {
    for (const input of ['columns', 'rows', 'select']) {
      const px = matrixPixels(props({ rows: 16, cols: 2, input }), reader({}));
      expect(px).toHaveLength(16);
      expect(px.every((row) => row.length === 2 && row.every((b) => !b))).toBe(true);
    }
    const t = new T();
    const id = t.add('ledmatrix', { rows: 2, cols: 3, input: 'rows' });
    expect(pinsOf(t.c.components[id]).map((p) => [p.name, p.width])).toEqual([['r0', 3], ['r1', 3]]);
    const s = t.add('ledmatrix', { rows: 2, cols: 3, input: 'select' });
    expect(pinsOf(t.c.components[s]).map((p) => [p.name, p.width])).toEqual([['r', 2], ['c', 3]]);
    const c = t.add('ledmatrix', { rows: 2, cols: 3 });
    expect(pinsOf(t.c.components[c]).map((p) => [p.name, p.width])).toEqual([['c0', 2], ['c1', 2], ['c2', 2]]);
  });

  it('reads the real nets in a simulation', () => {
    const t = new T();
    const m = t.add('ledmatrix', { rows: 2, cols: 1, input: 'columns' });
    const p = t.add('pin', { io: 'in', bits: 2, value: '01' });
    t.wire(p, 'p', m, 'c0');
    const sim = t.sim();
    expect(grid(matrixPixels(t.c.components[m].props, (n) => sim.value(m, n)))).toEqual(['.', '#']);
  });
});

describe('slider', () => {
  it('outputs its value at the configured width', () => {
    const t = new T();
    const id = t.add('slider', { bits: 4, value: 5 });
    const sim = t.sim();
    expect(str(sim.value(id, 'out'))).toBe('0101');
    sim.setRuntime(id, 'value', 15);
    sim.settle();
    expect(str(sim.value(id, 'out'))).toBe('1111');
  });

  it('cuts the value to the width and supports 1 to 8 bits', () => {
    const t = new T();
    const id = t.add('slider', { bits: 3, value: 255 });
    expect(str(t.sim().value(id, 'out'))).toBe('111');
    const big = t.add('slider', { bits: 99, value: 200 });
    expect(str(t.sim().value(big, 'out'))).toBe('11001000');
    expect(pinsOf(t.c.components[big])[0].width).toBe(8);
  });

  it('is a source, and its value is a runtime prop', () => {
    const d = getDef('slider');
    expect(d.source).toBe(true);
    expect(d.props.find((p) => p.key === 'value')!.runtime).toBe(true);
  });
});
