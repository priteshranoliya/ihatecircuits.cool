import type { Cell, Design, Module, NetId } from '@ihatecircuits/hdl';
import { blocksCell } from './blocks';
import { type Ctx, type View, powerOnProp } from './ctx';
import { type Circuit, type Project, buildCircuit, emptyCircuit, getDef, pinPoint, subType, useProject } from './core';
import { GB, type Src, type SupportLib } from './gb';
import { bitwiseLatch, bitwiseRegister, gatesCell } from './gates';
import { LowerError, ModuleGraph } from './graph';
import { type PartNode, type PinKey, layout } from './layout';
import { memoryCell } from './memory';

/**
 * Lowers an elaborated Design to an iHateCircuits project.
 *
 * Each module becomes a circuit, the top becomes `main`, and instances become
 * `sub:` parts. Two views exist.
 *
 * Blocks (`{ view: 'blocks' }`). Cells map to library parts only where the part is the same
 * function on 0/1 values and at least as precise on unknown values. The notes beside each
 * case say which part is used and why; a few cells (equality, slices, concatenation, signed
 * division, wide shifts) are built from several parts because no single part has the Verilog
 * behaviour. See blocks.ts and memory.ts.
 *
 * Gates (`{ view: 'gates' }`). Every cell is basic gates (and, or, not, xor, mux), single-bit
 * flip-flops and latches, constants and wiring. Word-level arithmetic becomes a circuit of
 * its own (`add8`, `mul16`, `divu8`, ...) that every module shares, so the canvas stays
 * readable and a student can step inside. See gates.ts.
 *
 * Hardware has no x. Where the IR says x (a division by zero, an unwritten memory word) the
 * circuit gives some definite value, which the trace comparison accepts, because a reference
 * x stands for any value. Where an input is unknown the parts follow their own rules (a ripple
 * adder keeps the low bits known), at least as precise as Verilog's all-x.
 *
 * A net that is read but never driven gets a junction, so its readers sit on a real floating
 * net and read z (x to a gate) instead of an unconnected pin. That is also the only source of
 * unknown values the circuit has: a literal with x or z bits is refused. A net with several
 * drivers meets at a junction and resolves in the simulator (z yields, a conflict is x); `pull0`
 * and `pull1` add a pull resistor, `supply0` and `supply1` are constants, and `wand`/`wor` are
 * built from an AND/OR of the active drivers behind one tri-state buffer, because the library has
 * no wired-AND net.
 *
 * When some clock passes through logic, every register's `delay` is set above
 * the deepest clock path so a register clocked late still sees the data from
 * before the edge, as Verilog's nonblocking assignments guarantee.
 *
 * A Project powers its registers on at 0 unless the part has an `init` property, which the IR's
 * `init` (`reg q = 4'd5;`) becomes. Verilog starts a reg without one at x; runSimulator sets those
 * registers to x before the first cycle to match.
 */

export { LowerError };

export interface LowerOptions {
  view: View;
}

/** Parts that hold state clocked by a pin named `clk`. */
const CLOCKED = new Set(['register', 'dff', 'ram']);
/** Parts whose output is a stored value: a path through them starts afresh. */
const STORED = new Set(['register', 'dff']);

const isStoredQ = (from: PinKey, nodes: PartNode[]) => STORED.has(nodes[from.part]!.type) && from.pin === 'q';

/** The `init` prop of a power-on part for an IR `init`, as props to spread: nothing when no bit is known. */
const powerOn = (init: string | undefined) => {
  const v = powerOnProp(init);
  return v ? { init: v } : {};
};

const isZero = (bits: string | undefined) => bits !== undefined && /^0+$/.test(bits);

interface Wired {
  op: 'and' | 'or';
  width: number;
  /** Drivers other than tri-state buffers, as already-built sources. */
  others: PinKey[];
  buffers: { a: NetId; en: NetId }[];
}

