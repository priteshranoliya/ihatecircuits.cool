import { describe, expect, it } from 'vitest';
import { findXViolations, programProblems, xSources } from '../src/analysis';
import { CLOCK, RESET, TOP, exprDepthOf, exprRefs, walkStmts, type Expr, type Module, type Program, type Stmt } from '../src/ast';
import { DEFAULT_FEATURES, generateCase, parseFeatureList, renderModule, resolveFeatures, type Features } from '../src/gen';
import { compileCheck, iverilogAvailable, withoutWidthMismatchWarnings } from '../src/iverilog';

const ALL: Partial<Features> = { clocks: true, undriven: true };
const NONE: Features = { unreset: false, widthMismatch: false, clocks: false, wide: false, deep: false, undriven: false, init: false };

function stmtRegs(stmts: Stmt[], into: string[]): void {
  for (const s of walkStmts(stmts)) if (s.k === 'nb') into.push(s.lhs);
}

/** Structural guarantees: single drivers, one always block per reg, reads only of signals defined earlier (no loops). */
function checkModule(m: Module): void {
  const defined = new Set(m.ports.filter((p) => p.dir === 'in').map((p) => p.sig.name));
  const regs = new Set(m.ports.filter((p) => p.reg).map((p) => p.sig.name));
  for (const it of m.items) if (it.k === 'decl' && it.type === 'reg') regs.add(it.sig.name);
  for (const r of regs) defined.add(r);
  const clocks = new Set<string>([CLOCK]);
  const driven = new Map<string, number>();
  const drive = (n: string) => driven.set(n, (driven.get(n) ?? 0) + 1);
  const alwaysOf = new Map<string, number>();
  const declared = new Set<string>(defined);
  const undriven = new Set<string>();
  let always = 0;
  for (const it of m.items) {
    if (it.k === 'decl') {
      declared.add(it.sig.name);
      if (it.undriven) {
        expect(it.type, `${m.name}: only a wire can be undriven`).toBe('wire');
        undriven.add(it.sig.name);
        defined.add(it.sig.name);
      }
    } else if (it.k === 'gate') {
      clocks.add(it.name);
      expect(driven.has(it.name), `${m.name}: gate ${it.name} declared twice`).toBe(false);
      drive(it.name);
    } else if (it.k === 'assign') {
      const seen = exprRefs(it.rhs);
      for (const n of seen) expect(defined.has(n), `${m.name}: ${it.lhs} reads ${n} before it is defined`).toBe(true);
      drive(it.lhs);
      defined.add(it.lhs);
    } else if (it.k === 'inst') {
      for (const c of it.conns) {
        if (!c.expr) continue;
        if (c.port === CLOCK) {
          expect(c.expr.k === 'ref' && clocks.has(c.expr.name), `${m.name}: ${it.name}.clk must be clk or a gate`).toBe(true);
          continue;
        }
        if (c.port === RESET) continue;
        const seen = exprRefs(c.expr);
        if (c.expr.k === 'ref' && !defined.has(c.expr.name) && declared.has(c.expr.name)) {
          drive(c.expr.name);
          defined.add(c.expr.name);
        } else for (const n of seen) expect(defined.has(n), `${m.name}: ${it.name}.${c.port} reads ${n} before it is defined`).toBe(true);
      }
    } else if (it.k === 'always') {
      expect(clocks.has(it.clock), `${m.name}: always on ${it.clock}, which is not clk or a gate declared earlier`).toBe(true);
      const lhs: string[] = [];
      stmtRegs(it.body, lhs);
      stmtRegs(it.resets, lhs);
      if (!it.reset) expect(it.resets, `${m.name}: a block without reset has reset assignments`).toEqual([]);
      for (const r of new Set(lhs)) {
        expect(regs.has(r), `${m.name}: ${r} is not a reg`).toBe(true);
        expect(alwaysOf.has(r), `${m.name}: reg ${r} in two always blocks`).toBe(false);
        alwaysOf.set(r, always);
      }
      always++;
    }
  }
  for (const [n, count] of driven) expect(count, `${m.name}: ${n} has ${count} drivers`).toBe(1);
  for (const n of undriven) expect(driven.has(n), `${m.name}: wire ${n} is marked undriven but driven`).toBe(false);
  for (const p of m.ports) if (p.dir === 'out' && !p.reg) expect(driven.get(p.sig.name), `${m.name}: output ${p.sig.name} undriven`).toBe(1);
  for (const it of m.items) if (it.k === 'decl' && it.type === 'wire' && !it.undriven) expect(driven.get(it.sig.name), `${m.name}: wire ${it.sig.name} undriven`).toBe(1);
  for (const r of regs) expect(alwaysOf.has(r), `${m.name}: reg ${r} never assigned`).toBe(true);
}

