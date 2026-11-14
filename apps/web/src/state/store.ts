import { create } from 'zustand';
import '@ihatecircuits/core/parts';
import { type Bits } from '@ihatecircuits/core/bits';
import {
  addComponent,
  connect,
  deleteItems,
  extractFragment,
  moveComponents,
  nextLabel,
  pasteFragment,
  rotateComponent,
  updateComponent,
  type Fragment,
  type WireError,
} from '@ihatecircuits/core/edit';
import { EXAMPLES } from '@ihatecircuits/core/examples';
import { circuitBounds, sizeOf, snap } from '@ihatecircuits/core/geometry';
import { getDef, isSink, isSource, sanitizeProps } from '@ihatecircuits/core/library';
import { addCircuit, canNest, circuitById, lookupIn, newProject, removeCircuit, renameCircuit, replaceCircuit, subTarget, subType, useProject } from '@ihatecircuits/core/project';
import { parseProject, serialize } from '@ihatecircuits/core/serialize';
import { Simulator } from '@ihatecircuits/core/sim';
import type { Circuit, PinRef, Project, Rect } from '@ihatecircuits/core/types';

export type Tool = 'select' | 'hand' | 'text';

const PREFS_KEY = 'ihatecircuits:prefs:v1';
function loadPrefs(): { recents: string[]; favorites: string[] } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return { recents: Array.isArray(p.recents) ? p.recents.slice(0, 8) : [], favorites: Array.isArray(p.favorites) ? p.favorites : [] };
  } catch {
    return { recents: [], favorites: [] };
  }
}
function savePrefs(recents: string[], favorites: string[]) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ recents, favorites }));
  } catch {
    /* per-device convenience only */
  }
}

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
  /** Optional one-click action, e.g. Undo. */
  action?: { label: string; run: () => void };
}

/** One signal shown in the timing diagram. */
export interface Signal {
  id: string;
  pin: string;
  name: string;
  kind: 'clock' | 'input' | 'output' | 'probe';
  width: number;
  /** Value changes over simulated time (in gate delays). */
  changes: { t: number; v: Bits }[];
}

export type Dialog = null | 'examples' | 'analysis' | 'help' | 'memory' | 'palette' | 'tests' | 'build';

const HISTORY_LIMIT = 200;
const MAX_CHANGES = 600;
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;
const STORAGE_KEY = 'ihatecircuits:autosave:v2';
const LEGACY_KEY = 'ihatecircuits:autosave:v1';
/** Autosave keys used before the project was renamed. Read once so earlier work still opens. */
const RENAMED_KEYS = ['gatewright:autosave:v2', 'gatewright:autosave:v1'];

const WIRE_MESSAGES: Record<WireError, string> = {
  'same-pin': 'Drag to a different pin.',
  'unknown-pin': 'That pin no longer exists.',
  duplicate: 'Those pins are already connected.',
};

interface Snapshot {
  project: Project;
  active: string;
}

export interface EditorState {
  project: Project;
  /** Id of the circuit being edited and simulated. */
  active: string;
  past: Snapshot[];
  future: Snapshot[];
  sim: Simulator;
  simRev: number;
  selection: string[];
  view: View;
  views: Record<string, View>;
  pending: PinRef | null;
  placing: string | null;
  /** Active canvas tool: select/move (default), hand (pan) or text (click to add a note). */
  tool: Tool;
  /** Circuits entered by double-clicking subcircuits, outermost first (for the breadcrumb). */
  trail: string[];
  /** Parts placed most recently, newest first. */
  recents: string[];
  favorites: string[];
  /** Right-click menu position and target, if open. */
  menu: { x: number; y: number; target: string | null } | null;
  running: boolean;
  rate: number;
  signals: Signal[];
  toast: Toast | null;
  dialog: Dialog;
  /** Component the memory editor is open on. */
  memoryTarget: string | null;
  clipboard: Fragment | null;

  circuit(): Circuit;
  commit(next: Circuit, selection?: string[]): void;
  commitProject(next: Project, active?: string, message?: string): void;
  preview(next: Circuit): void;
  commitFrom(before: Circuit): void;
  undo(): void;
  redo(): void;

  place(type: string, x: number, y: number): string | null;
  wire(a: PinRef, b: PinRef): boolean;
  removeSelection(): void;
  rotateSelection(): void;
  nudge(dx: number, dy: number): void;
  copy(): void;
  cut(): void;
  paste(): void;
  duplicate(): void;
  selectAll(): void;
  setSelection(ids: string[]): void;
  setView(v: Partial<View>): void;
  zoomAt(factor: number, sx: number, sy: number): void;
  fitView(viewport: { w: number; h: number }): void;