function expandCell(ctx: Ctx, cell: Cell, wired: Map<NetId, Wired>) {
  const { g, b, m } = ctx;
  const width = ctx.width;
  const out = (part: number, pin = 'out') => ({ part, pin });
  switch (cell.kind) {
    case 'const':
      return;
    case 'not': {
      // NOT: Kleene on x, which matches Verilog's ~.
      const n = g.add('not', { bits: width(cell.out) });
      g.read(cell.a, { part: n, pin: 'in0' });
      ctx.drive(cell.out, out(n));
      return;
    }
    case 'and':
    case 'or':
    case 'xor':
    case 'xnor': {
      // Gates work per bit with the Verilog truth tables: a known 0 decides AND, a known 1 decides OR, any x makes XOR x.
      const n = g.add(cell.kind, { inputs: 2, bits: width(cell.out) });
      g.read(cell.a, { part: n, pin: 'in0' });
      g.read(cell.b, { part: n, pin: 'in1' });
      ctx.drive(cell.out, out(n));
      return;
    }
    case 'add': {
      if (ctx.view === 'gates') break;
      // The adder's carry-in is left unconnected (it reads 0); its carry-out is unused because the IR keeps the carry in a wider add.
      const n = g.add('adder', { bits: width(cell.out) });
      g.read(cell.a, { part: n, pin: 'a' });
      g.read(cell.b, { part: n, pin: 'b' });
      ctx.drive(cell.out, out(n, 's'));
      return;
    }
    case 'mux': {
      // The 2:1 multiplexer merges both data inputs when the select is unknown, exactly Verilog's ?: on an x condition.
      const n = g.add('mux', { bits: width(cell.out), sel: 1 });
      g.read(cell.onFalse, { part: n, pin: 'd0' });
      g.read(cell.onTrue, { part: n, pin: 'd1' });
      g.read(cell.sel, { part: n, pin: 's' });
      ctx.drive(cell.out, out(n, 'y'));
      return;
    }
    case 'dff': {
      const trigger = cell.edge === 'pos' ? 'rising' : 'falling';
      const label = m.nets[cell.q]!.names[0] ?? '';
      if (ctx.view === 'gates') {
        ctx.drive(cell.q, b.sig(bitwiseRegister(b, width(cell.q), ctx.net(cell.d), ctx.net(cell.clk), trigger, undefined, label, cell.init), width(cell.q)));
        return;
      }
      // A register with CLR and EN left unconnected: CLR is asynchronous, so it is never used for a synchronous reset.
      const n = g.add('register', { bits: width(cell.q), trigger, ...powerOn(cell.init) }, label);
      g.read(cell.d, { part: n, pin: 'd' });
      g.read(cell.clk, { part: n, pin: 'clk' });
      ctx.drive(cell.q, out(n, 'q'));
      return;
    }
    case 'adff': {
      // Both reset forms follow the IR: the reset is level sensitive and an unknown level merges the reset value with the held one.
      const w = width(cell.q);
      const trigger = cell.edge === 'pos' ? 'rising' : 'falling';
      const label = m.nets[cell.q]!.names[0] ?? '';
      const active: Src = cell.arstLevel === 1 ? ctx.net(cell.arst) : b.not(ctx.net(cell.arst));
      if (ctx.view === 'blocks' && isZero(cell.arstValue)) {
        // The Register's CLR resets to 0 and beats the clock; it is active high.
        const n = g.add('register', { bits: w, trigger, ...powerOn(cell.init) }, label);
        g.read(cell.d, { part: n, pin: 'd' });
        g.read(cell.clk, { part: n, pin: 'clk' });
        b.connect(active, { part: n, pin: 'clr' });
        ctx.drive(cell.q, out(n, 'q'));
        return;
      }
      // Any other reset value needs a flip-flop per bit: SET for the bits that reset to 1, CLR for those that reset to 0.
      ctx.drive(cell.q, b.sig(bitwiseRegister(b, w, ctx.net(cell.d), ctx.net(cell.clk), trigger, { active, value: cell.arstValue }, label, cell.init), w));
      return;
    }
    case 'latch': {
      const w = width(cell.q);
      const en = cell.enLevel === 1 ? ctx.net(cell.en) : b.not(ctx.net(cell.en));
      ctx.drive(cell.q, b.sig(bitwiseLatch(b, w, ctx.net(cell.d), en, cell.init), w));
      return;
    }
    case 'tribuf': {
      const w = wired.get(cell.out);
      if (w) {
        w.buffers.push({ a: cell.a, en: cell.en });
        return;
      }
      const n = g.add('tribuf', { bits: width(cell.out) });
      g.read(cell.a, { part: n, pin: 'in0' });
      g.read(cell.en, { part: n, pin: 'en' });
      ctx.drive(cell.out, out(n));
      return;
    }
    case 'memory':
      memoryCell(ctx, cell);
      return;
    case 'instance': {
      const n = g.add(subType(ctx.circuitOf(cell.module)), {}, cell.name);
      for (const [port, net] of Object.entries(cell.inputs)) g.read(net, { part: n, pin: port });
      for (const [port, net] of Object.entries(cell.outputs)) ctx.drive(net, { part: n, pin: port });
      return;
    }
    case 'slice': {
      const wa = width(cell.a);
      const wo = width(cell.out);
      if (cell.lsb === 0) {
        // The bit extender keeps the low bits when narrowing.
        const n = g.add('extender', { inBits: wa, outBits: wo, fill: 'zero' });
        g.read(cell.a, { part: n, pin: 'in' });
        ctx.drive(cell.out, out(n));
        return;
      }
      const map: number[] = [];
      let groups = 0;
      const group = (size: number) => {
        for (let i = 0; i < size; i++) map.push(groups);
        return groups++;
      };
      group(cell.lsb);
      const mine = group(wo);
      if (cell.lsb + wo < wa) group(wa - cell.lsb - wo);
      const n = g.add('splitter', { width: wa, fans: groups, map: map.join(' ') });
      g.read(cell.a, { part: n, pin: 'c' });
      ctx.drive(cell.out, out(n, `f${mine}`));
      return;
    }
    case 'concat': {
      const wo = width(cell.out);
      const lsbFirst = [...cell.parts].reverse();
      if (cell.parts.length === 1) {
        // A splitter needs two branches; a single part is the value itself.
        const n = g.add('extender', { inBits: wo, outBits: wo, fill: 'zero' });
        g.read(cell.parts[0]!, { part: n, pin: 'in' });
        ctx.drive(cell.out, out(n));
        return;
      }
      if (cell.parts.length === 2 && isZero(g.constBits.get(cell.parts[0]!))) {
        // Zero-extension: the bit extender fills the new high bits with 0.
        const n = g.add('extender', { inBits: width(cell.parts[1]!), outBits: wo, fill: 'zero' });
        g.read(cell.parts[1]!, { part: n, pin: 'in' });
        ctx.drive(cell.out, out(n));
        return;
      }
      const map = lsbFirst.flatMap((p, k) => Array<number>(width(p)).fill(k));
      // Turned half a turn so the narrow ends face the parts that feed it and the bus leaves on the right.
      const n = g.add('splitter', { width: wo, fans: lsbFirst.length, map: map.join(' ') }, '', 180);
      lsbFirst.forEach((p, k) => g.read(p, { part: n, pin: `f${k}` }));
      ctx.drive(cell.out, out(n, 'c'));
      return;
    }
    case 'eq':
    case 'ne': {
      const w = width(cell.a);
      if (w === 1) {
        const n = g.add(cell.kind === 'eq' ? 'xnor' : 'xor', { inputs: 2, bits: 1 });
        g.read(cell.a, { part: n, pin: 'in0' });
        g.read(cell.b, { part: n, pin: 'in1' });
        ctx.drive(cell.out, out(n));
        return;
      }
      // The library comparator gives x as soon as an x bit is reached from the top, even if a lower bit already differs.
      // Verilog decides on any known difference, so compare per bit: differing bits are 1 in a ^ b, and OR over them is
      // 1 on a known difference, x only when the rest is unknown, else 0. Against a literal 0 the XOR is skipped.
      const zeroA = isZero(g.constBits.get(cell.a));
      const zeroB = isZero(g.constBits.get(cell.b));
      let bits: PinKey[];
      if (zeroA || zeroB) {
        const other = zeroB ? cell.a : cell.b;
        bits = g.bitFan(w, (to) => g.read(other, to));
      } else {
        const x = g.add('xor', { inputs: 2, bits: w });
        g.read(cell.a, { part: x, pin: 'in0' });
        g.read(cell.b, { part: x, pin: 'in1' });
        bits = g.bitFan(w, (to) => g.edge(out(x), to));
      }
      ctx.drive(cell.out, g.reduce(bits, cell.kind === 'eq' ? 'nor' : 'or'));
      return;
    }
    case 'reduce_and':
    case 'reduce_or':
    case 'reduce_xor': {
      // A gate tree over the single bits. The gates follow the Verilog tables, so one 0 decides `&`, one 1 decides `|`, and any x makes `^` x.
      const type = cell.kind === 'reduce_and' ? 'and' : cell.kind === 'reduce_or' ? 'or' : 'xor';
      ctx.drive(cell.out, b.sig(b.tree(type, b.fan(ctx.net(cell.a), width(cell.a)))));
      return;
    }
    default:
      break;
  }
  const handled = ctx.view === 'gates' ? gatesCell(ctx, cell) : blocksCell(ctx, cell);
  if (!handled) throw new LowerError(`The ${cell.kind} cell cannot be lowered to the ${ctx.view} view.`);
}