const sources = (n: number, opts: { features?: Partial<Features>; size?: (seed: number) => number } = {}) =>
  Array.from({ length: n }, (_, seed) => generateCase(seed, { features: opts.features, size: opts.size?.(seed) ?? 1 + (seed % 8) }));

/** Self-determined width of an expression, given the declared width of every name. */
function widthOf(e: Expr, sig: (n: string) => number): number {
  switch (e.k) {
    case 'ref':
      return sig(e.name);
    case 'bit':
      return 1;
    case 'part':
      return e.hi - e.lo + 1;
    case 'lit':
      return e.width ?? Math.max(32, e.value.toString(2).length, e.pad ? e.pad * { b: 1, o: 3, h: 4, d: 0 }[e.base] : 0);
    case 'cat':
      return e.parts.reduce((n, p) => n + widthOf(p, sig), 0);
    case 'not':
    case 'paren':
      return widthOf(e.e, sig);
    case 'bin':
      return e.op === '==' || e.op === '!=' ? 1 : Math.max(widthOf(e.l, sig), widthOf(e.r, sig));
    case 'cond':
      return Math.max(widthOf(e.t, sig), widthOf(e.f, sig));
  }
}

function widthsIn(m: Module): Map<string, number> {
  const w = new Map<string, number>(m.ports.map((p) => [p.sig.name, p.sig.width]));
  for (const it of m.items) if (it.k === 'decl') w.set(it.sig.name, it.sig.width);
  return w;
}

/** Counts across a program: instance connections whose width differs from the port, by direction. */
function connMismatches(p: Program): { inWider: number; inNarrower: number; inSum: number; outNarrower: number } {
  const out = { inWider: 0, inNarrower: 0, inSum: 0, outNarrower: 0 };
  for (const m of p.modules) {
    const w = widthsIn(m);
    for (const it of m.items) {
      if (it.k !== 'inst') continue;
      const sub = p.modules.find((x) => x.name === it.module)!;
      for (const c of it.conns) {
        const port = sub.ports.find((q) => q.sig.name === c.port)!;
        if (!c.expr || c.port === CLOCK || c.port === RESET) continue;
        const cw = widthOf(c.expr, (n) => w.get(n)!);
        if (port.dir === 'out') {
          if (cw < port.sig.width) out.outNarrower++;
        } else if (cw > port.sig.width) out.inWider++;
        else if (cw < port.sig.width) {
          out.inNarrower++;
          if (c.expr.k === 'bin' && c.expr.op === '+') out.inSum++;
        }
      }
    }
  }
  return out;
}

function allExprs(m: Module): Expr[] {
  const out: Expr[] = [];
  for (const it of m.items) {
    if (it.k === 'assign') out.push(it.rhs);
    else if (it.k === 'inst') {
      for (const c of it.conns) if (c.expr && c.port !== CLOCK) out.push(c.expr);
    } else if (it.k === 'always') {
      for (const body of [it.body, it.resets]) for (const s of walkStmts(body)) out.push(s.k === 'nb' ? s.rhs : s.cond);
    }
  }
  return out;
}

function subExprs(e: Expr, visit: (x: Expr) => void): void {
  visit(e);
  if (e.k === 'cat') e.parts.forEach((p) => subExprs(p, visit));
  else if (e.k === 'not' || e.k === 'paren') subExprs(e.e, visit);
  else if (e.k === 'bin') (subExprs(e.l, visit), subExprs(e.r, visit));
  else if (e.k === 'cond') (subExprs(e.c, visit), subExprs(e.t, visit), subExprs(e.f, visit));
}

