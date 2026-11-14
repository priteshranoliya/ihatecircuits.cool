import { boundsOf, snap, wireRoute } from './geometry';
import { getDef, pinsOf, sanitizeProps } from './library';
import type { Circuit, Component, PinRef, Props, Rotation, Wire } from './types';
import { GRID } from './types';

/** Pure, immutable circuit edits. Each returns a new Circuit; inputs are never mutated. */

export const emptyCircuit = (name = 'Untitled circuit', id = 'main'): Circuit => ({ id, name, nextId: 1, components: {}, wires: {} });

export interface NewComponent {
  type: string;
  x: number;
  y: number;
  rot?: Rotation;
  label?: string;
  props?: Readonly<Record<string, unknown>>;
}

export function addComponent(c: Circuit, spec: NewComponent): { circuit: Circuit; id: string } {
  // Subcircuit instances (type "sub:<id>") have no props; their circuit may not be resolvable yet.
  const sub = spec.type.startsWith('sub:');
  if (!sub) getDef(spec.type);
  const id = `c${c.nextId}`;
  const comp: Component = {
    id,
    type: spec.type,
    x: snap(spec.x),
    y: snap(spec.y),
    rot: spec.rot ?? 0,
    label: spec.label ?? '',
    props: sub ? {} : sanitizeProps(spec.type, spec.props),
  };
  return { circuit: { ...c, nextId: c.nextId + 1, components: { ...c.components, [id]: comp } }, id };
}

/** Next unused label in a sequence: A, B, C… for inputs; Y1, Y2… for outputs. */
export function nextLabel(c: Circuit, type: string): string {
  const def = getDef(type);
  const used = new Set(Object.values(c.components).map((x) => x.label));
  if (def.source) {
    for (let i = 0; i < 26; i++) {
      const l = String.fromCharCode(65 + i);
      if (!used.has(l)) return l;
    }
    for (let i = 1; ; i++) if (!used.has(`In${i}`)) return `In${i}`;
  }
  if (def.sink) {
    for (let i = 1; ; i++) if (!used.has(`Y${i}`)) return `Y${i}`;
  }
  return '';
}

export type WireError = 'same-pin' | 'unknown-pin' | 'duplicate';

type PinDir = 'in' | 'out' | 'io';

/**
 * Wire two pins together. Wires are undirected: they join pins into one net,
 * and a net may have several drivers (tri-state buses), resolved per bit.
 * For drawing, an output end is put first when there is one.
 */
export function connect(c: Circuit, a: PinRef, b: PinRef): { circuit: Circuit; id: string } | { error: WireError } {
  const da = pinDir(c, a);
  const db = pinDir(c, b);
  if (!da || !db) return { error: 'unknown-pin' };
  if (sameRef(a, b)) return { error: 'same-pin' };
  if (Object.values(c.wires).some((w) => (sameRef(w.from, a) && sameRef(w.to, b)) || (sameRef(w.from, b) && sameRef(w.to, a)))) return { error: 'duplicate' };
  const [from, to] = orient(a, b, da, db);
  const id = `w${c.nextId}`;
  return { circuit: { ...c, nextId: c.nextId + 1, wires: { ...c.wires, [id]: { id, from, to } } }, id };
}

const orient = (a: PinRef, b: PinRef, da: PinDir, db: PinDir): [PinRef, PinRef] => (da === 'in' && db !== 'in' ? [b, a] : [a, b]);

const wireKey = (a: PinRef, b: PinRef) => `${a.comp}.${a.pin}|${b.comp}.${b.pin}`;

/**
 * A mutable draft of a circuit for building many parts and wires at once.
 * `addComponent`, `connect` and `setWireMid` do what the pure edits of the same
 * name do, with the same validation and ids, but update the draft in place and
 * look for duplicate wires in a set, so n edits cost O(n) instead of O(n^2).
 * `freeze` returns the finished Circuit; the draft must not be used after that.
 */
export class CircuitDraft {
  private readonly components: Record<string, Component>;
  private readonly wires: Record<string, Wire>;
  private nextId: number;
  private readonly pinDirs = new Map<string, Map<string, PinDir>>();
  private readonly joined = new Set<string>();

  constructor(private readonly base: Circuit) {
    this.components = { ...base.components };
    this.wires = { ...base.wires };
    this.nextId = base.nextId;
    for (const w of Object.values(base.wires)) this.joined.add(wireKey(w.from, w.to));
  }

