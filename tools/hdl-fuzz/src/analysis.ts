import { exprRefs, walkStmts, CLOCK, type Item, type Module, type Program } from './ast';

/**
 * The generator models hardware, so no `if` condition may read a value that Verilog simulation
 * leaves as x or z where silicon would hold a bit. Those values are the x-sources:
 *  - a reg that its always block does not reset (or an always block with no reset at all). A
 *    block with no reset also runs on the first edge, when every reg is still x, so it may hold no `if`,
 *  - a wire nothing drives.
 * An x-source taints everything its value flows into: assigns, reg right-hand sides (the
 * `if` conditions that gate an assignment do not carry data), and instance outputs.
 * `?:` conditions, `==`, and plain data may read tainted signals.
 */
export interface ModuleInfo {
  /** Input ports that reach an `if` condition, directly or through an instance. */
  ifIn: Set<string>;
  /** Output ports that an x-source reaches inside the module. */
  xOut: Set<string>;
  /** For each output port, the input ports its value depends on. */
  dep: Map<string, Set<string>>;
}

export type Infos = Map<string, ModuleInfo>;

const X = 'X';
const inLabel = (name: string) => `in:${name}`;

function alwaysItems(m: Module) {
  return m.items.filter((it): it is Extract<Item, { k: 'always' }> => it.k === 'always');
}

/** Regs with no reset assignment, and wires nothing drives. */
export function xSources(m: Module): { unresetRegs: Set<string>; undrivenWires: Set<string> } {
  const regs = new Set<string>();
  for (const p of m.ports) if (p.dir === 'out' && p.reg) regs.add(p.sig.name);
  for (const it of m.items) if (it.k === 'decl' && it.type === 'reg') regs.add(it.sig.name);
  const reset = new Set<string>();
  for (const a of alwaysItems(m)) {
    if (!a.reset) continue;
    for (const s of walkStmts(a.resets)) if (s.k === 'nb') reset.add(s.lhs);
  }
  const unresetRegs = new Set([...regs].filter((r) => !reset.has(r)));

  const driven = new Set<string>();
  for (const it of m.items) {
    if (it.k === 'assign') driven.add(it.lhs);
    else if (it.k === 'gate') driven.add(it.name);
    else if (it.k === 'inst') for (const c of it.conns) if (c.expr?.k === 'ref') driven.add(c.expr.name);
  }
  const wires = new Set<string>();
  for (const p of m.ports) if (p.dir === 'out' && !p.reg) wires.add(p.sig.name);
  for (const it of m.items) if (it.k === 'decl' && it.type === 'wire') wires.add(it.sig.name);
  const undrivenWires = new Set([...wires].filter((w) => !driven.has(w)));
  return { unresetRegs, undrivenWires };
}

export interface ModuleAnalysis {
  info: ModuleInfo;
  violations: string[];
  /** Signals an x-source reaches, by name. */
  tainted: Set<string>;
}

