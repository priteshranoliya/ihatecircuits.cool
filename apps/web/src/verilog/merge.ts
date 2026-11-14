/**
 * Adding the circuits a Verilog build produced to the project the student is working on.
 *
 * Decision: a build always adds a fresh, self-contained set of circuits. It never overwrites one.
 * Updating "the circuits from last time" in place would need a mark on each circuit saying where it came from,
 * which the project file cannot carry, and matching by name would overwrite a circuit the student drew
 * themselves. Adding is always safe and one undo removes the whole set. Each circuit gets a name that is
 * unique in the project ("half_adder", then "half_adder 2"), and the student can delete old copies from the
 * library. Within one build, every module and every support circuit (an 8-bit adder in the gates view, say)
 * is added once and shared by whatever uses it.
 */
import type { Circuit, Project } from '@ihatecircuits/core/types';
import { dependencies, subTarget, subType, uniqueName } from '@ihatecircuits/core/project';

export interface Added {
  project: Project;
  /** Id of the circuit made from the top module. */
  topId: string;
  circuits: number;
  parts: number;
}

/** `lowered` is what lowerToProject returned: the top is `lowered.main` and every id is local to it. */
export function addLowered(current: Project, lowered: Project): Added {
  const used = new Set(current.circuits.map((c) => c.id));
  let n = current.circuits.length + 1;
  const freshId = () => {
    while (used.has(`k${n}`)) n++;
    used.add(`k${n}`);
    return `k${n}`;
  };
  // The top goes first so it sits at the head of the new circuits in the library.
  const order = [...lowered.circuits].sort((a, b) => Number(b.id === lowered.main) - Number(a.id === lowered.main));
  const ids = new Map(order.map((c) => [c.id, freshId()]));

  const added: Circuit[] = [];
  for (const c of order) {
    const components = Object.fromEntries(
      Object.entries(c.components).map(([k, comp]) => {
        const target = subTarget(comp.type);
        const mapped = target === null ? undefined : ids.get(target);
        return [k, mapped ? { ...comp, type: subType(mapped) } : comp];
      }),
    );
    const name = uniqueName({ ...current, circuits: [...current.circuits, ...added] }, c.name);
    added.push({ ...c, id: ids.get(c.id)!, name, components });
  }
  return {
    project: { ...current, circuits: [...current.circuits, ...added] },
    topId: ids.get(lowered.main)!,
    circuits: added.length,
    parts: added.reduce((sum, c) => sum + Object.keys(c.components).length, 0),
  };
}

/**
 * The part of a project that "Load from circuit" turns into Verilog: the circuit being edited, as the top, and
 * the circuits it uses. Other circuits in the project (a half-drawn one with switches, say) do not get in the way.
 */
export function scopeTo(project: Project, activeId: string): Project {
  const keep = dependencies(project, activeId);
  keep.add(activeId);
  return { ...project, main: activeId, circuits: project.circuits.filter((c) => keep.has(c.id)) };
}