/** A module's parts and connections before they are placed, with the timing facts the registers need. */
interface Graph {
  name: string;
  g: ModuleGraph;
  inputs: number[];
  outputs: number[];
  /** Longest delay, in gate delays, from an input or register to the slowest output. Instances of this module add it to a path. */
  latency: number;
  /** Longest delay on any path that ends at a register's clock pin. 0 when every clock comes straight from an input. */
  clockDepth: number;
}

function buildGraph(m: Module, view: View, circuitOf: (module: string) => string, latencyOf: (circuit: string) => number, lib: SupportLib): Graph {
  const g = new ModuleGraph();
  const b = new GB(g, lib);
  const wired = new Map<NetId, Wired>();
  const tribufOuts = new Set<NetId>();
  for (const c of m.cells) if (c.kind === 'tribuf') tribufOuts.add(c.out);
  for (const net of m.nets) {
    if (net.kind === 'wand' || net.kind === 'wor') {
      if (tribufOuts.has(net.id)) wired.set(net.id, { op: net.kind === 'wand' ? 'and' : 'or', width: net.width, others: [], buffers: [] });
    }
    if (net.kind === 'supply0' || net.kind === 'supply1') g.constBits.set(net.id, (net.kind === 'supply1' ? '1' : '0').repeat(net.width));
    if (net.kind === 'pull0' || net.kind === 'pull1') g.pull(net.id, net.kind === 'pull1' ? 'up' : 'down');
  }
  for (const c of m.cells) if (c.kind === 'const') g.constBits.set(c.out, c.bits);

  const ctx: Ctx = {
    view,
    g,
    b,
    m,
    lib,
    circuitOf,
    width: (n) => m.nets[n]!.width,
    net: (n) => ({ net: n }),
    drive: (n, src) => {
      const pin = b.sig(src, m.nets[n]!.width);
      const w = wired.get(n);
      if (w) w.others.push(pin);
      else g.drive(n, pin);
    },
  };

  const inputs: number[] = [];
  const outputs: number[] = [];
  for (const p of m.ports) {
    if (p.dir !== 'in') continue;
    const n = g.add('pin', { io: 'in', bits: p.width }, p.name);
    inputs.push(n);
    ctx.drive(p.net, { part: n, pin: 'p' });
  }
  for (const c of m.cells) expandCell(ctx, c, wired);
  finishWired(ctx, wired);
  for (const p of m.ports) {
    if (p.dir !== 'out') continue;
    const n = g.add('pin', { io: 'out', bits: p.width }, p.name);
    outputs.push(n);
    g.read(p.net, { part: n, pin: 'p' });
  }
  g.finish((net) => m.nets[net]!.names[0] ?? '');
  const timing = analyseTiming(g, outputs, latencyOf);
  return { name: m.name, g, inputs, outputs, ...timing };
}