/** Left-spine length of a chain of one operator. */
function chainLength(e: Expr): number {
  if (e.k !== 'bin') return 1;
  let n = 1;
  let cur: Expr = e;
  while (cur.k === 'bin' && cur.op === e.op) {
    n++;
    cur = cur.l;
  }
  return n;
}

describe('generateCase', () => {
  it('is deterministic per seed and varies across seeds, sizes and features', () => {
    const a = generateCase(7);
    const b = generateCase(7);
    expect(b.source).toBe(a.source);
    expect(b.stimulus).toEqual(a.stimulus);
    expect(generateCase(8).source).not.toBe(a.source);
    expect(generateCase(7, { size: 6 }).source).not.toBe(a.source);
    expect(generateCase(7, { features: ALL }).source).toBe(generateCase(7, { features: ALL }).source);
    expect(sources(40, { features: ALL }).map((g) => g.source)).not.toEqual(sources(40).map((g) => g.source));
  });

  it('drives rst = 1 in cycle 0 and keeps stimulus widths consistent with the top ports', () => {
    for (const g of sources(60, { features: ALL })) {
      expect(g.stimulus[0]!.rst).toBe('1');
      const top = g.program.modules.at(-1)!;
      for (const cycle of g.stimulus) {
        expect(Object.keys(cycle).sort()).toEqual(top.ports.filter((p) => p.dir === 'in' && p.sig.name !== 'clk').map((p) => p.sig.name).sort());
        for (const p of top.ports) if (cycle[p.sig.name] !== undefined) expect(cycle[p.sig.name]).toMatch(new RegExp(`^[01]{${p.sig.width}}$`));
      }
    }
  });

  it('holds its structural guarantees on 300 seeds across sizes, default and every feature on', () => {
    for (const features of [undefined, ALL, NONE]) for (const g of sources(300, { features })) for (const m of g.program.modules) checkModule(m);
  });

  it('size grows the programs', () => {
    const len = (size: number) => Array.from({ length: 40 }, (_, s) => generateCase(s, { size }).source.length).reduce((a, b) => a + b, 0);
    expect(len(8)).toBeGreaterThan(len(3) * 1.5);
    expect(len(3)).toBeGreaterThan(len(1) * 1.5);
  });

  it('parses and resolves feature lists', () => {
    expect(parseFeatureList('')).toEqual({});
    expect(parseFeatureList('clocks, undriven,-deep,-width-mismatch')).toEqual({ clocks: true, undriven: true, deep: false, widthMismatch: false });
    expect(() => parseFeatureList('bogus')).toThrow(/unknown feature/);
    expect(resolveFeatures()).toEqual(DEFAULT_FEATURES);
    expect(DEFAULT_FEATURES).toMatchObject({ clocks: false, undriven: false, unreset: true, widthMismatch: true, wide: true, deep: true });
  });
});

