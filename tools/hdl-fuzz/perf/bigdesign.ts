import type { Cell, Design, NetId } from '@ihatecircuits/hdl/design';
import { designOf, ModuleBuilder } from '../src/irbuild';

/**
 * A synthetic single-module design with `cells` IR cells, built like ordinary logic: every cell reads recent nets
 * (a sliding window, so the circuit is deep and wide at once), with registers, muxes, adders, comparisons, slices
 * and concatenations mixed in. Deterministic in `seed`. Used by the layout and lowering timing tests.
 */
export function bigDesign(cells: number, seed = 1): Design {
  let s = seed >>> 0 || 1;
  const rnd = (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
  const m = new ModuleBuilder('top');
  const W = 8;
  const clk = m.input('clk', 1);
  const pool: NetId[] = [];
  for (let i = 0; i < 8; i++) pool.push(m.input(`in${i}`, W));
  const recent = () => pool[Math.max(0, pool.length - 1 - rnd(Math.min(pool.length, 24)))]!;
  const add = (cell: Cell, out: NetId) => {
    m.add(cell);
    pool.push(out);
  };
  const outs: NetId[] = [];
  while (m.cells.length < cells) {
    const out = m.net(W);
    const a = recent();
    const b = recent();
    switch (rnd(10)) {
      case 0: add({ kind: 'and', a, b, out }, out); break;
      case 1: add({ kind: 'or', a, b, out }, out); break;
      case 2: add({ kind: 'xor', a, b, out }, out); break;
      case 3: add({ kind: 'add', a, b, out }, out); break;
      case 4: add({ kind: 'not', a, out }, out); break;
      case 5: {
        const sel = m.net(1);
        m.add({ kind: 'slice', a, lsb: rnd(W), out: sel });
        add({ kind: 'mux', sel, onFalse: b, onTrue: recent(), out }, out);
        break;
      }
      case 6: add({ kind: 'dff', clk, edge: 'pos', d: a, q: out }, out); break;
      case 7: {
        const hi = m.net(4);
        const lo = m.net(4);
        m.add({ kind: 'slice', a, lsb: 4, out: hi });
        m.add({ kind: 'slice', a: b, lsb: 0, out: lo });
        add({ kind: 'concat', parts: [lo, hi], out }, out);
        break;
      }
      case 8: {
        const one = m.net(1);
        m.add({ kind: 'eq', a, b, out: one });
        const c = m.net(W);
        m.add({ kind: 'const', out: c, bits: (rnd(256)).toString(2).padStart(W, '0') });
        add({ kind: 'mux', sel: one, onFalse: a, onTrue: c, out }, out);
        break;
      }
      default: add({ kind: 'sub', a, b, out }, out);
    }
    if (rnd(40) === 0) outs.push(out);
  }
  outs.push(pool[pool.length - 1]!);
  outs.slice(-16).forEach((n, i) => m.output(`o${i}`, n));
  return designOf(m.build());
}

/**
 * `cells` independent word-level cells, each fed by its own literals and read by its own output port: the shape of the
 * exhaustive cell tests, one wide column of parts with a constant beside every pin.
 */
export function wideDesign(cells: number, seed = 1): Design {
  let s = seed >>> 0 || 1;
  const rnd = (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
  const W = 4;
  const m = new ModuleBuilder('top');
  const lit = () => {
    const out = m.net(W);
    m.add({ kind: 'const', out, bits: rnd(16).toString(2).padStart(W, '0') });
    return out;
  };
  const kinds = ['and', 'or', 'xor', 'add', 'sub', 'mul'] as const;
  for (let i = 0; i < cells; i++) {
    const out = m.net(W);
    m.add({ kind: kinds[i % kinds.length]!, a: lit(), b: lit(), out });
    m.output(`o${i}`, out);
  }
  return designOf(m.build());
}

/** `cells` multiplexers whose three operands are all literals, each into its own output port: a constant at every pin. */
export function constsDesign(cells: number, seed = 1): Design {
  let s = seed >>> 0 || 1;
  const rnd = (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
  const W = 4;
  const m = new ModuleBuilder('top');
  const lit = (w: number) => {
    const out = m.net(w);
    m.add({ kind: 'const', out, bits: rnd(2 ** w).toString(2).padStart(w, '0') });
    return out;
  };
  for (let i = 0; i < cells; i++) {
    const out = m.net(W);
    m.add({ kind: 'mux', sel: lit(1), onFalse: lit(W), onTrue: lit(W), out });
    m.output(`o${i}`, out);
  }
  return designOf(m.build());
}
