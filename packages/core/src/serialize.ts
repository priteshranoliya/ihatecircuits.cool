import { findDef, pinsOf, sanitizeProps, type PinDef } from './library';
import { canNest, subTarget, subcircuitDef } from './project';
import type { Circuit, Component, Project, Rotation, Wire } from './types';

export const FORMAT = 'ihatecircuits-project';
export const FORMAT_VERSION = 2;
/** The single-circuit format written by version 1. Still readable. */
const LEGACY_FORMAT = 'ihatecircuits-circuit';
/** Format ids written before the project was renamed, mapped to their current ids. */
const RENAMED_FORMATS: Record<string, string> = { 'gatewright-project': FORMAT, 'gatewright-circuit': LEGACY_FORMAT };

export interface CircuitFile {
  format: typeof FORMAT;
  version: number;
  name: string;
  main: string;
  circuits: { id: string; name: string; components: Component[]; wires: Wire[] }[];
}

const byNum = (a: { id: string }, b: { id: string }) => Number(a.id.slice(1)) - Number(b.id.slice(1)) || (a.id < b.id ? -1 : 1);

export function toFile(p: Project): CircuitFile {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    name: p.name,
    main: p.main,
    circuits: p.circuits.map((c) => ({
      id: c.id,
      name: c.name,
      components: Object.values(c.components).sort(byNum),
      wires: Object.values(c.wires).sort(byNum),
    })),
  };
}

export const serialize = (p: Project): string => JSON.stringify(toFile(p), null, 2);

export class CircuitFileError extends Error {}

const ROTATIONS = new Set([0, 90, 180, 270]);
const ID = /^[cw]\d{1,9}$/;
const CIRCUIT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
/** Far beyond any real circuit, small enough for SVG coordinates to stay precise. */
const MAX_COORD = 1_000_000;

export interface ParseResult {
  project: Project;
  /** Things that were repaired while loading (old files), in plain words. */
  warnings: string[];
}

/** Version-1 parts whose pins changed in version 2. */
const LEGACY_TYPES: Record<string, { type: string; props?: Record<string, unknown>; pins?: Record<string, string> }> = {
  output: { type: 'pin', props: { io: 'out' }, pins: { in: 'p' } },
};

/**
 * Parse and validate a project file (or a version-1 single-circuit file).
 * Throws CircuitFileError with a message a person can act on.
 */
