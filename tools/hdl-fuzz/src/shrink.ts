import type { Stimulus } from '@ihatecircuits/hdl/trace';
import { TOP, walkStmts, type Expr, type Item, type Program, type Stmt } from './gen';

type Edit = (q: Program) => void;
type Step = number | 'then' | 'else';

function resolveList(root: Stmt[], path: Step[]): Stmt[] {
  let list = root;
  for (let i = 0; i < path.length; i += 2) {
    const s = list[path[i] as number] as Extract<Stmt, { k: 'if' }>;
    list = (path[i + 1] === 'then' ? s.then : s.else)!;
  }
  return list;
}

function* listPaths(stmts: Stmt[], path: Step[]): Generator<Step[]> {
  yield path;
  for (const [i, s] of stmts.entries()) {
    if (s.k !== 'if') continue;
    yield* listPaths(s.then, [...path, i, 'then']);
    if (s.else) yield* listPaths(s.else, [...path, i, 'else']);
  }
}

function instantiated(p: Program): Set<string> {
  return new Set(p.modules.flatMap((m) => m.items.flatMap((it) => (it.k === 'inst' ? [it.module] : []))));
}

type Key = string | number;
type Slot = (q: Program) => [Record<string, unknown>, string];

function childrenOf(e: Expr): Array<{ path: Key[]; node: Expr }> {
  switch (e.k) {
    case 'bin':
      return [{ path: ['l'], node: e.l }, { path: ['r'], node: e.r }];
    case 'cond':
      return [{ path: ['c'], node: e.c }, { path: ['t'], node: e.t }, { path: ['f'], node: e.f }];
    case 'not':
    case 'paren':
      return [{ path: ['e'], node: e.e }];
    case 'cat':
      return e.parts.map((node, i) => ({ path: ['parts', i], node }));
    default:
      return [];
  }
}

function* nodePaths(e: Expr, path: Key[] = []): Generator<{ path: Key[]; node: Expr }> {
  yield { path, node: e };
  for (const c of childrenOf(e)) yield* nodePaths(c.node, [...path, ...c.path]);
}

function* exprSlots(p: Program): Generator<{ slot: Slot; expr: Expr }> {
  for (let mi = 0; mi < p.modules.length; mi++) {
    const m = p.modules[mi]!;
    for (let ii = 0; ii < m.items.length; ii++) {
      const it = m.items[ii]!;
      if (it.k === 'assign') yield { slot: (q) => [q.modules[mi]!.items[ii] as never, 'rhs'], expr: it.rhs };
      else if (it.k === 'inst') {
        const sub = p.modules.find((x) => x.name === it.module);
        for (let ci = 0; ci < it.conns.length; ci++) {
          const c = it.conns[ci]!;
          const out = sub?.ports.find((x) => x.sig.name === c.port)?.dir === 'out';
          if (c.expr && !out && c.port !== 'clk' && c.port !== 'rst') yield { slot: (q) => [(q.modules[mi]!.items[ii] as Extract<Item, { k: 'inst' }>).conns[ci] as never, 'expr'], expr: c.expr };
        }
      } else if (it.k === 'always') {
        for (const field of ['body', 'resets'] as const) {
          for (const path of listPaths(it[field], [])) {
            const list = resolveList(it[field], path);
            for (let j = 0; j < list.length; j++) {
              const st = list[j]!;
              const get = (q: Program) => resolveList((q.modules[mi]!.items[ii] as Extract<Item, { k: 'always' }>)[field], path)[j] as never;
              if (st.k === 'nb') yield { slot: (q) => [get(q), 'rhs'], expr: st.rhs };
              else yield { slot: (q) => [get(q), 'cond'], expr: st.cond };
            }
          }
        }
      }
    }
  }
}

const zero: Expr = { k: 'lit', width: 1, base: 'b', value: 0 };

/** Replace an expression (or a sub-expression) by one of its children, or by a constant. */
function* exprEdits(p: Program): Generator<Edit> {
  for (const { slot, expr } of exprSlots(p)) {
    for (const { path, node } of nodePaths(expr)) {
      const candidates: Expr[] = [...childrenOf(node).map((c) => c.node), ...(node.k === 'lit' ? [] : [zero])];
      for (const cand of candidates) {
        yield (q) => {
          const [obj, key] = slot(q);
          if (path.length === 0) {
            obj[key] = structuredClone(cand);
            return;
          }
          let cur: any = obj[key];
          for (const k of path.slice(0, -1)) cur = cur[k];
          cur[path[path.length - 1]!] = structuredClone(cand);
        };
      }
    }
  }
}

