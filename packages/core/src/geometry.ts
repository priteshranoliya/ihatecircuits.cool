import { getDef, pinsOf, type PinDef, type Side } from './library';
import type { Circuit, Component, Point, Rect, Rotation, Wire } from './types';
import { GRID } from './types';

export const snap = (v: number): number => Math.round(v / GRID) * GRID;

/** Size of the component after rotation. */
export function sizeOf(c: Pick<Component, 'type' | 'props' | 'rot'>): { w: number; h: number } {
  const s = getDef(c.type).size(c.props);
  return c.rot === 90 || c.rot === 270 ? { w: s.h, h: s.w } : s;
}

/** Map a point in the unrotated local frame (w × h) into the rotated local frame. Rotation is clockwise. */
export function rotatePoint(x: number, y: number, w: number, h: number, rot: Rotation): Point {
  switch (rot) {
    case 90:
      return { x: h - y, y: x };
    case 180:
      return { x: w - x, y: h - y };
    case 270:
      return { x: y, y: w - x };
    default:
      return { x, y };
  }
}

const SIDES: Side[] = ['r', 'b', 'l', 't'];
export function rotateSide(side: Side, rot: Rotation): Side {
  return SIDES[(SIDES.indexOf(side) + rot / 90) % 4];
}

/** SVG transform that draws an unrotated local-frame body in its rotated place. */
export function bodyTransform(c: Component): string {
  const { w, h } = getDef(c.type).size(c.props);
  const t = `translate(${c.x} ${c.y})`;
  switch (c.rot) {
    case 90:
      return `${t} translate(${h} 0) rotate(90)`;
    case 180:
      return `${t} translate(${w} ${h}) rotate(180)`;
    case 270:
      return `${t} translate(0 ${w}) rotate(270)`;
    default:
      return t;
  }
}

export interface PlacedPin extends PinDef {
  wx: number;
  wy: number;
  wside: Side;
}

/** Pins with world coordinates and world-facing side. */
export function placedPins(c: Component): PlacedPin[] {
  const { w, h } = getDef(c.type).size(c.props);
  return pinsOf(c).map((p) => placePin(c, p, w, h));
}

function placePin(c: Component, p: PinDef, w: number, h: number): PlacedPin {
  const r = rotatePoint(p.x, p.y, w, h, c.rot);
  return { ...p, wx: c.x + r.x, wy: c.y + r.y, wside: rotateSide(p.side, c.rot) };
}

export function pinPoint(c: Component, pin: string): PlacedPin | undefined {
  const p = pinsOf(c).find((x) => x.name === pin);
  if (!p) return undefined;
  const { w, h } = getDef(c.type).size(c.props);
  return placePin(c, p, w, h);
}

export function boundsOf(c: Component): Rect {
  const { w, h } = sizeOf(c);
  return { x: c.x, y: c.y, w, h };
}

/** Where a component's label is drawn: left of inputs, right of outputs, above everything else. */
export function labelPlacement(c: Component): { x: number; y: number; anchor: 'start' | 'middle' | 'end' } {
  const b = boundsOf(c);
  const def = getDef(c.type);
  if (def.source) return { x: b.x - 6, y: b.y + b.h / 2, anchor: 'end' };
  if (def.sink && c.type !== 'hex') return { x: b.x + b.w + 6, y: b.y + b.h / 2, anchor: 'start' };
  return { x: b.x + b.w / 2, y: b.y - 8, anchor: 'middle' };
}

export function labelBox(c: Component): Rect | null {
  if (!c.label) return null;
  const p = labelPlacement(c);
  const w = c.label.length * 7.5;
  const x = p.anchor === 'end' ? p.x - w : p.anchor === 'middle' ? p.x - w / 2 : p.x;
  return { x, y: p.y - 8, w, h: 16 };
}