export function parseProject(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CircuitFileError('This file is not valid JSON.');
  }
  const f = raw as Record<string, unknown> | null;
  if (!f || typeof f !== 'object') throw new CircuitFileError('This is not an iHateCircuits file.');
  if (typeof f.format === 'string' && Object.hasOwn(RENAMED_FORMATS, f.format)) f.format = RENAMED_FORMATS[f.format];
  const warnings: string[] = [];

  let rawCircuits: { id: unknown; name: unknown; components: unknown; wires: unknown }[];
  let main: string;
  let legacy = false;
  if (f.format === LEGACY_FORMAT) {
    legacy = true;
    rawCircuits = [{ id: 'main', name: f.name ?? 'Main', components: f.components, wires: f.wires }];
    main = 'main';
  } else if (f.format === FORMAT) {
    if (typeof f.version !== 'number' || !Number.isInteger(f.version) || f.version < 1) throw new CircuitFileError('This file has an invalid format version.');
    if (f.version > FORMAT_VERSION) throw new CircuitFileError(`This file was saved by a newer version (format ${f.version}). Update iHateCircuits to open it.`);
    if (!Array.isArray(f.circuits) || f.circuits.length === 0) throw new CircuitFileError('The file has no circuits.');
    rawCircuits = f.circuits as typeof rawCircuits;
    main = String(f.main ?? '');
  } else throw new CircuitFileError('This is not an iHateCircuits file (missing "format").');

  const ids = new Set<string>();
  for (const rc of rawCircuits) {
    if (!rc || typeof rc.id !== 'string' || !CIRCUIT_ID.test(rc.id)) throw new CircuitFileError('A circuit in the file has an invalid id.');
    if (ids.has(rc.id)) throw new CircuitFileError(`Circuit id “${rc.id}” is used twice.`);
    ids.add(rc.id);
  }
  if (!ids.has(main)) main = rawCircuits[0].id as string;

  // Components first (all circuits), so subcircuit pins can be resolved for wires.
  const parsed = rawCircuits.map((rc) => {
    const name = typeof rc.name === 'string' && rc.name.trim() ? rc.name.slice(0, 80) : 'Circuit';
    if (!Array.isArray(rc.components) || !Array.isArray(rc.wires)) throw new CircuitFileError(`Circuit “${name}” has no component or wire list.`);
    const components: Record<string, Component> = {};
    let maxId = 0;
    const pinRename = new Map<string, Record<string, string>>();
    (rc.components as Partial<Component>[]).forEach((x, i) => {
      const where = `In “${name}”, component ${i + 1}`;
      if (!x || typeof x.id !== 'string' || !ID.test(x.id) || x.id[0] !== 'c') throw new CircuitFileError(`${where} has an invalid id.`);
      if (components[x.id]) throw new CircuitFileError(`${where} reuses id ${x.id}.`);
      let type = typeof x.type === 'string' ? x.type : '';
      let props = (x.props ?? {}) as Record<string, unknown>;
      const mig = legacy ? LEGACY_TYPES[type] : undefined;
      if (mig) {
        type = mig.type;
        props = { ...props, ...mig.props };
        if (mig.pins) pinRename.set(x.id, mig.pins);
      }
      const target = subTarget(type);
      if (target ? !ids.has(target) : !findDef(type)) throw new CircuitFileError(`${where} has unknown type “${type}”.`);
      if (!Number.isFinite(x.x) || !Number.isFinite(x.y)) throw new CircuitFileError(`${where} has no position.`);
      if (Math.abs(x.x!) > MAX_COORD || Math.abs(x.y!) > MAX_COORD) throw new CircuitFileError(`${where} is placed too far from the origin.`);
      const rot = (x.rot ?? 0) as Rotation;
      if (!ROTATIONS.has(rot)) throw new CircuitFileError(`${where} has an invalid rotation.`);
      components[x.id] = {
        id: x.id,
        type,
        x: Math.round(x.x! / 10) * 10,
        y: Math.round(x.y! / 10) * 10,
        rot,
        label: typeof x.label === 'string' ? x.label.slice(0, 40) : '',
        props: target ? {} : sanitizeProps(type, props),
      };
      maxId = Math.max(maxId, Number(x.id.slice(1)));
    });
    return { id: rc.id as string, name, components, rawWires: rc.wires as Partial<Wire>[], maxId, pinRename };
  });

  const circuits: Circuit[] = parsed.map((pc) => ({ id: pc.id, name: pc.name, nextId: 0, components: pc.components, wires: {} }));
  const pinsFor = (c: Component): PinDef[] => {
    const target = subTarget(c.type);
    if (!target) return pinsOf(c);
    return subcircuitDef(circuits.find((x) => x.id === target)!).pins({});
  };

  let dropped = 0;
  const result: Circuit[] = parsed.map((pc, ci) => {
    const wires: Record<string, Wire> = {};
    let maxId = pc.maxId;
    pc.rawWires.forEach((rw, i) => {
      const where = `In “${pc.name}”, wire ${i + 1}`;
      if (!rw || typeof rw.id !== 'string' || !ID.test(rw.id) || rw.id[0] !== 'w') throw new CircuitFileError(`${where} has an invalid id.`);
      if (wires[rw.id]) throw new CircuitFileError(`${where} reuses id ${rw.id}.`);
      const ends = [rw.from, rw.to].map((end) => {
        if (!end || typeof end.comp !== 'string' || typeof end.pin !== 'string') return null;
        // Own keys only: a crafted "__proto__" or "toString" must not resolve to a built-in.
        const comp = Object.hasOwn(pc.components, end.comp) ? pc.components[end.comp] : undefined;
        if (!comp) return null;
        const pin = pc.pinRename.get(end.comp)?.[end.pin] ?? end.pin;
        return pinsFor(comp).some((p) => p.name === pin) ? { comp: end.comp, pin } : null;
      });
      if (!ends[0] || !ends[1]) {
        const exists = (e: unknown) => !!e && typeof (e as { comp?: unknown }).comp === 'string' && Object.hasOwn(pc.components, (e as { comp: string }).comp);
        if (!legacy && !(exists(rw.from) && exists(rw.to))) throw new CircuitFileError(`${where} connects to a part that does not exist.`);
        // A pin that no longer exists (older file, or a subcircuit whose pins changed): drop the wire.
        dropped++;
        return;
      }
      const w: Wire = { id: rw.id, from: ends[0], to: ends[1] };
      wires[rw.id] = Number.isFinite(rw.mid) && Math.abs(rw.mid!) <= MAX_COORD ? { ...w, mid: Math.round(rw.mid! / 10) * 10 } : w;
      maxId = Math.max(maxId, Number(rw.id.slice(1)));
    });
    return { ...circuits[ci], wires, nextId: maxId + 1 };
  });
  if (dropped) warnings.push(`${dropped} wire${dropped === 1 ? '' : 's'} pointed at pins that no longer exist and were removed.`);

  const project: Project = { name: typeof f.name === 'string' && f.name.trim() ? f.name.slice(0, 80) : 'Untitled project', main, circuits: result };
  for (const c of result)
    for (const comp of Object.values(c.components)) {
      const t = subTarget(comp.type);
      if (t && !canNest(project, c.id, t)) throw new CircuitFileError(`Circuit “${c.name}” contains itself, directly or through other circuits.`);
    }
  return { project, warnings };
}