describe('x-safety: an unreset reg never reaches an if condition', () => {
  it('holds on 300 seeds for every feature set', () => {
    for (const features of [undefined, ALL, { ...ALL, deep: false }]) {
      for (const g of sources(300, { features })) {
        expect(findXViolations(g.program), `seed ${g.seed}`).toEqual([]);
        expect(programProblems(g.program), `seed ${g.seed}`).toEqual([]);
      }
    }
  });

  it('is checked independently of the generator: module-local closure from unreset regs and undriven wires', () => {
    let unresetIfs = 0;
    for (const g of sources(300, { features: ALL })) {
      for (const m of g.program.modules) {
        const { unresetRegs, undrivenWires } = xSources(m);
        const t = new Set([...unresetRegs, ...undrivenWires]);
        const flows: Array<[string, Expr]> = [];
        for (const it of m.items) {
          if (it.k === 'assign') flows.push([it.lhs, it.rhs]);
          if (it.k === 'always') for (const body of [it.body, it.resets]) for (const s of walkStmts(body)) if (s.k === 'nb') flows.push([s.lhs, s.rhs]);
        }
        for (let changed = true; changed; ) {
          changed = false;
          for (const [lhs, rhs] of flows) if (!t.has(lhs) && [...exprRefs(rhs)].some((n) => t.has(n))) (t.add(lhs), (changed = true));
        }
        for (const it of m.items) {
          if (it.k !== 'always') continue;
          for (const body of [it.body, it.resets]) {
            for (const s of walkStmts(body)) {
              if (s.k !== 'if') continue;
              const bad = [...exprRefs(s.cond)].filter((n) => t.has(n));
              expect(bad, `seed ${g.seed} ${m.name}: if reads x-capable ${bad.join(',')}`).toEqual([]);
            }
          }
        }
        if (unresetRegs.size > 0) unresetIfs++;
      }
    }
    expect(unresetIfs).toBeGreaterThan(30);
  });

  it('a block with no reset holds no if, since it runs on the first edge while every reg is still x', () => {
    let blocks = 0;
    for (const g of sources(300, { features: ALL })) {
      for (const m of g.program.modules) {
        for (const it of m.items) {
          if (it.k !== 'always' || it.reset) continue;
          blocks++;
          expect([...walkStmts(it.body)].some((s) => s.k === 'if'), `seed ${g.seed} ${m.name}`).toBe(false);
        }
      }
    }
    expect(blocks).toBeGreaterThan(20);
    const sig = (name: string) => ({ name, width: 1, ranged: false });
    const ref = (name: string): Expr => ({ k: 'ref', name });
    const m: Module = {
      name: TOP,
      ports: [{ sig: sig('clk'), dir: 'in', reg: false }, { sig: sig('rst'), dir: 'in', reg: false }, { sig: sig('a'), dir: 'in', reg: false }, { sig: sig('y'), dir: 'out', reg: true }],
      items: [{ k: 'always', clock: CLOCK, reset: false, resets: [], body: [{ k: 'if', cond: ref('a'), then: [{ k: 'nb', lhs: 'y', rhs: ref('a') }], else: null }] }],
    };
    expect(findXViolations({ modules: [m] })).toHaveLength(1);
  });

  it('flags a hand-built violation, direct and through wires, regs and instances, and accepts ?: and ==', () => {
    const sig = (name: string, width = 1) => ({ name, width, ranged: width > 1 });
    const ref = (name: string): Expr => ({ k: 'ref', name });
    const clkRst = [
      { sig: sig('clk'), dir: 'in' as const, reg: false },
      { sig: sig('rst'), dir: 'in' as const, reg: false },
    ];
    const mod = (name: string, extraPorts: Module['ports'], items: Module['items']): Module => ({ name, ports: [...clkRst, ...extraPorts], items });
    const reg = (n: string) => ({ k: 'decl' as const, type: 'reg' as const, sig: sig(n) });
    const unresetBlock = (lhs: string, rhs: Expr, cond?: Expr) =>
      ({ k: 'always' as const, clock: CLOCK, reset: false, resets: [], body: cond ? [{ k: 'if' as const, cond, then: [{ k: 'nb' as const, lhs, rhs }], else: null }] : [{ k: 'nb' as const, lhs, rhs }] });
    const out = { sig: sig('y'), dir: 'out' as const, reg: true };

    const direct = mod(TOP, [out], [reg('u'), unresetBlock('u', ref('rst')), { k: 'always', clock: CLOCK, reset: true, resets: [{ k: 'nb', lhs: 'y', rhs: { k: 'lit', width: 1, base: 'b', value: 0 } }], body: [{ k: 'if', cond: ref('u'), then: [{ k: 'nb', lhs: 'y', rhs: ref('rst') }], else: null }] }]);
    expect(findXViolations({ modules: [direct] })).toHaveLength(1);

    const viaWire = mod(TOP, [out], [
      reg('u'),
      unresetBlock('u', ref('rst')),
      { k: 'decl', type: 'wire', sig: sig('w') },
      { k: 'assign', lhs: 'w', rhs: { k: 'not', e: ref('u') } },
      { k: 'decl', type: 'reg', sig: sig('v') },
      { k: 'always', clock: CLOCK, reset: true, resets: [{ k: 'nb', lhs: 'v', rhs: ref('rst') }, { k: 'nb', lhs: 'y', rhs: ref('rst') }], body: [{ k: 'nb', lhs: 'v', rhs: ref('w') }, { k: 'if', cond: ref('v'), then: [{ k: 'nb', lhs: 'y', rhs: ref('rst') }], else: null }] },
    ]);
    expect(findXViolations({ modules: [viaWire] })).toHaveLength(1);

    const safe = mod(TOP, [out], [
      reg('u'),
      unresetBlock('u', ref('rst')),
      { k: 'always', clock: CLOCK, reset: true, resets: [{ k: 'nb', lhs: 'y', rhs: ref('rst') }], body: [{ k: 'nb', lhs: 'y', rhs: { k: 'cond', c: ref('u'), t: ref('rst'), f: { k: 'bin', op: '==', l: ref('u'), r: ref('rst') } } }] },
    ]);
    expect(findXViolations({ modules: [safe] })).toEqual([]);

    const sub = mod('m0', [{ sig: sig('a'), dir: 'in', reg: false }, { sig: sig('o'), dir: 'out', reg: true }], [
      { k: 'always', clock: CLOCK, reset: true, resets: [{ k: 'nb', lhs: 'o', rhs: ref('rst') }], body: [{ k: 'if', cond: ref('a'), then: [{ k: 'nb', lhs: 'o', rhs: ref('rst') }], else: null }] },
    ]);
    const conn = (expr: Expr) => ({ k: 'inst' as const, module: 'm0', name: 'u0', conns: [{ port: 'clk', expr: ref('clk') }, { port: 'rst', expr: ref('rst') }, { port: 'a', expr }, { port: 'o', expr: null }] });
    const tainted = mod(TOP, [out], [reg('u'), unresetBlock('u', ref('rst')), conn(ref('u')), { k: 'always', clock: CLOCK, reset: true, resets: [{ k: 'nb', lhs: 'y', rhs: ref('rst') }], body: [{ k: 'nb', lhs: 'y', rhs: ref('rst') }] }]);
    expect(findXViolations({ modules: [sub, tainted] })).toHaveLength(1);
    const clean = mod(TOP, [out], [conn(ref('rst')), { k: 'always', clock: CLOCK, reset: true, resets: [{ k: 'nb', lhs: 'y', rhs: ref('rst') }], body: [{ k: 'nb', lhs: 'y', rhs: ref('rst') }] }]);
    expect(findXViolations({ modules: [sub, clean] })).toEqual([]);

    const subX = mod('m0', [{ sig: sig('o'), dir: 'out', reg: true }], [reg('u'), unresetBlock('u', ref('rst')), unresetBlock('o', ref('u'))]);
    const outIf = mod(TOP, [out], [
      { k: 'decl', type: 'wire', sig: sig('w') },
      { k: 'inst', module: 'm0', name: 'u0', conns: [{ port: 'clk', expr: ref('clk') }, { port: 'rst', expr: ref('rst') }, { port: 'o', expr: ref('w') }] },
      { k: 'always', clock: CLOCK, reset: true, resets: [{ k: 'nb', lhs: 'y', rhs: ref('rst') }], body: [{ k: 'if', cond: ref('w'), then: [{ k: 'nb', lhs: 'y', rhs: ref('rst') }], else: null }] },
    ]);
    expect(findXViolations({ modules: [subX, outIf] })).toHaveLength(1);
  });

  it('the generator reaches unreset regs and undriven wires, and only when the feature is on', () => {
    const count = (features: Partial<Features>) => {
      let unreset = 0;
      let undriven = 0;
      let noReset = 0;
      for (const g of sources(150, { features })) {
        for (const m of g.program.modules) {
          const x = xSources(m);
          unreset += x.unresetRegs.size;
          undriven += x.undrivenWires.size;
          noReset += m.items.filter((it) => it.k === 'always' && !it.reset).length;
        }
      }
      return { unreset, undriven, noReset };
    };
    const on = count({ ...ALL });
    expect(on.unreset).toBeGreaterThan(40);
    expect(on.noReset).toBeGreaterThan(5);
    expect(on.undriven).toBeGreaterThan(20);
    expect(count({})).toMatchObject({ undriven: 0 });
    expect(count({ unreset: false })).toMatchObject({ unreset: 0, noReset: 0, undriven: 0 });
  });

  it('the generator gives regs a power-on value (`reg [3:0] r = 4\'d5;`, `output reg q = 1\'b1`) only when the init feature is on', () => {
    const count = (features: Partial<Features>) => {
      let decls = 0;
      let ports = 0;
      let text = 0;
      for (const g of sources(150, { features })) {
        for (const m of g.program.modules) {
          decls += m.items.filter((it) => it.k === 'decl' && it.type === 'reg' && it.init).length;
          ports += m.ports.filter((p) => p.reg && p.init).length;
          text += (renderModule(m).match(/(reg|output reg) [^;,\n]*\w = /g) ?? []).length;
        }
      }
      return { decls, ports, text };
    };
    const on = count({});
    expect(on.decls).toBeGreaterThan(10);
    expect(on.ports).toBeGreaterThan(10);
    expect(on.text).toBe(on.decls + on.ports);
    expect(count({ init: false })).toEqual({ decls: 0, ports: 0, text: 0 });
  });

  it('shrink candidates are screened: a reduction that unresets a reg feeding an if is rejected', () => {
    let rejected = 0;
    for (const g of sources(300, { features: ALL })) {
      for (const m of g.program.modules) {
        for (let i = 0; i < m.items.length; i++) {
          const it = m.items[i]!;
          if (it.k !== 'always' || !it.reset || it.resets.length === 0) continue;
          const q = structuredClone(g.program);
          (q.modules.find((x) => x.name === m.name)!.items[i] as typeof it).resets = [];
          if (findXViolations(q).length > 0) {
            rejected++;
            expect(programProblems(q).length).toBeGreaterThan(0);
          }
        }
      }
    }
    expect(rejected).toBeGreaterThan(10);
    const q = structuredClone(generateCase(1).program);
    const m = q.modules.at(-1)!;
    m.items.splice(m.items.findIndex((it) => it.k === 'assign'), 1);
    expect(programProblems(q).join('\n')).toMatch(/undriven/);
  });
});