/**
 * wand and wor nets. The library resolves a fought-over net by conflict, so the active drivers are combined
 * here instead: each tri-state buffer contributes its data while enabled and the identity of the operation
 * (1 for AND, 0 for OR) while not, and a single tri-state buffer, enabled when any driver is, puts the result
 * on the net. With every driver off the net floats, as in Verilog. Another driver on the net is always active.
 */
function finishWired(ctx: Ctx, wired: Map<NetId, Wired>) {
  const { b, g } = ctx;
  for (const [net, w] of wired) {
    const identity = b.konst(w.op === 'and' ? 1 : 0, w.width);
    const terms: Src[] = [...w.others, ...w.buffers.map((t) => b.mux(ctx.net(t.en), identity, ctx.net(t.a), w.width))];
    if (terms.length > 16) throw new LowerError(`A ${w.op === 'and' ? 'wand' : 'wor'} net with ${terms.length} drivers has more than a gate can combine.`);
    const value: Src = terms.length === 1 ? terms[0]! : b.gate(w.op, terms, w.width);
    if (w.others.length) {
      g.drive(net, b.sig(value, w.width));
      continue;
    }
    const buf = g.add('tribuf', { bits: w.width });
    b.connect(value, { part: buf, pin: 'in0' });
    b.connect(b.tree('or', w.buffers.map((t) => ctx.net(t.en))), { part: buf, pin: 'en' });
    g.drive(net, { part: buf, pin: 'out' });
  }
}