  addComponent(spec: NewComponent): string {
    const { circuit, id } = addComponent({ ...this.base, nextId: this.nextId, components: {}, wires: {} }, spec);
    this.components[id] = circuit.components[id]!;
    this.nextId = circuit.nextId;
    return id;
  }

  component(id: string): Component | undefined {
    return this.components[id];
  }

  private dirOf(ref: PinRef): PinDir | undefined {
    const comp = this.components[ref.comp];
    if (!comp) return undefined;
    let dirs = this.pinDirs.get(comp.id);
    if (!dirs) {
      dirs = new Map(pinsOf(comp).map((p) => [p.name, p.dir]));
      this.pinDirs.set(comp.id, dirs);
    }
    return dirs.get(ref.pin);
  }

  connect(a: PinRef, b: PinRef): { id: string } | { error: WireError } {
    const da = this.dirOf(a);
    const db = this.dirOf(b);
    if (!da || !db) return { error: 'unknown-pin' };
    if (sameRef(a, b)) return { error: 'same-pin' };
    if (this.joined.has(wireKey(a, b)) || this.joined.has(wireKey(b, a))) return { error: 'duplicate' };
    const [from, to] = orient(a, b, da, db);
    const id = `w${this.nextId++}`;
    this.wires[id] = { id, from, to };
    this.joined.add(wireKey(from, to));
    return { id };
  }

  setWireMid(id: string, mid: number | undefined) {
    const w = this.wires[id];
    if (w) this.wires[id] = mid === undefined ? withoutMid(w) : { ...w, mid: snap(mid) };
  }

  freeze(): Circuit {
    return { ...this.base, nextId: this.nextId, components: this.components, wires: this.wires };
  }
}

/** Run `build` against a draft of `c` and return the frozen result. */
export function buildCircuit(c: Circuit, build: (draft: CircuitDraft) => void): Circuit {
  const draft = new CircuitDraft(c);
  build(draft);
  return draft.freeze();
}

/** Connect many pin pairs at once. Stops at the first invalid pair and reports its index; nothing partial is returned. */
export function connectMany(c: Circuit, pairs: ReadonlyArray<readonly [PinRef, PinRef]>): { circuit: Circuit; ids: string[] } | { error: WireError; index: number } {
  const draft = new CircuitDraft(c);
  const ids: string[] = [];
  for (let index = 0; index < pairs.length; index++) {
    const r = draft.connect(pairs[index]![0], pairs[index]![1]);
    if ('error' in r) return { error: r.error, index };
    ids.push(r.id);
  }
  return { circuit: draft.freeze(), ids };
}

export const sameRef = (a: PinRef, b: PinRef) => a.comp === b.comp && a.pin === b.pin;

export function pinDir(c: Circuit, ref: PinRef): 'in' | 'out' | 'io' | undefined {
  const comp = c.components[ref.comp];
  return comp && pinsOf(comp).find((p) => p.name === ref.pin)?.dir;
}

export function moveComponents(c: Circuit, ids: readonly string[], dx: number, dy: number): Circuit {
  if (ids.length === 0 || (dx === 0 && dy === 0)) return c;
  const components = { ...c.components };
  const moving = new Set(ids);
  for (const id of ids) {
    const comp = components[id];
    if (comp) components[id] = { ...comp, x: comp.x + dx, y: comp.y + dy };
  }
  // A wire between two moved components keeps its shape; other bends are re-centred.
  const wires = { ...c.wires };
  for (const w of Object.values(c.wires)) {
    if (w.mid === undefined) continue;
    const a = moving.has(w.from.comp);
    const b = moving.has(w.to.comp);
    if (a && b) wires[w.id] = { ...w, mid: w.mid + (isVerticalMid(c, w) ? dx : dy) };
    else if (a || b) wires[w.id] = withoutMid(w);
  }
  return { ...c, components, wires };
}

function isVerticalMid(c: Circuit, w: Wire): boolean {
  return wireRoute(c, w)?.axis !== 'y';
}

function withoutMid(w: Wire): Wire {
  const { mid: _drop, ...rest } = w;
  return rest;
}

/** Delete components (and their wires) and wires. */
export function deleteItems(c: Circuit, ids: readonly string[]): Circuit {
  const gone = new Set(ids);
  const components = { ...c.components };
  for (const id of ids) delete components[id];
  const wires: Record<string, Wire> = {};
  for (const w of Object.values(c.wires)) {
    if (gone.has(w.id) || gone.has(w.from.comp) || gone.has(w.to.comp)) continue;
    wires[w.id] = w;
  }
  return { ...c, components, wires };
}