describe('derived clocks', () => {
  it('are `clk & input`, only in the top module, and only drive always blocks and instance clk ports', () => {
    let gates = 0;
    let gatedAlways = 0;
    let gatedInst = 0;
    for (const g of sources(300, { features: ALL })) {
      for (const m of g.program.modules) {
        const names = new Set<string>();
        for (const it of m.items) {
          if (it.k === 'gate') {
            gates++;
            names.add(it.name);
            expect(m.name, 'gates live in the top module').toBe(TOP);
            const en = m.ports.find((p) => p.sig.name === it.en);
            expect(en, `${it.name} gates on ${it.en}, which must be an input port`).toMatchObject({ dir: 'in', enable: true });
            expect(en!.sig.width).toBe(1);
            expect(renderModule({ ...m, items: [it] })).toMatch(it.inline ? new RegExp(`wire ${it.name} = clk & ${it.en};`) : new RegExp(`wire ${it.name};\\n  assign ${it.name} = clk & ${it.en};`));
          }
          if (it.k === 'always' && it.clock !== CLOCK) {
            gatedAlways++;
            expect(names.has(it.clock), `${it.clock} is declared before use`).toBe(true);
          }
          if (it.k === 'inst') {
            const c = it.conns.find((x) => x.port === CLOCK)!.expr;
            expect(c?.k).toBe('ref');
            const n = (c as Extract<Expr, { k: 'ref' }>).name;
            if (n !== CLOCK) (gatedInst++, expect(names.has(n)).toBe(true));
          }
          for (const e of it.k === 'assign' ? [it.rhs] : []) for (const r of exprRefs(e)) expect(names.has(r) || r === CLOCK, `${r} is read as data`).toBe(false);
        }
        if (m.name !== TOP) expect(m.ports.some((p) => p.enable)).toBe(false);
      }
      for (const m of g.program.modules) for (const e of allExprs(m)) for (const r of exprRefs(e)) expect(/^g\d+$/.test(r) || r === CLOCK, `seed ${g.seed}: clock net ${r} read as data`).toBe(false);
      const top = g.program.modules.at(-1)!;
      for (const p of top.ports.filter((q) => q.enable)) expect(g.stimulus[0]![p.sig.name]).toBe('1');
    }
    expect(gates).toBeGreaterThan(100);
    expect(gatedAlways).toBeGreaterThan(50);
    expect(gatedInst).toBeGreaterThan(5);
  });

  it('are absent by default and with the feature off', () => {
    for (const features of [undefined, { clocks: false }]) {
      for (const g of sources(100, { features })) {
        expect(g.source).not.toMatch(/posedge g\d|& en\d/);
        for (const m of g.program.modules) expect(m.items.some((it) => it.k === 'gate')).toBe(false);
      }
    }
  });
});