/** Propagation delay of a part in gate delays: wiring parts have none, an instance takes its module's latency. */
function partDelay(n: PartNode, latencyOf: (circuit: string) => number): number {
  if (n.type.startsWith('sub:')) return latencyOf(n.type.slice(4));
  const def = getDef(n.type);
  if (def.wiring || n.type === 'const') return 0;
  return Math.max(1, Number(n.props.delay ?? def.delay ?? 1));
}

/**
 * When does a change at an input reach each part? Register outputs and constants start at 0, so a loop through a
 * register is not a loop here; a combinational loop is cut where the walk meets itself.
 */
function analyseTiming(g: ModuleGraph, outputs: number[], latencyOf: (circuit: string) => number): { latency: number; clockDepth: number } {
  const { nodes, edges } = g;
  const preds: number[][] = nodes.map(() => []);
  for (const e of edges) if (!isStoredQ(e.from, nodes) && e.from.part !== e.to.part) preds[e.to.part]!.push(e.from.part);
  const delay = nodes.map((n) => partDelay(n, latencyOf));
  const arrival: number[] = Array(nodes.length).fill(0);
  const state: number[] = Array(nodes.length).fill(0);
  for (let root = 0; root < nodes.length; root++) {
    if (state[root] !== 0) continue;
    const stack: { node: number; next: number; best: number }[] = [{ node: root, next: 0, best: 0 }];
    state[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const ps = preds[top.node]!;
      if (top.next < ps.length) {
        const p = ps[top.next++]!;
        if (state[p] === 0) {
          state[p] = 1;
          stack.push({ node: p, next: 0, best: 0 });
        } else if (state[p] === 2) top.best = Math.max(top.best, arrival[p]!);
        continue;
      }
      stack.pop();
      state[top.node] = 2;
      const t = nodes[top.node]!.type;
      arrival[top.node] = STORED.has(t) || t === 'const' || t === 'pin' ? 0 : top.best + delay[top.node]!;
      const parent = stack[stack.length - 1];
      if (parent) parent.best = Math.max(parent.best, arrival[top.node]!);
    }
  }
  let clockDepth = 0;
  for (const e of edges) if (e.to.pin === 'clk' && CLOCKED.has(nodes[e.to.part]!.type)) clockDepth = Math.max(clockDepth, arrival[e.from.part]!);
  const latency = Math.max(0, ...outputs.map((o) => Math.max(0, ...preds[o]!.map((p) => arrival[p]!))));
  return { latency, clockDepth };
}

/**
 * Place the parts and wire them up. `registerDelay` is set on every register when some clock passes through
 * logic: a register clocked late would otherwise see data that registers on the early clock have already changed,
 * which a Verilog simulator never lets happen (nonblocking assignments update after every clock has fired).
 */