  openCircuit(id: string): void;
  newCircuit(name?: string): void;
  renameCircuit(id: string, name: string): void;
  deleteCircuit(id: string): void;
  setMain(id: string): void;

  poke(id: string, key: string, value: unknown): void;
  setPartState(id: string, state: unknown): void;
  step(): void;
  resetSim(): void;
  setRunning(r: boolean): void;
  setRate(r: number): void;
  clearSignals(): void;

  load(p: Project, message?: string): void;
  loadExample(id: string): void;
  openFile(text: string): void;
  notify(text: string, tone?: Toast['tone'], action?: Toast['action']): void;
  setDialog(d: Dialog, memoryTarget?: string): void;
  setPending(p: PinRef | null): void;
  setPlacing(t: string | null): void;
  setTool(t: Tool): void;
  enterCircuit(id: string): void;
  ascend(to?: number): void;
  toggleFavorite(type: string): void;
  setMenu(m: EditorState['menu']): void;
}

let toastSeq = 0;

function loadSaved(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY) ?? RENAMED_KEYS.map((k) => localStorage.getItem(k)).find((v) => v !== null) ?? null;
    return raw ? parseProject(raw).project : null;
  } catch {
    return null;
  }
}

/** Keep switch positions from the live project when restoring an older snapshot, so undo never flips inputs. */
function keepRuntime(snapshot: Project, live: Project): Project {
  return {
    ...snapshot,
    circuits: snapshot.circuits.map((c) => {
      const now = live.circuits.find((x) => x.id === c.id);
      if (!now) return c;
      let components = c.components;
      for (const comp of Object.values(c.components)) {
        const cur = now.components[comp.id];
        if (!cur || cur.type !== comp.type || subTarget(comp.type)) continue;
        const runtime = getDef(comp.type).props.filter((p) => p.runtime);
        if (runtime.some((p) => cur.props[p.key] !== comp.props[p.key])) {
          const props = { ...comp.props };
          for (const p of runtime) props[p.key] = cur.props[p.key];
          components = { ...components, [comp.id]: { ...comp, props } };
        }
      }
      return components === c.components ? c : { ...c, components };
    }),
  };
}

const natural = new Intl.Collator(undefined, { numeric: true });

/** Parts whose values the timing diagram follows. */
function signalSpecs(c: Circuit): Omit<Signal, 'changes' | 'width'>[] {
  const comps = Object.values(c.components);
  const name = (x: { label: string; id: string }, fallback: string) => x.label.trim() || `${fallback} ${x.id}`;
  const sorted = (xs: typeof comps) => xs.sort((a, b) => natural.compare(a.label || a.id, b.label || b.id));
  return [
    ...sorted(comps.filter((x) => x.type === 'clock')).map((x) => ({ id: x.id, pin: 'out', name: name(x, 'Clock'), kind: 'clock' as const })),
    ...sorted(comps.filter((x) => isSource(x))).map((x) => ({ id: x.id, pin: x.type === 'pin' ? 'p' : 'out', name: name(x, 'In'), kind: 'input' as const })),
    ...sorted(comps.filter((x) => x.type === 'probe')).map((x) => ({ id: x.id, pin: 'p', name: name(x, 'Probe'), kind: 'probe' as const })),
    ...sorted(comps.filter((x) => isSink(x) && (x.type === 'led' || x.type === 'pin'))).map((x) => ({
      id: x.id,
      pin: x.type === 'pin' ? 'p' : 'in',
      name: name(x, 'Out'),
      kind: 'output' as const,
    })),
  ].slice(0, 24);
}

const initialProject = loadSaved() ?? EXAMPLES.find((e) => e.id === 'half-adder')!.build();
useProject(initialProject);

function buildSim(p: Project, active: string, prev?: Simulator): Simulator {
  return new Simulator(circuitById(p, active)!, { lookup: lookupIn(p), prev });
}