/** Drop an item together with the declarations only it needs (a wire and its driver, an instance and its output wires, a block and its regs). */
function* groupEdits(p: Program): Generator<Edit> {
  for (let mi = p.modules.length - 1; mi >= 0; mi--) {
    const m = p.modules[mi]!;
    for (let ii = m.items.length - 1; ii >= 0; ii--) {
      const it = m.items[ii]!;
      const names = new Set<string>();
      if (it.k === 'assign') names.add(it.lhs);
      else if (it.k === 'inst') {
        for (const c of it.conns) if (c.expr?.k === 'ref' && c.port !== 'clk' && c.port !== 'rst') names.add(c.expr.name);
      } else if (it.k === 'always') {
        for (const body of [it.body, it.resets]) for (const st of walkStmts(body)) if (st.k === 'nb') names.add(st.lhs);
      } else if (it.k === 'gate') names.add(it.name);
      if (names.size === 0) continue;
      yield (q) => {
        const items = q.modules[mi]!.items;
        items.splice(ii, 1);
        for (let k = items.length - 1; k >= 0; k--) {
          const x = items[k]!;
          if (x.k === 'decl' && names.has(x.sig.name)) items.splice(k, 1);
        }
      };
    }
  }
}

/** Every single-step reduction: drop a module nobody instantiates, a group of items, an item, a statement, hoist an `if` branch, or simplify an expression. */
function* edits(p: Program): Generator<Edit> {
  const used = instantiated(p);
  for (let mi = p.modules.length - 1; mi >= 0; mi--) {
    const m = p.modules[mi]!;
    if (m.name !== TOP && !used.has(m.name)) yield (q) => void q.modules.splice(mi, 1);
  }
  yield* groupEdits(p);
  for (let mi = p.modules.length - 1; mi >= 0; mi--) {
    const m = p.modules[mi]!;
    for (let ii = m.items.length - 1; ii >= 0; ii--) {
      yield (q) => void q.modules[mi]!.items.splice(ii, 1);
      const it: Item = m.items[ii]!;
      if (it.k !== 'always') continue;
      for (const field of ['body', 'resets'] as const) {
        const get = (q: Program) => q.modules[mi]!.items[ii] as Extract<Item, { k: 'always' }>;
        for (const path of listPaths(it[field], [])) {
          const list = resolveList(it[field], path);
          for (let j = list.length - 1; j >= 0; j--) {
            yield (q) => void resolveList(get(q)[field], path).splice(j, 1);
            const s = list[j]!;
            if (s.k === 'if') {
              yield (q) => {
                const l = resolveList(get(q)[field], path);
                l.splice(j, 1, ...(l[j] as Extract<Stmt, { k: 'if' }>).then);
              };
              if (s.else) {
                yield (q) => {
                  const l = resolveList(get(q)[field], path);
                  l.splice(j, 1, ...(l[j] as Extract<Stmt, { k: 'if' }>).else!);
                };
              }
            }
          }
        }
      }
    }
  }
  yield* exprEdits(p);
}

export function programSize(p: Program): number {
  const count = (stmts: Stmt[]): number => stmts.reduce((n, s) => n + 1 + (s.k === 'if' ? count(s.then) + (s.else ? count(s.else) : 0) : 0), 0);
  return p.modules.reduce(
    (n, m) => n + 1 + m.items.reduce((k, it) => k + 1 + (it.k === 'always' ? count(it.resets) + count(it.body) : 0), 0),
    0,
  );
}

export interface ShrinkResult<E> {
  program: Program;
  stimulus: Stimulus;
  evidence: E;
  checks: number;
}

/**
 * Greedy reduction. `fails` must return the evidence when the candidate still fails the same
 * way and null otherwise (including when the candidate no longer compiles). Candidate programs
 * that stop failing are discarded; the stimulus is cut to the shortest failing prefix.
 */
export async function shrink<E>(
  program: Program,
  stimulus: Stimulus,
  evidence: E,
  fails: (p: Program, s: Stimulus) => Promise<E | null>,
  maxChecks = 1500,
): Promise<ShrinkResult<E>> {
  let cur = program;
  let stim = stimulus;
  let ev = evidence;
  let checks = 0;

  const cutCycles = async () => {
    let lo = 1;
    let hi = stim.length;
    while (lo < hi && checks < maxChecks) {
      const mid = (lo + hi) >> 1;
      checks++;
      const e = await fails(cur, stim.slice(0, mid));
      if (e) {
        hi = mid;
        ev = e;
      } else lo = mid + 1;
    }
    if (hi < stim.length) stim = stim.slice(0, hi);
  };

  await cutCycles();
  let progress = true;
  while (progress && checks < maxChecks) {
    progress = false;
    for (const edit of edits(cur)) {
      if (checks >= maxChecks) break;
      const cand = structuredClone(cur);
      edit(cand);
      checks++;
      const e = await fails(cand, stim);
      if (e) {
        cur = cand;
        ev = e;
        progress = true;
        break;
      }
    }
  }
  await cutCycles();
  return { program: cur, stimulus: stim, evidence: ev, checks };
}