export function updateComponent(
  c: Circuit,
  id: string,
  patch: { label?: string; rot?: Rotation; props?: Readonly<Record<string, unknown>> },
): Circuit {
  const comp = c.components[id];
  if (!comp) return c;
  const props: Props = patch.props ? sanitizeProps(comp.type, { ...comp.props, ...patch.props }) : comp.props;
  const next: Component = {
    ...comp,
    label: patch.label !== undefined ? patch.label.slice(0, 40) : comp.label,
    rot: patch.rot ?? comp.rot,
    props: shallowEqual(props, comp.props) ? comp.props : props,
  };
  let out: Circuit = { ...c, components: { ...c.components, [id]: next } };
  if (next.props !== comp.props || next.rot !== comp.rot) out = pruneWires(out, id);
  return out;
}

/** Rotate a component a quarter turn clockwise about its centre (kept on the grid). */
export function rotateComponent(c: Circuit, id: string): Circuit {
  const comp = c.components[id];
  if (!comp) return c;
  const b = boundsOf(comp);
  const rot = ((comp.rot + 90) % 360) as Rotation;
  const moved = updateComponent(c, id, { rot });
  const nb = boundsOf(moved.components[id]);
  // Keep the centre fixed. Truncating the half-cell offset toward zero makes
  // successive quarter turns cancel, so four rotations return to the start.
  const off = (d: number) => Math.trunc(d / 2 / GRID) * GRID;
  return {
    ...moved,
    components: { ...moved.components, [id]: { ...moved.components[id], x: comp.x + off(b.w - nb.w), y: comp.y + off(b.h - nb.h) } },
  };
}

/** Drop wires that reference pins a component no longer has; reset bends on the rest. */
function pruneWires(c: Circuit, id: string): Circuit {
  const comp = c.components[id];
  const names = new Set(pinsOf(comp).map((p) => p.name));
  const wires: Record<string, Wire> = {};
  for (const w of Object.values(c.wires)) {
    const touches = w.from.comp === id || w.to.comp === id;
    if (!touches) wires[w.id] = w;
    else if ((w.from.comp !== id || names.has(w.from.pin)) && (w.to.comp !== id || names.has(w.to.pin))) wires[w.id] = withoutMid(w);
  }
  return { ...c, wires };
}

export function setWireMid(c: Circuit, id: string, mid: number | undefined): Circuit {
  const w = c.wires[id];
  if (!w) return c;
  return { ...c, wires: { ...c.wires, [id]: mid === undefined ? withoutMid(w) : { ...w, mid: snap(mid) } } };
}

export interface Fragment {
  components: Component[];
  wires: Wire[];
}

/** Copy components plus the wires that run between them. */
export function extractFragment(c: Circuit, ids: readonly string[]): Fragment {
  const set = new Set(ids.filter((id) => c.components[id]));
  return {
    components: [...set].map((id) => c.components[id]),
    wires: Object.values(c.wires).filter((w) => set.has(w.from.comp) && set.has(w.to.comp)),
  };
}

/** Insert a fragment with fresh ids, offset by (dx, dy). Returns the ids of the new items. */
export function pasteFragment(c: Circuit, frag: Fragment, dx: number, dy: number): { circuit: Circuit; ids: string[] } {
  let next = c.nextId;
  const map = new Map<string, string>();
  const components = { ...c.components };
  const wires = { ...c.wires };
  const ids: string[] = [];
  for (const comp of frag.components) {
    if (!getDef(comp.type)) continue;
    const id = `c${next++}`;
    map.set(comp.id, id);
    components[id] = { ...comp, id, x: snap(comp.x + dx), y: snap(comp.y + dy) };
    ids.push(id);
  }
  for (const w of frag.wires) {
    const from = map.get(w.from.comp);
    const to = map.get(w.to.comp);
    if (!from || !to) continue;
    const id = `w${next++}`;
    wires[id] = { ...w, id, from: { ...w.from, comp: from }, to: { ...w.to, comp: to } };
    ids.push(id);
  }
  const out: Circuit = { ...c, nextId: next, components, wires };
  for (const id of ids) {
    const w = wires[id];
    if (w?.mid !== undefined) wires[id] = { ...w, mid: w.mid + (isVerticalMid(out, w) ? dx : dy) };
  }
  return { circuit: out, ids };
}

function shallowEqual(a: Props, b: Props): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
