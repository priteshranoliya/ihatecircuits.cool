import { minimize, type Implicant } from './analysis';
import { addComponent, connect, emptyCircuit } from './edit';
import { evaluate, mkAnd, mkConst, mkNot, mkOr, mkVar, rowAssignment, variables, type AST } from './expr';
import type { Circuit } from './types';

/**
 * Circuit synthesis: turn Boolean expressions into a wired, laid-out circuit.
 *
 * Pipeline: expression → (optional two-level minimisation) → constant folding
 * → a small gate netlist (with structural sharing, so equal sub-circuits and
 * input inverters exist once) → layout by logic depth → parts and wires.
 *
 * Input and output ports are `pin` parts labelled with their names. A
 * constant output uses a `const` part. Layout is deterministic and on the
 * 10px grid; wires may cross.
 */

export interface SynthOptions {
  /** 'expression' builds the parse tree as written; 'sop'/'pos' minimise first and build two-level logic. */
  form: 'expression' | 'sop' | 'pos';
  /** Decompose wide gates into balanced trees of 2-input gates. */
  twoInputOnly: boolean;
  /** Use only NAND gates (NOT = NAND with tied inputs, XOR = the 4-NAND construction). */
  nandOnly: boolean;
  /** Name of the new circuit. */
  name?: string;
}

export const DEFAULT_SYNTH: SynthOptions = { form: 'expression', twoInputOnly: false, nandOnly: false };

const MAX_FAN = 16;
export const MAX_SYNTH_INPUTS = 12;

// ---------------------------------------------------------------- netlist

interface Node {
  id: number;
  kind: 'in' | 'const' | 'gate';
  /** Input name, constant value or gate type. */
  name: string;
  value?: 0 | 1;
  ins: Node[];
  /** A node known to be the logical complement of this one (so double inversion cancels). */
  inv?: Node;
}

class Net {
  nodes: Node[] = [];
  private cache = new Map<string, Node>();