describe('wider values and deeper nesting', () => {
  it('reach 17..32-bit signals and 33+-bit unsized literals in ==, and not when wide is off', () => {
    const scan = (features: Partial<Features>) => {
      let wideSigs = 0;
      let wideLits = 0;
      let paddedLits = 0;
      let maxWidth = 0;
      for (const g of sources(200, { features })) {
        for (const m of g.program.modules) {
          for (const p of m.ports) maxWidth = Math.max(maxWidth, p.sig.width);
          for (const it of m.items) if (it.k === 'decl') maxWidth = Math.max(maxWidth, it.sig.width);
          for (const e of allExprs(m)) {
            subExprs(e, (x) => {
              if (x.k === 'lit' && x.width === null && x.pad !== undefined) {
                paddedLits++;
                expect(x.value).toBeLessThan(2 ** 32);
              }
              if (x.k === 'lit' && x.width === null && x.value >= 2 ** 32) {
                wideLits++;
                expect(Number.isSafeInteger(x.value)).toBe(true);
              }
              if (x.k === 'lit' && x.width === null && x.value >= 2 ** 32) return;
              if (x.k === 'bin' && (x.op === '==' || x.op === '!=')) return;
            });
            subExprs(e, (x) => {
              if (x.k === 'bin' && x.op !== '==' && x.op !== '!=') for (const side of [x.l, x.r]) expect(side.k === 'lit' && side.width === null && (side.value >= 2 ** 32 || side.pad !== undefined), 'wide literal outside ==').toBe(false);
            });
          }
          wideSigs += [...m.ports.map((p) => p.sig), ...m.items.flatMap((it) => (it.k === 'decl' ? [it.sig] : []))].filter((s) => s.width >= 17).length;
        }
      }
      return { wideSigs, wideLits, paddedLits, maxWidth };
    };
    const on = scan({});
    expect(on.wideSigs).toBeGreaterThan(30);
    expect(on.maxWidth).toBeGreaterThanOrEqual(30);
    expect(on.maxWidth).toBeLessThanOrEqual(32);
    expect(on.wideLits).toBeGreaterThan(10);
    expect(on.paddedLits).toBeGreaterThan(5);
    expect(scan({ wide: false })).toEqual({ wideSigs: 0, wideLits: 0, paddedLits: 0, maxWidth: expect.any(Number) });
    expect(scan({ wide: false }).maxWidth).toBeLessThanOrEqual(16);
  });

  it('reach depth 12 and 50-term left-associative chains, and stay shallow when deep is off', () => {
    const scan = (features: Partial<Features>) => {
      let depth = 0;
      let treeDepth = 0;
      let chain = 0;
      let nodesMax = 0;
      for (const g of sources(300, { features, size: () => 3 })) {
        for (const m of g.program.modules) {
          for (const e of allExprs(m)) {
            depth = Math.max(depth, exprDepthOf(e));
            let longest = 1;
            subExprs(e, (x) => {
              if (x.k === 'bin' && x.op !== '==' && x.op !== '!=') longest = Math.max(longest, chainLength(x));
            });
            if (longest < 15) treeDepth = Math.max(treeDepth, exprDepthOf(e));
            let n = 0;
            subExprs(e, () => n++);
            nodesMax = Math.max(nodesMax, n);
            subExprs(e, (x) => {
              if (x.k === 'bin' && x.op !== '==' && x.op !== '!=') chain = Math.max(chain, chainLength(x));
            });
          }
        }
      }
      return { depth, treeDepth, chain, nodesMax };
    };
    const on = scan({});
    expect(on.treeDepth).toBeGreaterThanOrEqual(12);
    expect(on.treeDepth).toBeLessThanOrEqual(30);
    expect(on.chain).toBeGreaterThanOrEqual(40);
    expect(on.chain).toBeLessThanOrEqual(60);
    expect(on.nodesMax).toBeLessThan(2500);
    const off = scan({ deep: false });
    expect(off.depth).toBeLessThanOrEqual(10);
    expect(off.chain).toBeLessThan(12);
  });
});

