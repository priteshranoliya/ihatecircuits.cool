import { emptyCircuit } from './edit';
import { getDef, setDynamicResolver, type ComponentDef, type PinDef } from './library';
import { portNames } from './netlist';
import type { Circuit, Component, Project } from './types';

/**
 * Projects hold several circuits. Any circuit can be placed inside another as
 * a subcircuit: its Pin parts become the box's connections (inputs on the
 * left, outputs on the right, ordered top to bottom as drawn).
 */

export const SUB_PREFIX = 'sub:';
export const subType = (circuitId: string) => `${SUB_PREFIX}${circuitId}`;
export const subTarget = (type: string) => (type.startsWith(SUB_PREFIX) ? type.slice(SUB_PREFIX.length) : null);

export const newProject = (name = 'Untitled project'): Project => ({ name, main: 'main', circuits: [emptyCircuit('Main', 'main')] });

export const circuitById = (p: Project, id: string) => p.circuits.find((c) => c.id === id);

export function replaceCircuit(p: Project, c: Circuit): Project {
  return { ...p, circuits: p.circuits.map((x) => (x.id === c.id ? c : x)) };
}

export function addCircuit(p: Project, name: string): { project: Project; id: string } {
  let n = p.circuits.length + 1;
  while (p.circuits.some((c) => c.id === `k${n}`)) n++;
  const id = `k${n}`;
  return { project: { ...p, circuits: [...p.circuits, emptyCircuit(uniqueName(p, name), id)] }, id };
}

export function uniqueName(p: Project, name: string, except?: string): string {
  const base = name.trim() || 'Circuit';
  const taken = new Set(p.circuits.filter((c) => c.id !== except).map((c) => c.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export function renameCircuit(p: Project, id: string, name: string): Project {
  return { ...p, circuits: p.circuits.map((c) => (c.id === id ? { ...c, name: uniqueName(p, name, id) } : c)) };
}

/** Remove a circuit and every instance of it elsewhere. The main circuit cannot be removed. */
export function removeCircuit(p: Project, id: string): Project {
  if (id === p.main || p.circuits.length < 2) return p;
  const type = subType(id);
  const circuits = p.circuits
    .filter((c) => c.id !== id)
    .map((c) => {
      const gone = Object.values(c.components).filter((x) => x.type === type).map((x) => x.id);
      if (!gone.length) return c;
      const set = new Set(gone);
      const components = Object.fromEntries(Object.entries(c.components).filter(([k]) => !set.has(k)));
      const wires = Object.fromEntries(Object.entries(c.wires).filter(([, w]) => !set.has(w.from.comp) && !set.has(w.to.comp)));
      return { ...c, components, wires };
    });
  return { ...p, circuits };
}

/** Circuits that `id` uses, directly or indirectly. */
export function dependencies(p: Project, id: string, seen = new Set<string>()): Set<string> {
  const c = circuitById(p, id);
  if (!c) return seen;
  for (const comp of Object.values(c.components)) {
    const t = subTarget(comp.type);
    if (t && !seen.has(t)) {
      seen.add(t);
      dependencies(p, t, seen);
    }
  }
  return seen;
}

/** Placing `child` inside `parent` is allowed only if it would not make a circuit contain itself. */
export const canNest = (p: Project, parent: string, child: string) => parent !== child && !dependencies(p, child).has(parent);

// ---------------------------------------------------------------- subcircuit definitions

const defCache = new WeakMap<Circuit, ComponentDef>();

/** The ports of a circuit: its Pin parts, inputs then outputs, each ordered top to bottom. */
export function portsOf(c: Circuit): { inputs: Component[]; outputs: Component[] } {
  const pins = Object.values(c.components).filter((x) => x.type === 'pin');
  const order = (a: Component, b: Component) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1);
  return { inputs: pins.filter((x) => x.props.io !== 'out').sort(order), outputs: pins.filter((x) => x.props.io === 'out').sort(order) };
}

/** Build (and cache per circuit version) the component definition for using `c` as a subcircuit. */
export function subcircuitDef(c: Circuit): ComponentDef {
  const cached = defCache.get(c);
  if (cached) return cached;
  const { inputs, outputs } = portsOf(c);
  const names = portNames(c);
  const portName = (x: Component) => names.get(x.id)!;
  const rows = Math.max(inputs.length, outputs.length, 1);
  const longest = Math.max(4, ...[...inputs, ...outputs].map((x) => portName(x).length));
  const w = Math.max(60, Math.ceil((longest * 2 * 6.5 + 30) / 10) * 10);
  const h = 20 * rows + 20;
  const pins: PinDef[] = [
    ...inputs.map((x, i): PinDef => ({ name: portName(x), label: portName(x), dir: 'in', x: 0, y: 30 + 20 * i, side: 'l', width: Number(x.props.bits ?? 1) })),
    ...outputs.map((x, i): PinDef => ({ name: portName(x), label: portName(x), dir: 'out', x: w, y: 30 + 20 * i, side: 'r', width: Number(x.props.bits ?? 1) })),
  ];
  const def: ComponentDef = {
    type: subType(c.id),
    name: c.name,
    category: 'Circuits',
    description: `Your circuit “${c.name}”, used as a part. Its pins become the connections on this box.`,
    props: [],
    subcircuit: true,
    title: () => c.name,
    size: () => ({ w, h }),
    pins: () => pins,
    eval: () => ({ out: {} }),
  };
  defCache.set(c, def);
  return def;
}

/** Make `sub:<id>` types resolvable for the given project (call whenever the project changes). */
export function useProject(p: Project) {
  setDynamicResolver((type) => {
    const id = subTarget(type);
    const c = id ? circuitById(p, id) : undefined;
    return c ? subcircuitDef(c) : undefined;
  });
}

/** Lookup used by the simulator to flatten subcircuits. */
export const lookupIn = (p: Project) => (type: string) => {
  const id = subTarget(type);
  return id ? circuitById(p, id) : undefined;
};

/** Whether a component type exists right now (built-in or a circuit of this project). */
export function typeExists(p: Project, type: string): boolean {
  const id = subTarget(type);
  if (id) return !!circuitById(p, id);
  try {
    getDef(type);
    return true;
  } catch {
    return false;
  }
}