function placeCircuit({ name, g, inputs, outputs }: Graph, id: string, registerDelay: number | undefined): Circuit {
  if (registerDelay !== undefined) for (const n of g.nodes) if (CLOCKED.has(n.type)) n.props = { ...n.props, delay: registerDelay };
  const place = layout({ nodes: g.nodes, edges: g.edges, inputs, outputs, isCut: (from) => isStoredQ(from, g.nodes) });
  return buildCircuit(emptyCircuit(name, id), (draft) => {
    const ids = g.nodes.map((n, i) => draft.addComponent({ type: n.type, x: place[i]!.x, y: place[i]!.y, rot: n.rot, label: n.label, props: n.props }));
    const pointOf = (part: number, pin: string) => {
      const comp = draft.component(ids[part]!);
      return comp && pinPoint(comp, pin);
    };

    // Wires leaving one pin share a vertical trunk just right of the part; different pins in a column use different lanes.
    const lane = new Map<string, number>();
    const nextLane = new Map<number, number>();
    for (const e of g.edges) {
      const r = draft.connect({ comp: ids[e.from.part]!, pin: e.from.pin }, { comp: ids[e.to.part]!, pin: e.to.pin });
      if ('error' in r) throw new LowerError(`Could not wire ${g.nodes[e.from.part]!.type}.${e.from.pin} to ${g.nodes[e.to.part]!.type}.${e.to.pin}: ${r.error}.`);
      const a = pointOf(e.from.part, e.from.pin);
      const b = pointOf(e.to.part, e.to.pin);
      if (!a || !b || a.wside !== 'r' || b.wside !== 'l' || b.wx - a.wx < 40) continue;
      const key = `${e.from.part}:${e.from.pin}`;
      if (!lane.has(key)) {
        const col = place[e.from.part]!.col;
        lane.set(key, nextLane.get(col) ?? 0);
        nextLane.set(col, (nextLane.get(col) ?? 0) + 1);
      }
      const mid = a.wx + 20 + 10 * (lane.get(key)! % 6);
      if (mid <= b.wx - 10) draft.setWireMid(r.id, mid);
    }
  });
}

const MAX_REGISTER_DELAY = 64;

export function lowerToProject(design: Design, opts: LowerOptions = { view: 'blocks' }): Project {
  const view = opts.view;
  const ids = new Map<string, string>();
  design.modules.forEach((m, i) => ids.set(m.name, m.name === design.top ? 'main' : `k${i + 2}`));
  const circuitOf = (name: string) => ids.get(name)!;
  const latency = new Map<string, number>();

  // Support circuits are placed as soon as a cell asks for one, so a module that instantiates them can be laid out.
  const support: Circuit[] = [];
  const supportIds = new Map<string, string>();
  const lib: SupportLib = {
    circuit(key, name, build) {
      const hit = supportIds.get(key);
      if (hit) return hit;
      const g = new ModuleGraph();
      const b = new GB(g, lib);
      build(b);
      g.finish(() => '');
      const graph: Graph = { name, g, inputs: b.inputs, outputs: b.outputs, ...analyseTiming(g, b.outputs, (c) => latency.get(c) ?? 0) };
      const id = `s${support.length + 1}`;
      useProject({ name: design.top, main: 'main', circuits: support });
      support.push(placeCircuit(graph, id, undefined));
      supportIds.set(key, id);
      latency.set(id, graph.latency);
      return id;
    },
  };

  const graphs = design.modules.map((m) => {
    const graph = buildGraph(m, view, circuitOf, (circuit) => latency.get(circuit) ?? 0, lib);
    latency.set(circuitOf(m.name), graph.latency);
    return { graph, id: circuitOf(m.name) };
  });
  const deepestClock = Math.max(0, ...graphs.map((x) => x.graph.clockDepth));
  const registerDelay = deepestClock > 0 ? Math.min(MAX_REGISTER_DELAY, deepestClock + 1) : undefined;
  const built: Circuit[] = [];
  for (const { graph, id } of graphs) {
    useProject({ name: design.top, main: 'main', circuits: [...support, ...built] });
    built.push(placeCircuit(graph, id, registerDelay));
  }
  const main = built.find((c) => c.id === 'main')!;
  const project: Project = { name: design.top, main: 'main', circuits: [main, ...built.filter((c) => c !== main), ...support] };
  useProject(project);
  return project;
}

