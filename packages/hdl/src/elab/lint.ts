import type * as A from '../ast';
import { type Module, type NetId, cellInputs, cellOutputs, isStateful } from '../design';
import type { Consts } from './consteval';
import * as cv from './cval';
import type { Scope } from './scope';

/**
 * Lints that look at the finished circuit or at an expression's shape.
 */

/**
 * How many low bits of `e` can be nonzero, estimated from its shape. An expression whose significant width is no
 * more than its target loses nothing by being cut to it, however wide the standard makes it on the way.
 */
export function sigWidth(e: A.Expr, scope: Scope, c: Consts): number {
  const self = c.typeOf(e, scope).w;
  let depth = 0;
  const go = (x: A.Expr): number => {
    if (++depth > 100) {
      depth--;
      return c.typeOf(x, scope).w;
    }
    try {
      return goNode(x);
    } finally {
      depth--;
    }
  };
  const goNode = (x: A.Expr): number => {
    if (c.isConst(x, scope)) {
      try {
        const v = c.evalSelf(x, scope);
        if (!cv.known(v)) return v.width;
        const n = cv.toBigIntAs(v, false);
        return n === 0n ? 1 : n.toString(2).length;
      } catch {
        return c.typeOf(x, scope).w;
      }
    }
    switch (x.kind) {
      case 'binary': {
        const l = go(x.lhs);
        const r = go(x.rhs);
        switch (x.op) {
          case '+':
          case '-':
          case '|':
          case '^':
          case '~^':
          case '^~':
            return Math.max(l, r);
          case '&':
            return Math.min(l, r);
          case '*':
            return l + r;
          case '<<':
          case '<<<': {
            if (c.isConst(x.rhs, scope)) return l + Number(cv.toBigInt(c.evalSelf(x.rhs, scope)));
            return c.typeOf(x, scope).w;
          }
          case '>>':
          case '>>>': {
            if (c.isConst(x.rhs, scope)) return Math.max(1, l - Number(cv.toBigInt(c.evalSelf(x.rhs, scope))));
            return l;
          }
          case '/':
            return l;
          case '%':
            return Math.min(l, r);
          default:
            return 1;
        }
      }
      case 'unary':
        return x.op === '+' || x.op === '-' || x.op === '~' ? go(x.operand) : 1;
      case 'ternary':
        return Math.max(go(x.then), go(x.else));
      case 'concat':
        return x.parts.reduce((n, p) => n + c.typeOf(p, scope).w, 0);
      default:
        return c.typeOf(x, scope).w;
    }
  };
  return Math.min(self, go(e));
}

// ---------------------------------------------------------------- combinational loops

/** For each output port, the input ports it depends on without passing through a register. */
export type CombSummary = Map<string, Set<string>>;

interface Graph {
  succ: NetId[][];
}

function build(m: Module, summaries: Map<string, CombSummary>): Graph {
  const succ: NetId[][] = m.nets.map(() => []);
  const edge = (a: NetId, b: NetId) => succ[a]!.push(b);
  for (const c of m.cells) {
    if (isStateful(c)) continue;
    switch (c.kind) {
      case 'instance': {
        const s = summaries.get(c.module);
        for (const [out, on] of Object.entries(c.outputs)) {
          const deps = s?.get(out);
          for (const [inp, inn] of Object.entries(c.inputs)) if (!s || deps?.has(inp)) edge(inn, on);
        }
        break;
      }
      case 'const':
        break;
      default:
        for (const i of cellInputs(c)) for (const o of cellOutputs(c)) edge(i, o);
    }
  }
  return { succ };
}

/** Groups of nets that feed themselves through combinational logic, each as the source names in it. */
export function findCombLoops(m: Module, summaries: Map<string, CombSummary>): string[][] {
  const { succ } = build(m, summaries);
  const n = m.nets.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const on = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: { v: number; i: number }[] = [{ v: root, i: 0 }];
    index[root] = low[root] = counter++;
    stack.push(root);
    on[root] = true;
    while (work.length) {
      const top = work[work.length - 1]!;
      const edges = succ[top.v]!;
      if (top.i < edges.length) {
        const w = edges[top.i++]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          on[w] = true;
          work.push({ v: w, i: 0 });
        } else if (on[w]) low[top.v] = Math.min(low[top.v]!, index[w]!);
      } else {
        work.pop();
        if (work.length) low[work[work.length - 1]!.v] = Math.min(low[work[work.length - 1]!.v]!, low[top.v]!);
        if (low[top.v] === index[top.v]) {
          const comp: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            on[w] = false;
            comp.push(w);
          } while (w !== top.v);
          const selfLoop = comp.length === 1 && succ[comp[0]!]!.includes(comp[0]!);
          if (comp.length > 1 || selfLoop) {
            const names = comp.flatMap((id) => m.nets[id]!.names).filter((x, i, a) => a.indexOf(x) === i);
            out.push(names);
          }
        }
      }
    }
  }
  return out;
}

export function summarize(m: Module, summaries: Map<string, CombSummary>): CombSummary {
  const { succ } = build(m, summaries);
  const result: CombSummary = new Map();
  const outs = m.ports.filter((p) => p.dir === 'out');
  for (const o of outs) result.set(o.name, new Set());
  for (const inp of m.ports.filter((p) => p.dir === 'in')) {
    const seen = new Set<NetId>([inp.net]);
    const stack = [inp.net];
    while (stack.length) {
      const v = stack.pop()!;
      for (const w of succ[v]!) if (!seen.has(w)) {
        seen.add(w);
        stack.push(w);
      }
    }
    for (const o of outs) if (seen.has(o.net)) result.get(o.name)!.add(inp.name);
  }
  return result;
}

/** The name an assignment target is known by, for messages. */
export function lvalueName(e: A.Expr): string {
  switch (e.kind) {
    case 'ident':
    case 'hier':
      return e.name;
    case 'index':
      return e.base.name;
    case 'concat':
      return e.parts.map(lvalueName).join(', ');
    default:
      return 'the target';
  }
}