/** Follow net changes of the timing-diagram signals. Mutates the returned signals as the simulation runs. */
function attach(sim: Simulator, circuit: Circuit, keep: Signal[] = []): Signal[] {
  const old = new Map(keep.map((s) => [`${s.id}:${s.pin}`, s]));
  const signals: Signal[] = [];
  const watchers = new Map<number, number[]>();
  const netsOf: number[][] = [];
  for (const spec of signalSpecs(circuit)) {
    const nets = sim.netsOf(spec.id, spec.pin);
    if (!nets) continue;
    const prev = old.get(`${spec.id}:${spec.pin}`);
    const changes = prev && prev.width === nets.length ? prev.changes : [{ t: sim.time, v: sim.netsValue(nets) }];
    const idx = signals.length;
    signals.push({ ...spec, width: nets.length, changes });
    netsOf.push(nets);
    nets.forEach((n) => watchers.set(n, [...(watchers.get(n) ?? []), idx]));
  }
  sim.onNetChange = (t, net) => {
    const list = watchers.get(net);
    if (!list) return;
    for (const i of list) {
      const sig = signals[i];
      const v = sim.netsValue(netsOf[i]);
      const last = sig.changes[sig.changes.length - 1];
      if (last && last.t === t) last.v = v;
      else sig.changes.push({ t, v });
      if (sig.changes.length > MAX_CHANGES) sig.changes.splice(0, sig.changes.length - MAX_CHANGES);
    }
  };
  return signals;
}

