import { GRID, getDef, rotatePoint, sanitizeProps, type PinDef, type Rotation } from './core';

/**
 * Layered layout for a graph of parts.
 *
 * Columns are logic depth: a part sits one column right of the deepest part
 * that feeds it. Edges leaving a register's Q are not counted, which both
 * breaks feedback loops and puts registers where their inputs are ready.
 * Within a column parts are ordered by where their drivers are and stacked
 * with a fixed gap; every coordinate is on the 10px grid and no two parts
 * overlap. Inputs stay in the first column and outputs in the last, each in
 * declaration order.
 */

export interface PartNode {
  type: string;
  /** Sanitised props. */
  props: Record<string, unknown>;
  label: string;
  rot: Rotation;
}

export interface PinKey {
  part: number;
  pin: string;
}

export interface Edge {
  from: PinKey;
  to: PinKey;
}

export interface Placement {
  x: number;
  y: number;
  col: number;
}

const COLUMN_GUTTER = 80;
const ROW_GAP = 20;
const TOP = 20;
const LEFT = 20;
const LABEL_CHAR_WIDTH = 8;

const snap = (v: number) => Math.round(v / GRID) * GRID;
const up = (v: number) => Math.ceil(v / GRID) * GRID;

interface Geometry {
  w: number;
  h: number;
  pins: Map<string, { x: number; y: number }>;
}

export function geometryOf(node: PartNode): Geometry {
  const def = getDef(node.type);
  const props = node.type.startsWith('sub:') ? {} : sanitizeProps(node.type, node.props);
  const { w, h } = def.size(props);
  const pins = new Map(def.pins(props).map((p: PinDef) => [p.name, rotatePoint(p.x, p.y, w, h, node.rot)]));
  return { w, h, pins };
}

export interface LayoutInput {
  nodes: PartNode[];
  edges: Edge[];
  /** Nodes that are circuit inputs / outputs, in declaration order. */
  inputs: number[];
  outputs: number[];
  /** Pins whose outgoing edges do not constrain the columns (register Q). */
  isCut(from: PinKey): boolean;
}