describe('port-connection width mismatch', () => {
  it('reaches wider, narrower, summed and narrower-output connections, and none when off', () => {
    const total = { inWider: 0, inNarrower: 0, inSum: 0, outNarrower: 0 };
    const off = { inWider: 0, inNarrower: 0, inSum: 0, outNarrower: 0 };
    for (const g of sources(300, { size: (s) => 2 + (s % 6) })) for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += connMismatches(g.program)[k];
    for (const g of sources(300, { features: { widthMismatch: false }, size: (s) => 2 + (s % 6) })) for (const k of Object.keys(off) as Array<keyof typeof off>) off[k] += connMismatches(g.program)[k];
    expect(total.inWider).toBeGreaterThan(20);
    expect(total.inNarrower).toBeGreaterThan(20);
    expect(total.inSum).toBeGreaterThan(5);
    expect(total.outNarrower).toBeGreaterThan(10);
    expect(off.outNarrower).toBe(0);
  });
});

describe.skipIf(!iverilogAvailable())('iverilog accepts every feature', () => {
  const compileAll = async (n: number, features: Partial<Features> | undefined, check: (stderr: string) => string) => {
    const bad: string[] = [];
    const seeds = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < seeds.length; i += 8) {
      await Promise.all(
        seeds.slice(i, i + 8).map(async (seed) => {
          const g = generateCase(seed, { size: 1 + (seed % 10), features });
          const r = await compileCheck(g.source, g.top, { wall: true });
          const rest = check(r.stderr);
          if (!r.ok || rest !== '') bad.push(`seed ${seed}: ${rest || r.stderr}\n${g.source}`);
        }),
      );
    }
    return bad;
  };

  it('compiles 300 seeds with every feature on: no errors, and no warning but the port-width one', async () => {
    expect(await compileAll(300, ALL, withoutWidthMismatchWarnings)).toEqual([]);
  });

  it('compiles 300 default seeds: no errors, and no warning but the port-width one', async () => {
    expect(await compileAll(300, undefined, withoutWidthMismatchWarnings)).toEqual([]);
  });

  it('emits no warning at all, not even the port-width one, with widthMismatch off', async () => {
    expect(await compileAll(300, { ...ALL, widthMismatch: false }, (s) => s.trim())).toEqual([]);
  });

  it('does emit the port-width warning when widthMismatch is on, and the filter removes only that class', async () => {
    let seen = 0;
    for (let seed = 0; seed < 40; seed++) {
      const g = generateCase(seed, { size: 5 });
      const r = await compileCheck(g.source, g.top, { wall: true });
      if (/warning: Port \d+/.test(r.stderr)) seen++;
    }
    expect(seen).toBeGreaterThan(10);
    const sample = [
      'd.v:3: warning: Port 2 (a) of module m0 expects 8 bit(s), given 4.',
      'd.v:3:        : Padding 4 high bits of the port.',
      'd.v:4: warning: Port 1 (b) of module m0 expects 2 bit(s), given 33.',
      'd.v:4:        : Pruning (signed) 31 high bits of the expression.',
      'd.v:9: warning: something else entirely.',
      'd.v:9:        : Padding 4 high bits of the port.',
    ].join('\n');
    expect(withoutWidthMismatchWarnings(sample)).toBe('d.v:9: warning: something else entirely.\nd.v:9:        : Padding 4 high bits of the port.');
  });
});