export function analyzeModule(m: Module, infos: Infos): ModuleAnalysis {
  const labels = new Map<string, Set<string>>();
  const label = (n: string) => {
    let s = labels.get(n);
    if (!s) labels.set(n, (s = new Set()));
    return s;
  };
  const exprLabels = (refs: Set<string>) => {
    const out = new Set<string>();
    for (const r of refs) for (const l of labels.get(r) ?? []) out.add(l);
    return out;
  };
  for (const p of m.ports) if (p.dir === 'in' && p.sig.name !== CLOCK) label(p.sig.name).add(inLabel(p.sig.name));
  const { unresetRegs, undrivenWires } = xSources(m);
  for (const n of [...unresetRegs, ...undrivenWires]) label(n).add(X);

  const flows: Array<() => boolean> = [];
  const addAll = (into: Set<string>, from: Iterable<string>) => {
    let changed = false;
    for (const l of from) if (!into.has(l)) (into.add(l), (changed = true));
    return changed;
  };
  for (const it of m.items) {
    if (it.k === 'assign') {
      const refs = exprRefs(it.rhs);
      flows.push(() => addAll(label(it.lhs), exprLabels(refs)));
    } else if (it.k === 'always') {
      for (const body of [it.body, it.resets]) {
        for (const s of walkStmts(body)) {
          if (s.k !== 'nb') continue;
          const refs = exprRefs(s.rhs);
          flows.push(() => addAll(label(s.lhs), exprLabels(refs)));
        }
      }
    } else if (it.k === 'inst') {
      const sub = infos.get(it.module);
      if (!sub) continue;
      const connRefs = new Map(it.conns.map((c) => [c.port, c.expr ? exprRefs(c.expr) : new Set<string>()]));
      for (const c of it.conns) {
        if (c.expr?.k !== 'ref') continue;
        const target = c.expr.name;
        const ins = sub.dep.get(c.port);
        const isOut = ins !== undefined;
        if (!isOut) continue;
        flows.push(() => {
          let changed = false;
          if (sub.xOut.has(c.port)) changed = addAll(label(target), [X]) || changed;
          for (const i of ins) changed = addAll(label(target), exprLabels(connRefs.get(i) ?? new Set())) || changed;
          return changed;
        });
      }
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of flows) changed = f() || changed;
  }

  const violations: string[] = [];
  const ifIn = new Set<string>();
  const noteInputs = (ls: Set<string>) => {
    for (const l of ls) if (l.startsWith('in:')) ifIn.add(l.slice(3));
  };
  for (const a of alwaysItems(m)) {
    if (!a.reset && [...walkStmts(a.body)].some((s) => s.k === 'if')) violations.push(`${m.name}: an if inside an always block with no reset reads regs that are still x on the first edge`);
    for (const body of [a.body, a.resets]) {
      for (const s of walkStmts(body)) {
        if (s.k !== 'if') continue;
        const ls = exprLabels(exprRefs(s.cond));
        if (ls.has(X)) violations.push(`${m.name}: an if condition reads an x-capable signal (${[...exprRefs(s.cond)].filter((r) => labels.get(r)?.has(X)).join(', ')})`);
        noteInputs(ls);
      }
    }
  }
  for (const it of m.items) {
    if (it.k !== 'inst') continue;
    const sub = infos.get(it.module);
    if (!sub) continue;
    for (const c of it.conns) {
      if (!c.expr || !sub.ifIn.has(c.port)) continue;
      const ls = exprLabels(exprRefs(c.expr));
      if (ls.has(X)) violations.push(`${m.name}: ${it.name}.${c.port} is fed x-capable data but reaches an if condition inside ${it.module}`);
      noteInputs(ls);
    }
  }

  const xOut = new Set<string>();
  const dep = new Map<string, Set<string>>();
  for (const p of m.ports) {
    if (p.dir !== 'out') continue;
    const ls = labels.get(p.sig.name) ?? new Set<string>();
    if (ls.has(X)) xOut.add(p.sig.name);
    dep.set(p.sig.name, new Set([...ls].filter((l) => l.startsWith('in:')).map((l) => l.slice(3))));
  }
  const tainted = new Set([...labels].filter(([, ls]) => ls.has(X)).map(([n]) => n));
  return { info: { ifIn, xOut, dep }, violations, tainted };
}

/** All modules in order. Violations name the module and the offending signal. */
export function findXViolations(p: Program): string[] {
  const infos: Infos = new Map();
  const out: string[] = [];
  for (const m of p.modules) {
    const a = analyzeModule(m, infos);
    infos.set(m.name, a.info);
    out.push(...a.violations);
  }
  return out;
}

/**
 * What a candidate must satisfy to be a program the fuzzer would have generated: no x in an
 * `if`, every reg written, every wire driven unless it was declared undriven. The shrinker
 * uses it so a reduction never introduces a simulation-only difference.
 */
export function programProblems(p: Program): string[] {
  const out = findXViolations(p);
  for (const m of p.modules) {
    const { undrivenWires } = xSources(m);
    const intended = new Set(m.items.flatMap((it) => (it.k === 'decl' && it.undriven ? [it.sig.name] : [])));
    for (const w of undrivenWires) if (!intended.has(w)) out.push(`${m.name}: wire ${w} is undriven`);
    const declared = new Set<string>([...m.ports.map((q) => q.sig.name), ...m.items.flatMap((it) => (it.k === 'decl' ? [it.sig.name] : it.k === 'gate' ? [it.name] : []))]);
    const names = new Set<string>();
    for (const it of m.items) {
      if (it.k === 'assign') (names.add(it.lhs), exprRefs(it.rhs, names));
      else if (it.k === 'inst') {
        for (const c of it.conns) if (c.expr) exprRefs(c.expr, names);
      } else if (it.k === 'always') {
        for (const body of [it.body, it.resets]) {
          for (const s of walkStmts(body)) {
            if (s.k === 'nb') (names.add(s.lhs), exprRefs(s.rhs, names));
            else exprRefs(s.cond, names);
          }
        }
      }
    }
    for (const n of names) if (!declared.has(n)) out.push(`${m.name}: ${n} is used but not declared (an implicit net in Verilog)`);
    const written = new Set<string>();
    for (const a of alwaysItems(m)) for (const body of [a.body, a.resets]) for (const s of walkStmts(body)) if (s.k === 'nb') written.add(s.lhs);
    const regs = [...m.ports.filter((q) => q.reg).map((q) => q.sig.name), ...m.items.flatMap((it) => (it.k === 'decl' && it.type === 'reg' ? [it.sig.name] : []))];
    for (const r of regs) if (!written.has(r)) out.push(`${m.name}: reg ${r} is never written`);
  }
  return out;
}