export function layout(input: LayoutInput): Placement[] {
  const { nodes, edges } = input;
  const geo = nodes.map(geometryOf);
  const isConst = nodes.map((n) => n.type === 'const');
  const isOutput = new Set(input.outputs);

  const preds: number[][] = nodes.map(() => []);
  for (const e of edges) if (!input.isCut(e.from) && e.from.part !== e.to.part) preds[e.to.part]!.push(e.from.part);

  // Column = longest path from a source. Walked with an explicit stack so a very long chain cannot overflow the call stack;
  // a part reached again while it is still being walked closes a loop and is ignored.
  const col: number[] = Array(nodes.length).fill(-1);
  const state: number[] = Array(nodes.length).fill(0);
  for (let root = 0; root < nodes.length; root++) {
    if (state[root] !== 0) continue;
    const stack: { node: number; next: number; d: number }[] = [{ node: root, next: 0, d: 0 }];
    state[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const ps = preds[top.node]!;
      if (top.next < ps.length) {
        const p = ps[top.next++]!;
        if (state[p] === 2) top.d = Math.max(top.d, col[p]! + 1);
        else if (state[p] === 0) {
          state[p] = 1;
          stack.push({ node: p, next: 0, d: 0 });
        }
        continue;
      }
      stack.pop();
      state[top.node] = 2;
      col[top.node] = top.d;
      const parent = stack[stack.length - 1];
      if (parent) parent.d = Math.max(parent.d, top.d + 1);
    }
  }
  for (const i of input.inputs) col[i] = 0;
  let last = 0;
  nodes.forEach((_, i) => {
    if (!isOutput.has(i) && !isConst[i]) last = Math.max(last, col[i]!);
  });
  for (const i of input.outputs) col[i] = last + 1;

  const consumers: number[][] = nodes.map(() => []);
  for (const e of edges) consumers[e.from.part]!.push(e.to.part);
  nodes.forEach((_, i) => {
    if (!isConst[i]) return;
    const cs = consumers[i]!.map((c) => col[c]!);
    col[i] = cs.length ? Math.max(0, Math.min(...cs) - 1) : 0;
  });

  const maxCol = Math.max(0, ...col);
  const labelPad = Math.max(0, ...input.inputs.map((i) => nodes[i]!.label.length * LABEL_CHAR_WIDTH + 8));
  const colW: number[] = Array(maxCol + 1).fill(0);
  nodes.forEach((_, i) => (colW[col[i]!] = Math.max(colW[col[i]!]!, geo[i]!.w)));
  const colX: number[] = [];
  let x = up(LEFT + labelPad);
  for (let c = 0; c <= maxCol; c++) {
    colX.push(x);
    x += colW[c]! > 0 ? colW[c]! + COLUMN_GUTTER : 0;
  }

  const byCol: number[][] = Array.from({ length: maxCol + 1 }, () => []);
  nodes.forEach((_, i) => {
    if (!isConst[i]) byCol[col[i]!]!.push(i);
  });

  const y: number[] = Array(nodes.length).fill(0);
  const placed: boolean[] = Array(nodes.length).fill(false);
  const incoming: Edge[][] = nodes.map(() => []);
  for (const e of edges) incoming[e.to.part]!.push(e);

  const inputSet = new Set(input.inputs);
  const pinY = (p: PinKey) => y[p.part]! + (geo[p.part]!.pins.get(p.pin)?.y ?? 0);

  for (let c = 0; c <= maxCol; c++) {
    const members = byCol[c]!;
    const memberSet = new Set(members);
    const wants = new Map<number, number | undefined>();
    for (const i of members) {
      const ys = incoming[i]!.filter((e) => placed[e.from.part] && col[e.from.part]! < c).map((e) => pinY(e.from) - (geo[i]!.pins.get(e.to.pin)?.y ?? 0));
      wants.set(i, ys.length ? snap(ys.reduce((a, b) => a + b, 0) / ys.length) : undefined);
    }
    const byWant = [...members].sort((a, b) => (wants.get(a) ?? Infinity) - (wants.get(b) ?? Infinity) || a - b);
    const inColumn = (list: number[]) => list.filter((i) => memberSet.has(i));
    let sequence = byWant;
    if (c === 0) sequence = [...inColumn(input.inputs), ...byWant.filter((i) => !inputSet.has(i))];
    if (c === last + 1) sequence = [...inColumn(input.outputs), ...byWant.filter((i) => !isOutput.has(i))];
    let top = TOP;
    for (const i of sequence) {
      y[i] = Math.max(wants.get(i) ?? top, top, 0);
      top = y[i]! + geo[i]!.h + ROW_GAP;
      placed[i] = true;
    }
  }

  // Constants go in the nearest free slot beside the part that reads them.
  const firstSink = new Map<number, PinKey>();
  for (const e of edges) if (!firstSink.has(e.from.part)) firstSink.set(e.from.part, e.to);
  // Placed parts of each column in ascending index order, so the first clash found is the lowest-numbered one.
  const placedIn: number[][] = Array.from({ length: maxCol + 1 }, () => []);
  nodes.forEach((_, j) => {
    if (placed[j]) placedIn[col[j]!]!.push(j);
  });
  nodes.forEach((_, i) => {
    if (!isConst[i]) return;
    const sink = firstSink.get(i);
    let want = sink ? snap(pinY(sink) - (geo[i]!.pins.get('out')?.y ?? 10)) : TOP;
    if (sink && !placed[sink.part]) want = TOP;
    want = Math.max(want, 0);
    const column = placedIn[col[i]!]!;
    for (;;) {
      let clash: number | undefined;
      for (const j of column) {
        if (y[j]! < want + geo[i]!.h + ROW_GAP / 2 && want < y[j]! + geo[j]!.h + ROW_GAP / 2) {
          clash = j;
          break;
        }
      }
      if (clash === undefined) break;
      want = y[clash]! + geo[clash]!.h + ROW_GAP;
    }
    y[i] = want;
    placed[i] = true;
    let at = column.length;
    while (at > 0 && column[at - 1]! > i) at--;
    column.splice(at, 0, i);
  });

  return nodes.map((_, i) => ({ x: colX[col[i]!]!, y: y[i]!, col: col[i]! }));
}