export const useEditor = create<EditorState>()((set, get) => {
  /** Swap in a new project state and rebuild the simulator, carrying state over when the circuit is the same. */
  const apply = (project: Project, active: string, extra: Partial<EditorState> = {}, fresh = false) => {
    const s = get();
    useProject(project);
    // A different project or circuit starts from power-on; edits to the same circuit keep state.
    const same = active === s.active && !fresh;
    const sim = buildSim(project, active, same ? s.sim : undefined);
    const circuit = circuitById(project, active)!;
    const signals = attach(sim, circuit, same ? s.signals : []);
    const valid = new Set([...Object.keys(circuit.components), ...Object.keys(circuit.wires)]);
    const views = same ? s.views : { ...s.views, [s.active]: s.view };
    set({
      project,
      active,
      sim,
      signals,
      simRev: s.simRev + 1,
      selection: (extra.selection ?? (same ? s.selection : [])).filter((id) => valid.has(id)),
      pending: same && s.pending && circuit.components[s.pending.comp] ? s.pending : null,
      views,
      view: same ? s.view : (views[active] ?? s.view),
      ...extra,
    });
  };

  const pushHistory = () => {
    const s = get();
    const past = [...s.past, { project: s.project, active: s.active }];
    if (past.length > HISTORY_LIMIT) past.shift();
    return { past, future: [] as Snapshot[] };
  };

  const afterSimChange = () => {
    const s = get();
    set({ simRev: s.simRev + 1, signals: [...s.signals] });
  };

  const initialActive = initialProject.main;
  const initialSim = buildSim(initialProject, initialActive);

  return {
    project: initialProject,
    active: initialActive,
    past: [],
    future: [],
    sim: initialSim,
    simRev: 0,
    selection: [],
    view: { x: 80, y: 80, zoom: 1 },
    views: {},
    pending: null,
    placing: null,
    tool: 'select',
    trail: [],
    ...loadPrefs(),
    menu: null,
    running: false,
    rate: 4,
    signals: attach(initialSim, circuitById(initialProject, initialActive)!),
    toast: null,
    dialog: null,
    memoryTarget: null,
    clipboard: null,

    circuit() {
      const s = get();
      return circuitById(s.project, s.active)!;
    },
    commit(next, selection) {
      const s = get();
      if (next === s.circuit()) return;
      apply(replaceCircuit(s.project, next), s.active, { ...pushHistory(), ...(selection ? { selection } : {}) });
    },
    commitProject(next, active, message) {
      const s = get();
      apply(next, active ?? s.active, pushHistory());
      if (message) s.notify(message);
    },
    preview(next) {
      // Moves do not change connectivity, so the simulator is kept as is.
      set({ project: replaceCircuit(get().project, next) });
    },
    commitFrom(before) {
      const s = get();
      if (before === s.circuit()) return;
      const past = [...s.past, { project: replaceCircuit(s.project, before), active: s.active }];
      apply(s.project, s.active, { past, future: [] });
    },
    undo() {
      const s = get();
      const prev = s.past.at(-1);
      if (!prev) return;
      const project = keepRuntime(prev.project, s.project);
      apply(project, circuitById(project, prev.active) ? prev.active : project.main, {
        past: s.past.slice(0, -1),
        future: [{ project: s.project, active: s.active }, ...s.future],
      });
    },
    redo() {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      const project = keepRuntime(next.project, s.project);
      apply(project, circuitById(project, next.active) ? next.active : project.main, {
        past: [...s.past, { project: s.project, active: s.active }],
        future: s.future.slice(1),
      });
    },

    place(type, x, y) {
      const s = get();
      const target = subTarget(type);
      if (target && !canNest(s.project, s.active, target)) {
        s.notify(target === s.active ? 'A circuit cannot contain itself.' : 'That circuit already uses this one, so it cannot go inside it.', 'error');
        set({ placing: null });
        return null;
      }
      const circuit = s.circuit();
      const props = target ? {} : sanitizeProps(type);
      const { w, h } = sizeOf({ type, props, rot: 0 });
      const { circuit: next, id } = addComponent(circuit, { type, x: snap(x - w / 2), y: snap(y - h / 2), label: target ? '' : nextLabel(circuit, type) });
      s.commit(next, [id]);
      const recents = [type, ...s.recents.filter((t) => t !== type)].slice(0, 8);
      savePrefs(recents, s.favorites);
      set({ placing: null, recents });
      return id;
    },
    wire(a, b) {
      const s = get();
      const r = connect(s.circuit(), a, b);
      set({ pending: null });
      if ('error' in r) {
        s.notify(WIRE_MESSAGES[r.error], 'error');
        return false;
      }
      s.commit(r.circuit, [r.id]);
      return true;
    },
    removeSelection() {
      const s = get();
      if (!s.selection.length) return;
      const n = s.selection.length;
      s.commit(deleteItems(s.circuit(), s.selection), []);
      s.notify(`Deleted ${n} item${n === 1 ? '' : 's'}.`, 'info', { label: 'Undo', run: () => get().undo() });
    },
    rotateSelection() {
      const s = get();
      const c = s.circuit();
      const ids = s.selection.filter((id) => c.components[id]);
      if (ids.length) s.commit(ids.reduce(rotateComponent, c));
    },
    nudge(dx, dy) {
      const s = get();
      const c = s.circuit();
      const ids = s.selection.filter((id) => c.components[id]);
      if (ids.length) s.commit(moveComponents(c, ids, dx, dy));
    },
    copy() {
      const s = get();
      const c = s.circuit();
      const ids = s.selection.filter((id) => c.components[id]);
      if (!ids.length) return;
      set({ clipboard: extractFragment(c, ids) });
      s.notify(`Copied ${ids.length} part${ids.length === 1 ? '' : 's'}.`);
    },
    cut() {
      const s = get();
      s.copy();
      s.removeSelection();
    },
    paste() {
      const s = get();
      if (!s.clipboard?.components.length) return;
      // Skip subcircuits that no longer exist or would nest the circuit in itself.
      const frag = {
        ...s.clipboard,
        components: s.clipboard.components.filter((c) => {
          const t = subTarget(c.type);
          return !t || (circuitById(s.project, t) && canNest(s.project, s.active, t));
        }),
      };
      const { circuit, ids } = pasteFragment(s.circuit(), frag, 40, 40);
      set({ clipboard: { ...s.clipboard, components: s.clipboard.components.map((c) => ({ ...c, x: c.x + 40, y: c.y + 40 })) } });
      s.commit(circuit, ids);
    },
    duplicate() {
      const s = get();
      const c = s.circuit();
      const ids = s.selection.filter((id) => c.components[id]);
      if (!ids.length) return;
      const r = pasteFragment(c, extractFragment(c, ids), 40, 40);
      s.commit(r.circuit, r.ids);
    },
    selectAll() {
      const c = get().circuit();
      set({ selection: [...Object.keys(c.components), ...Object.keys(c.wires)] });
    },
    setSelection(ids) {
      set({ selection: ids });
    },
    setView(v) {
      set({ view: { ...get().view, ...v } });
    },
    zoomAt(factor, sx, sy) {
      const v = get().view;
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor));
      const k = zoom / v.zoom;
      set({ view: { zoom, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k } });
    },
    fitView(vp) {
      const b: Rect | null = circuitBounds(get().circuit(), 40);
      if (!b) return set({ view: { x: vp.w / 2, y: vp.h / 2, zoom: 1 } });
      const zoom = Math.min(1.6, Math.max(ZOOM_MIN, Math.min(vp.w / b.w, vp.h / b.h)));
      set({ view: { zoom, x: (vp.w - b.w * zoom) / 2 - b.x * zoom, y: (vp.h - b.h * zoom) / 2 - b.y * zoom } });
    },

    openCircuit(id) {
      const s = get();
      if (id === s.active || !circuitById(s.project, id)) return;
      apply(s.project, id, { running: false, selection: [], trail: [] });
      if (!s.views[id]) requestFit();
    },
    newCircuit(name = 'New circuit') {
      const s = get();
      const r = addCircuit(s.project, name);
      s.commitProject(r.project, r.id, 'Added a circuit. Give it Pin parts for its connections, then place it from Parts › Your circuits.');
    },
    renameCircuit(id, name) {
      const s = get();
      s.commitProject(renameCircuit(s.project, id, name));
    },
    deleteCircuit(id) {
      const s = get();
      if (id === s.project.main) return s.notify('The main circuit cannot be deleted. Make another circuit the main one first.', 'error');
      const name = circuitById(s.project, id)?.name;
      const next = removeCircuit(s.project, id);
      s.commitProject(next, s.active === id ? next.main : s.active, `Deleted “${name}” and every use of it. Undo brings it back.`);
    },
    setMain(id) {
      const s = get();
      s.commitProject({ ...s.project, main: id });
    },

    poke(id, key, value) {
      const s = get();
      const c = s.circuit();
      const comp = c.components[id];
      if (!comp || comp.props[key] === value) return;
      const circuit = updateComponent(c, id, { props: { [key]: value } });
      set({ project: replaceCircuit(s.project, circuit) });
      s.sim.setRuntime(id, key, circuit.components[id].props[key]);
      s.sim.settle();
      afterSimChange();
    },
    setPartState(id, state) {
      const s = get();
      s.sim.setState(id, state);
      s.sim.settle();
      afterSimChange();
    },
    step() {
      get().sim.step();
      afterSimChange();
    },
    resetSim() {
      const s = get();
      s.sim.reset();
      set({ running: false, signals: attach(s.sim, s.circuit()), simRev: s.simRev + 1 });
    },
    setRunning(running) {
      set({ running });
    },
    setRate(rate) {
      set({ rate });
    },
    clearSignals() {
      const s = get();
      set({ signals: attach(s.sim, s.circuit()), simRev: s.simRev + 1 });
    },

    load(p, message) {
      apply(p, p.main, { ...pushHistory(), selection: [], running: false, pending: null, views: {}, trail: [] }, true);
      const g = get();
      g.sim.reset();
      set({ signals: attach(g.sim, g.circuit()), simRev: g.simRev + 1 });
      requestFit();
      if (message) g.notify(message);
    },
    loadExample(id) {
      const ex = EXAMPLES.find((e) => e.id === id);
      if (ex) get().load(ex.build(), `Opened “${ex.title}”. Undo returns to your previous work.`);
    },
    openFile(text) {
      try {
        const { project, warnings } = parseProject(text);
        get().load(project, [`Opened “${project.name}”.`, ...warnings].join(' '));
      } catch (e) {
        get().notify(e instanceof Error ? e.message : 'This file could not be opened.', 'error');
      }
    },
    notify(text, tone = 'info', action) {
      set({ toast: { id: ++toastSeq, text, tone, action } });
    },
    setDialog(dialog, memoryTarget) {
      set({ dialog, memoryTarget: memoryTarget ?? null });
    },
    setPending(pending) {
      set({ pending });
    },
    setTool(tool) {
      set({ tool, placing: null, pending: null });
    },
    enterCircuit(id) {
      const s = get();
      if (id === s.active) return;
      const trail = [...s.trail, s.active];
      s.openCircuit(id);
      set({ trail });
    },
    ascend(to) {
      const s = get();
      if (!s.trail.length) return;
      const i = to ?? s.trail.length - 1;
      const target = s.trail[i];
      const trail = s.trail.slice(0, i);
      s.openCircuit(target);
      set({ trail });
    },
    toggleFavorite(type) {
      const s = get();
      const favorites = s.favorites.includes(type) ? s.favorites.filter((t) => t !== type) : [...s.favorites, type];
      savePrefs(s.recents, favorites);
      set({ favorites });
    },
    setMenu(menu) {
      set({ menu });
    },
    setPlacing(placing) {
      set({ placing, pending: null });
    },
  };
});

/** Ask the canvas to frame the circuit after it renders. */
export function requestFit() {
  if (typeof window !== 'undefined' && typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => window.dispatchEvent(new Event('ihatecircuits:fit')));
}

export function newProjectAction() {
  useEditor.getState().load(newProject(), 'Started a new project. Undo brings the old one back.');
}

export { subType };

// Autosave: the project lives in this browser only; there is no account.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useEditor.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serialize(useEditor.getState().project));
    } catch {
      /* storage full or blocked: autosave is best-effort */
    }
  }, 400);
});