  private make(kind: Node['kind'], name: string, ins: Node[], value?: 0 | 1): Node {
    const key = `${kind}:${name}:${value ?? ''}:${ins.map((n) => n.id).join(',')}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const node: Node = { id: this.nodes.length, kind, name, value, ins };
    this.nodes.push(node);
    this.cache.set(key, node);
    return node;
  }
  input(name: string) {
    return this.make('in', name, []);
  }
  constant(v: 0 | 1) {
    return this.make('const', `const${v}`, [], v);
  }
  gate(type: string, ins: Node[]) {
    return this.make('gate', type, ins);
  }
}

/** Replace constants by simplifying: afterwards a constant can only be the whole expression. */
function fold(a: AST): AST {
  switch (a.k) {
    case 'const':
    case 'var':
      return a;
    case 'not': {
      const x = fold(a.a);
      if (x.k === 'const') return mkConst(x.v ? 0 : 1);
      return x.k === 'not' ? x.a : mkNot(x);
    }
    case 'and':
    case 'or': {
      const absorbing = a.k === 'and' ? 0 : 1;
      const args: AST[] = [];
      for (const raw of a.args) {
        const x = fold(raw);
        if (x.k === 'const') {
          if (x.v === absorbing) return mkConst(absorbing);
        } else args.push(x);
      }
      return a.k === 'and' ? mkAnd(...args) : mkOr(...args);
    }
    case 'xor': {
      let parity = 0;
      const args: AST[] = [];
      for (const raw of a.args) {
        const x = fold(raw);
        if (x.k === 'const') parity ^= x.v;
        else args.push(x);
      }
      const body = args.length === 0 ? null : args.length === 1 ? args[0] : { k: 'xor' as const, args };
      if (!body) return mkConst(parity as 0 | 1);
      return parity ? fold(mkNot(body)) : body;
    }
  }
}

class Builder {
  constructor(
    readonly net: Net,
    readonly opts: SynthOptions,
  ) {}

  private link(a: Node, b: Node) {
    a.inv ??= b;
    b.inv ??= a;
  }

  private neg(x: Node): Node {
    if (x.inv) return x.inv;
    const g = this.opts.nandOnly ? this.net.gate('nand', [x, x]) : this.net.gate('not', [x]);
    this.link(x, g);
    return g;
  }

  /** Reduce a list with a combiner that accepts at most `fan` items, level by level (balanced). */
  private tree(list: Node[], fan: number, combine: (chunk: Node[]) => Node): Node {
    let cur = list;
    while (cur.length > fan) {
      const next: Node[] = [];
      for (let i = 0; i < cur.length; i += fan) {
        const chunk = cur.slice(i, i + fan);
        next.push(chunk.length === 1 ? chunk[0] : combine(chunk));
      }
      cur = next;
    }
    return cur.length === 1 ? cur[0] : combine(cur);
  }

  private fan(): number {
    return this.opts.twoInputOnly ? 2 : MAX_FAN;
  }

  private and(list: Node[]): Node {
    if (list.length === 1) return list[0];
    return this.tree(list, this.fan(), (chunk) => {
      if (!this.opts.nandOnly) return this.net.gate('and', chunk);
      const nand = this.net.gate('nand', chunk);
      const out = this.net.gate('nand', [nand, nand]);
      this.link(nand, out);
      return out;
    });
  }

  private or(list: Node[]): Node {
    if (list.length === 1) return list[0];
    return this.tree(list, this.fan(), (chunk) => (this.opts.nandOnly ? this.net.gate('nand', chunk.map((n) => this.neg(n))) : this.net.gate('or', chunk)));
  }

  private xor(list: Node[]): Node {
    if (list.length === 1) return list[0];
    if (!this.opts.nandOnly) return this.tree(list, this.fan(), (chunk) => this.net.gate('xor', chunk));
    return this.tree(list, 2, ([a, b]) => {
      const n1 = this.net.gate('nand', [a, b]);
      const n2 = this.net.gate('nand', [a, n1]);
      const n3 = this.net.gate('nand', [b, n1]);
      return this.net.gate('nand', [n2, n3]);
    });
  }

  /** Lower a folded expression (constants only at the top). */
  lower(a: AST): Node {
    switch (a.k) {
      case 'const':
        return this.net.constant(a.v);
      case 'var':
        return this.net.input(a.name);
      case 'not':
        return this.neg(this.lower(a.a));
      case 'and':
        return this.and(a.args.map((x) => this.lower(x)));
      case 'or':
        return this.or(a.args.map((x) => this.lower(x)));
      case 'xor':
        return this.xor(a.args.map((x) => this.lower(x)));
    }
  }
}

// ---------------------------------------------------------------- two-level forms

const lit = (name: string, positive: boolean): AST => (positive ? mkVar(name) : mkNot(mkVar(name)));

/** Product term of an implicant: '1' → the variable, '0' → its complement. */
const productTerm = (imp: Implicant, names: readonly string[]): AST =>
  mkAnd(...[...imp].flatMap((ch, i) => (ch === '-' ? [] : [lit(names[i], ch === '1')])));

/** Sum term for an implicant of the zeros (De Morgan): '0' → the variable, '1' → its complement. */
const sumTerm = (imp: Implicant, names: readonly string[]): AST =>
  mkOr(...[...imp].flatMap((ch, i) => (ch === '-' ? [] : [lit(names[i], ch === '0')])));

/** Sum-of-products expression equal to `ast` over the input names. */
export function sopExpression(ast: AST, inputs: readonly string[]): AST {
  const ones = minterms(ast, inputs, 1);
  return mkOr(...minimize(inputs.length, ones).map((imp) => productTerm(imp, inputs)));
}

/** Product-of-sums expression equal to `ast` over the input names. */
export function posExpression(ast: AST, inputs: readonly string[]): AST {
  const zeros = minterms(ast, inputs, 0);
  return mkAnd(...minimize(inputs.length, zeros).map((imp) => sumTerm(imp, inputs)));
}

function minterms(ast: AST, inputs: readonly string[], want: 0 | 1): number[] {
  const out: number[] = [];
  for (let r = 0; r < 1 << inputs.length; r++) if (evaluate(ast, rowAssignment(inputs, r)) === want) out.push(r);
  return out;
}

// ---------------------------------------------------------------- layout and build

const COL_GAP = 60;
const COL_W = 80;
const ROW_GAP = 20;

/**
 * Build a new circuit computing the given outputs. Throws an Error for a
 * programming mistake: an expression using a variable that is not in `inputs`,
 * duplicate names, or more than MAX_SYNTH_INPUTS inputs for the two-level forms.
 */
export function buildCircuit(outputs: readonly { name: string; expr: AST }[], inputs: readonly string[], opts: SynthOptions = DEFAULT_SYNTH): Circuit {
  const names = [...new Set(inputs)];
  for (const o of outputs) {
    const missing = variables(o.expr).filter((v) => !names.includes(v));
    if (missing.length) throw new Error(`${o.name} uses ${missing.join(', ')}, which is not in the input list`);
  }
  if (new Set(outputs.map((o) => o.name)).size !== outputs.length) throw new Error('Output names must be different from each other');
  if (opts.form !== 'expression' && names.length > MAX_SYNTH_INPUTS) throw new Error(`Minimising needs at most ${MAX_SYNTH_INPUTS} inputs`);

  const net = new Net();
  const b = new Builder(net, opts);
  const inNodes = names.map((n) => net.input(n));
  const driver = outputs.map((o) => {
    const shaped = opts.form === 'sop' ? sopExpression(o.expr, names) : opts.form === 'pos' ? posExpression(o.expr, names) : o.expr;
    return b.lower(fold(shaped));
  });

  // Keep only what the outputs reach, then give every node a logic depth.
  const used = new Set<Node>(inNodes);
  const mark = (n: Node) => {
    if (used.has(n)) return;
    used.add(n);
    n.ins.forEach(mark);
  };
  driver.forEach(mark);
  const depth = new Map<Node, number>();
  for (const n of net.nodes) {
    if (!used.has(n)) continue;
    depth.set(n, n.kind === 'gate' ? 1 + Math.max(...n.ins.map((i) => depth.get(i)!)) : 0);
  }
  const maxDepth = Math.max(0, ...depth.values());

  let c = emptyCircuit(opts.name ?? 'Synthesized circuit');
  const ids = new Map<Node, string>();
  const outPinY = new Map<Node, number>();
  const x0 = 20;
  const colX = (d: number) => x0 + d * (COL_W + COL_GAP);
  const add = (type: string, x: number, y: number, props: Record<string, unknown>, label = '') => {
    const r = addComponent(c, { type, x, y, props, label });
    c = r.circuit;
    return r.id;
  };

  // Column 0: input pins, then constants.
  let y = 20;
  for (const n of inNodes) {
    ids.set(n, add('pin', colX(0), y, { io: 'in', bits: 1 }, n.name));
    outPinY.set(n, y + 10);
    y += 40;
  }
  for (const n of net.nodes.filter((m) => m.kind === 'const' && used.has(m))) {
    ids.set(n, add('const', colX(0), y, { bits: 1, value: String(n.value) }));
    outPinY.set(n, y + 10);
    y += 40;
  }

  // Gate columns: place each near the mean height of its inputs, then push down to avoid overlap.
  const heightOf = (n: Node) => (n.name === 'not' ? 20 : 20 * n.ins.length);
  for (let d = 1; d <= maxDepth; d++) {
    const col = net.nodes.filter((n) => used.has(n) && n.kind === 'gate' && depth.get(n) === d);
    const want = new Map(col.map((n) => [n, Math.max(0, Math.round((n.ins.reduce((s, i) => s + outPinY.get(i)!, 0) / n.ins.length - heightOf(n) / 2) / 10) * 10)]));
    col.sort((a, z) => want.get(a)! - want.get(z)! || a.id - z.id);
    let top = 0;
    for (const n of col) {
      const gy = Math.max(want.get(n)!, top);
      const props = n.name === 'not' ? {} : { inputs: n.ins.length, bits: 1 };
      ids.set(n, add(n.name, colX(d), gy, props));
      outPinY.set(n, gy + heightOf(n) / 2);
      top = gy + heightOf(n) + ROW_GAP;
    }
  }

  // Wires into gates.
  const wire = (from: Node, to: string, pin: string) => {
    const r = connect(c, { comp: ids.get(from)!, pin: from.kind === 'gate' ? 'out' : from.kind === 'const' ? 'out' : 'p' }, { comp: to, pin });
    if ('error' in r) throw new Error(`Could not wire ${from.name} to ${pin}: ${r.error}`);
    c = r.circuit;
  };
  for (const n of net.nodes) {
    if (!used.has(n) || n.kind !== 'gate') continue;
    n.ins.forEach((src, i) => wire(src, ids.get(n)!, `in${i}`));
  }

  // Output pins in the column after the last gate.
  const want = outputs.map((o, i) => ({ o, node: driver[i], y: Math.max(0, Math.round((outPinY.get(driver[i])! - 10) / 10) * 10) }));
  let top = 0;
  const order = want.map((w, i) => ({ ...w, i })).sort((a, z) => a.y - z.y || a.i - z.i);
  for (const w of order) {
    const py = Math.max(w.y, top);
    const id = add('pin', colX(maxDepth + 1), py, { io: 'out', bits: 1 }, w.o.name);
    top = py + 20 + ROW_GAP;
    wire(w.node, id, 'p');
  }
  return c;
}