export function circuitBounds(circuit: Circuit, pad = 20): Rect | null {
  const comps = Object.values(circuit.components);
  if (comps.length === 0) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of comps) {
    for (const b of [boundsOf(c), labelBox(c)]) {
      if (!b) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
  }
  for (const w of Object.values(circuit.wires)) {
    for (const p of wirePath(circuit, w) ?? []) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

const horizontal = (s: Side) => s === 'l' || s === 'r';
/** Outward direction of a pin along its axis: +1 for right/bottom, -1 for left/top. */
const outward = (s: Side) => (s === 'r' || s === 'b' ? 1 : -1);

export interface Route {
  points: Point[];
  /** Axis the adjustable leg moves along when dragged, or null for fixed L-shapes. */
  axis: 'x' | 'y' | null;
}

const STUB = 20;

/**
 * Orthogonal route from an output pin to an input pin.
 * - Facing pins with room between them: a Z with its middle leg at `mid`.
 * - Facing pins that overlap (feedback): leave each pin by a stub and cross at `mid`.
 * - Pins facing the same way: a U around the outermost pin.
 * - Perpendicular pins: an L.
 * Vertical pin pairs use the same rules with x and y swapped.
 */
export function routeBetween(a: { x: number; y: number; side: Side }, b: { x: number; y: number; side: Side }, mid?: number): Route {
  const ha = horizontal(a.side);
  if (ha !== horizontal(b.side)) {
    return { points: dedupe(ha ? [pt(a), { x: b.x, y: a.y }, pt(b)] : [pt(a), { x: a.x, y: b.y }, pt(b)]), axis: null };
  }
  // Work in a frame where the pins' axis is x; swap back at the end.
  const sw = (p: Point): Point => (ha ? { x: p.x, y: p.y } : { x: p.y, y: p.x });
  const A = sw(a);
  const B = sw(b);
  const da = outward(a.side);
  const db = outward(b.side);
  let pts: Point[];
  let axis: 'x' | 'y';
  if (da === db) {
    const m = mid ?? (da > 0 ? Math.max(A.x, B.x) + STUB : Math.min(A.x, B.x) - STUB);
    pts = [A, { x: m, y: A.y }, { x: m, y: B.y }, B];
    axis = 'x';
  } else if (da * (B.x - A.x) >= STUB || (A.y === B.y && da * (B.x - A.x) > 0)) {
    const m = mid ?? snap((A.x + B.x) / 2);
    pts = [A, { x: m, y: A.y }, { x: m, y: B.y }, B];
    axis = 'x';
  } else {
    const xa = A.x + da * STUB;
    const xb = B.x + db * STUB;
    const m = mid ?? snap((A.y + B.y) / 2);
    pts = [A, { x: xa, y: A.y }, { x: xa, y: m }, { x: xb, y: m }, { x: xb, y: B.y }, B];
    axis = 'y';
  }
  return { points: dedupe(pts.map(sw)), axis: ha ? axis : axis === 'x' ? 'y' : 'x' };
}

const pt = (p: Point): Point => ({ x: p.x, y: p.y });
function dedupe(ps: Point[]): Point[] {
  return ps.filter((p, i) => i === 0 || p.x !== ps[i - 1].x || p.y !== ps[i - 1].y);
}

function endPoint(circuit: Circuit, ref: { comp: string; pin: string }) {
  const c = circuit.components[ref.comp];
  return c ? pinPoint(c, ref.pin) : undefined;
}

export function wireRoute(circuit: Circuit, w: Wire): Route | null {
  const a = endPoint(circuit, w.from);
  const b = endPoint(circuit, w.to);
  if (!a || !b) return null;
  return routeBetween({ x: a.wx, y: a.wy, side: a.wside }, { x: b.wx, y: b.wy, side: b.wside }, w.mid);
}

export const wirePath = (circuit: Circuit, w: Wire): Point[] | null => wireRoute(circuit, w)?.points ?? null;

export const pathD = (ps: Point[]): string => ps.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
