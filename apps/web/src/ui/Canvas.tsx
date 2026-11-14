import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { bitAt, isKnown } from '@ihatecircuits/core/bits';
import { moveComponents, setWireMid } from '@ihatecircuits/core/edit';
import { boundsOf, labelBox, pathD, placedPins, rectsIntersect, wireRoute } from '@ihatecircuits/core/geometry';
import { findDef, getDef, sanitizeProps } from '@ihatecircuits/core/library';
import { keyboardType, type KeyboardState } from '@ihatecircuits/core/parts/ioextra';
import { formatPinValue, parsePinValue } from '@ihatecircuits/core/parts/wiring';
import { subTarget } from '@ihatecircuits/core/project';
import type { Circuit, Component, PinRef, Point, Rect, Wire } from '@ihatecircuits/core/types';
import { GRID } from '@ihatecircuits/core/types';
import { useEditor } from '../state/store';
import { bitClass, formatValue, PartView } from './parts';

/** Lets the sidebar, palette and toolbar talk to the canvas without prop drilling. */
export const canvasApi = {
  el: null as SVGSVGElement | null,
  clientToWorld(cx: number, cy: number): Point | null {
    const el = this.el;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const v = useEditor.getState().view;
    return { x: (cx - r.left - v.x) / v.zoom, y: (cy - r.top - v.y) / v.zoom };
  },
  /** Is the point over the canvas area (including overlays on it, like the welcome card)? */
  isOver(cx: number, cy: number): boolean {
    const hit = document.elementFromPoint(cx, cy);
    const area = this.el?.closest('.canvas-area');
    return !!hit && !!area?.contains(hit) && !hit.closest('.float');
  },
  size(): { w: number; h: number } {
    const r = this.el?.getBoundingClientRect();
    return { w: r?.width ?? 800, h: r?.height ?? 600 };
  },
  centerWorld(): Point {
    const { w, h } = this.size();
    const v = useEditor.getState().view;
    return { x: (w / 2 - v.x) / v.zoom, y: (h / 2 - v.y) / v.zoom };
  },
};

type Mode =
  | { kind: 'idle' }
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean; tapClears: boolean }
  | { kind: 'marquee'; start: Point; additive: boolean; base: string[] }
  | { kind: 'move'; start: Point; ids: string[]; before: Circuit; moved: boolean; poke?: string; pressed?: boolean; target?: Element | null }
  | { kind: 'wire'; from: PinRef; start: Point; moved: boolean }
  | { kind: 'bend'; id: string; axis: 'x' | 'y'; before: Circuit; start: Point; moved: boolean }
  | { kind: 'pinch'; dist: number; mid: Point; zoom: number; vx: number; vy: number };

const DRAG_THRESHOLD = 4;
const DOUBLE_CLICK_MS = 400;

function pinAt(target: EventTarget | null): PinRef | null {
  const el = (target as Element | null)?.closest?.('[data-pin]');
  if (!el) return null;
  const v = el.getAttribute('data-pin') ?? '';
  const i = v.indexOf(':');
  return { comp: v.slice(0, i), pin: v.slice(i + 1) };
}

const attr = (target: EventTarget | null, name: string) => (target as Element | null)?.closest?.(`[${name}]`)?.getAttribute(name) ?? null;

/** The keyboard part currently receiving typed characters. */
let keyboardTarget: string | null = null;

/** Interact with a part (flip a switch, toggle a bit…). Runs on release when the pointer did not move. */
function pokePart(comp: Component, target: Element | null, world: Point) {
  const st = useEditor.getState();
  switch (findDef(comp.type)?.shape) {
    case 'switch':
      return st.poke(comp.id, 'on', !comp.props.on);
    case 'clock':
      return st.step();
    case 'dip': {
      const bit = target?.closest('[data-dip-bit]')?.getAttribute('data-dip-bit');
      if (bit != null) st.poke(comp.id, 'value', Number(comp.props.value ?? 0) ^ (1 << Number(bit)));
      return;
    }
    case 'slider': {
      const max = 2 ** Number(comp.props.bits ?? 4) - 1;
      const b = boundsOf(comp);
      const frac = Math.min(1, Math.max(0, (world.x - b.x - 8) / Math.max(1, b.w - 26)));
      return st.poke(comp.id, 'value', Math.round(frac * max));
    }
    case 'keyboard':
      keyboardTarget = comp.id;
      return st.notify('Keyboard part listening: type to fill its buffer. Esc stops.');
    case 'pin': {
      if (comp.props.io === 'out') return;
      const width = Number(comp.props.bits ?? 1);
      const tri = comp.props.behavior === 'tristate';
      const bitAttr = target?.closest('[data-pin-bit]')?.getAttribute('data-pin-bit');
      const bit = bitAttr != null ? Number(bitAttr) : width === 1 ? 0 : null;
      if (bit === null) return;
      const v = parsePinValue(String(comp.props.value ?? '0'), width, tri);
      const s = bitAt(v, bit);
      // Tri-state pins cycle 0 → 1 → floating.
      const next = tri ? (s === 0 ? '1' : s === 1 ? 'z' : '0') : s === 1 ? '0' : '1';
      const chars = Array.from({ length: width }, (_, i) => {
        const x = bitAt(v, i);
        return i === bit ? next : x === 'z' ? 'z' : x === 1 ? '1' : '0';
      });
      st.poke(comp.id, 'value', formatPinValue(parsePinValue(chars.reverse().join(''), width, tri)));
    }
  }
}

// ---------------------------------------------------------------- wires

const WireView = memo(function WireView({ wire, from, to, selected, hot }: { wire: Wire; from: Component; to: Component; selected: boolean; hot: boolean }) {
  const key = useEditor((s) => {
    const v = s.sim.wire(wire.id);
    return v ? `${v.w}.${v.v}.${v.x}.${v.z}.${v.e}.${s.sim.wireWidthError(wire.id) ? 1 : 0}` : 'none';
  });
  const sim = useEditor.getState().sim;
  const value = key === 'none' ? null : sim.wire(wire.id);
  const widthError = sim.wireWidthError(wire.id);
  const route = useMemo(() => wireRoute({ components: { [from.id]: from, [to.id]: to } } as unknown as Circuit, wire), [wire, from, to]);
  if (!route) return null;
  const d = pathD(route.points);
  const cls = widthError ? 'werr' : value ? bitClass(value) : 'vx';
  const isBus = !!value && value.w > 1;
  let label: { x: number; y: number; text: string } | null = null;
  if (isBus && value && !widthError) {
    let best = 0;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1];
      const b = route.points[i];
      const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (len > best) {
        best = len;
        const allZ = value.z === (2 ** value.w - 1) >>> 0;
        label = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: isKnown(value) ? formatValue(value, 'hex') : value.e ? 'conflict' : allZ ? 'Z' : formatValue(value, 'bin') };
      }
    }
    if (best < 40) label = null;
  }
  return (
    <g data-wire={wire.id} className={`wire ${cls}${isBus ? ' bus' : ''}${hot ? ' net-hot' : ''}`}>
      <title>
        {widthError
          ? 'The ends of this wire have different bit widths, so it carries nothing.'
          : value
            ? `${formatValue(value, value.w > 1 ? 'hex' : 'bin')}${value.w > 1 ? ` · ${value.w} bits` : ''}`
            : ''}
      </title>
      {selected && <path className="wire-halo" d={d} data-export="skip" />}
      <path className="wire-line" d={d} />
      {label && (
        <g className="bus-label">
          <rect x={label.x - label.text.length * 3.2 - 5} y={label.y - 7.5} width={label.text.length * 6.4 + 10} height={15} rx={7.5} />
          <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="central">
            {label.text}
          </text>
        </g>
      )}
      <path className="wire-hit" d={d} data-export="skip" />
    </g>
  );
});

/** Grid points where three or more segments of one net meet get a dot. */
function junctions(c: Circuit, netOf: (w: Wire) => string): (Point & { wire: string })[] {
  const byNet = new Map<string, Wire[]>();
  for (const w of Object.values(c.wires)) {
    const k = netOf(w);
    byNet.set(k, [...(byNet.get(k) ?? []), w]);
  }
  const out: (Point & { wire: string })[] = [];
  for (const ws of byNet.values()) {
    if (ws.length < 2) continue;
    const edges = new Set<string>();
    for (const w of ws) {
      const pts = wireRoute(c, w)?.points ?? [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const n = Math.round(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / GRID);
        const sx = Math.sign(b.x - a.x) * GRID;
        const sy = Math.sign(b.y - a.y) * GRID;
        for (let k = 0; k < n; k++) {
          const p = { x: a.x + sx * k, y: a.y + sy * k };
          const q = { x: p.x + sx, y: p.y + sy };
          edges.add(p.x < q.x || p.y < q.y ? `${p.x},${p.y},${q.x},${q.y}` : `${q.x},${q.y},${p.x},${p.y}`);
        }
      }
    }
    const degree = new Map<string, number>();
    for (const e of edges) {
      const [x1, y1, x2, y2] = e.split(',');
      for (const k of [`${x1},${y1}`, `${x2},${y2}`]) degree.set(k, (degree.get(k) ?? 0) + 1);
    }
    for (const [k, deg] of degree) {
      if (deg < 3) continue;
      const [x, y] = k.split(',').map(Number);
      out.push({ x, y, wire: ws[0].id });
    }
  }
  return out;
}

const JunctionDots = memo(function JunctionDots({ circuit }: { circuit: Circuit }) {
  const sim = useEditor((s) => s.sim);
  useEditor((s) => s.simRev);
  const pts = useMemo(() => junctions(circuit, (w) => String(sim.netlist.wireNets.get(w.id)?.[0] ?? w.id)), [circuit.wires, circuit.components, sim]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <g className="junctions">
      {pts.map((p) => {
        const v = sim.wire(p.wire);
        return <circle key={`${p.wire}@${p.x},${p.y}`} className={`junction ${v ? bitClass(v) : 'vx'}${v && v.w > 1 ? ' bus' : ''}`} cx={p.x} cy={p.y} r={3.5} />;
      })}
    </g>
  );
});

// ---------------------------------------------------------------- overlays

const PinLayer = memo(function PinLayer({ circuit, pending }: { circuit: Circuit; pending: PinRef | null }) {
  const connected = useMemo(() => {
    const s = new Set<string>();
    for (const w of Object.values(circuit.wires)) {
      s.add(`${w.from.comp}:${w.from.pin}`);
      s.add(`${w.to.comp}:${w.to.pin}`);
    }
    return s;
  }, [circuit.wires]);
  return (
    <g className="pins" data-export="skip">
      {Object.values(circuit.components).flatMap((c) => {
        if (!findDef(c.type)) return [];
        const name = getDef(c.type).name;
        return placedPins(c).map((p) => {
          const key = `${c.id}:${p.name}`;
          const open = !connected.has(key) && c.type !== 'tunnel';
          const isPending = pending?.comp === c.id && pending.pin === p.name;
          const width = p.width || 'any';
          const dir = p.dir === 'in' ? 'input' : p.dir === 'out' ? 'output' : 'in/out';
          return (
            <g key={key} data-pin={key} className={`pin${open ? ' open' : ''}${isPending ? ' pending' : ''}`}>
              <title>{`${name}${c.label ? ` ${c.label}` : ''} · ${p.label || p.name} · ${dir} · ${width} bit${width === 1 ? '' : 's'}`}</title>
              <circle className="pin-hit" cx={p.wx} cy={p.wy} r={7} />
              <circle className="pin-dot" cx={p.wx} cy={p.wy} r={open ? 2.6 : 2} />
            </g>
          );
        });
      })}
    </g>
  );
});

function SelectionLayer({ circuit, selection, hot }: { circuit: Circuit; selection: string[]; hot: Set<string> }) {
  const box = (id: string, cls: string, pad: number) => {
    const c = circuit.components[id];
    if (!c || !findDef(c.type)) return null;
    const b = boundsOf(c);
    return <rect key={`${cls}-${id}`} className={cls} x={b.x - pad} y={b.y - pad} width={b.w + 2 * pad} height={b.h + 2 * pad} rx={4} />;
  };
  return (
    <g className="selection" data-export="skip">
      {[...hot].map((id) => box(id, 'hot-box', 5))}
      {selection.map((id) => box(id, 'sel-box', 4))}
    </g>
  );
}

// ---------------------------------------------------------------- canvas

export function Canvas() {
  const circuit = useEditor((s) => s.circuit());
  const view = useEditor((s) => s.view);
  const selection = useEditor((s) => s.selection);
  const pending = useEditor((s) => s.pending);
  const placing = useEditor((s) => s.placing);
  const hot = useEditor((s) => s.sim.hot);
  useEditor((s) => s.simRev);
  const svgRef = useRef<SVGSVGElement>(null);
  const mode = useRef<Mode>({ kind: 'idle' });
  const pointers = useRef(new Map<number, Point>());
  const [hover, setHover] = useState<Point | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [wireDrag, setWireDrag] = useState<{ from: Point; to: Point } | null>(null);
  const [panning, setPanning] = useState(false);
  const spaceDown = useRef(false);
  const lastDown = useRef<{ id: string; t: number } | null>(null);
  const tool = useEditor((s) => s.tool);
  const [hotNet, setHotNet] = useState<string | null>(null);
  const netKeyOf = (wireId: string) => {
    const n = useEditor.getState().sim.netlist.wireNets.get(wireId);
    return n && n.length ? String(n[0]) : wireId;
  };

  useEffect(() => {
    canvasApi.el = svgRef.current;
    return () => {
      canvasApi.el = null;
    };
  }, []);

  // Space-drag pans; typing goes to a listening keyboard part.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input,textarea,select,[contenteditable]');
      if (keyboardTarget && !typing && !e.metaKey && !e.ctrlKey) {
        const st = useEditor.getState();
        const comp = st.circuit().components[keyboardTarget];
        if (!comp || e.key === 'Escape') {
          keyboardTarget = null;
        } else {
          const ch = e.key === 'Enter' ? '\n' : e.key === 'Backspace' ? '\b' : e.key.length === 1 ? e.key : null;
          if (ch) {
            e.preventDefault();
            e.stopImmediatePropagation();
            st.setPartState(comp.id, keyboardType(st.sim.stateOf(comp.id) as KeyboardState, ch, Number(comp.props.length ?? 32)));
            return;
          }
        }
      }
      if (e.code === 'Space' && !typing && !(e.target as HTMLElement).closest('button')) {
        spaceDown.current = true;
        setPanning(true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown.current = false;
        setPanning(false);
      }
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => {
    const el = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const st = useEditor.getState();
      if (e.ctrlKey || e.metaKey) st.zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX - r.left, e.clientY - r.top);
      else {
        const k = e.deltaMode === 1 ? 16 : 1;
        st.setView({ x: st.view.x - e.deltaX * k - (e.shiftKey ? e.deltaY * k : 0), y: st.view.y - (e.shiftKey ? 0 : e.deltaY * k) });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const toWorld = useCallback((e: { clientX: number; clientY: number }): Point => canvasApi.clientToWorld(e.clientX, e.clientY)!, []);

  /** Two presses on the same target within the double-click window. */
  const isDouble = (id: string) => {
    const now = performance.now();
    const last = lastDown.current;
    lastDown.current = { id, t: now };
    if (last && last.id === id && now - last.t < DOUBLE_CLICK_MS) {
      lastDown.current = null;
      return true;
    }
    return false;
  };

  const onPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    const st = useEditor.getState();
    const now = st.circuit();
    const p = toWorld(e);
    // Right-clicks go to the context menu; capturing them would retarget it to the canvas.
    if (e.button === 2) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    svgRef.current!.setPointerCapture(e.pointerId);
    svgRef.current!.focus({ preventScroll: true });

    if (pointers.current.size === 2) {
      const m = mode.current;
      if (m.kind === 'move' && m.moved) st.preview(m.before);
      if (m.kind === 'move' && m.pressed && m.poke) st.poke(m.poke, 'on', false);
      const [a, b] = [...pointers.current.values()];
      const r = svgRef.current!.getBoundingClientRect();
      mode.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }, zoom: st.view.zoom, vx: st.view.x, vy: st.view.y };
      setMarquee(null);
      setWireDrag(null);
      return;
    }
    if (pointers.current.size > 2) return;

    if (e.button === 1 || (e.button === 0 && (spaceDown.current || st.tool === 'hand'))) {
      mode.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: false, tapClears: false };
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;

    if (st.placing) {
      st.place(st.placing, p.x, p.y);
      mode.current = { kind: 'idle' };
      return;
    }
    if (st.tool === 'text' && !attr(e.target, 'data-comp')) {
      st.place('text', p.x, p.y);
      st.setTool('select');
      mode.current = { kind: 'idle' };
      return;
    }

    const pin = pinAt(e.target);
    if (pin) {
      if (st.pending) {
        if (st.pending.comp === pin.comp && st.pending.pin === pin.pin) st.setPending(null);
        else st.wire(st.pending, pin);
        mode.current = { kind: 'idle' };
        return;
      }
      mode.current = { kind: 'wire', from: pin, start: p, moved: false };
      return;
    }
    if (st.pending) st.setPending(null);

    const wireId = attr(e.target, 'data-wire');
    if (wireId) {
      // Pointer capture retargets dblclick to the canvas, so double-clicks are detected here.
      if (isDouble(wireId) && !e.shiftKey) {
        if (now.wires[wireId]?.mid !== undefined) st.commit(setWireMid(now, wireId, undefined));
        mode.current = { kind: 'idle' };
        return;
      }
      st.setSelection(e.shiftKey ? toggle(st.selection, wireId) : [wireId]);
      const r = wireRoute(now, now.wires[wireId]);
      mode.current = r?.axis && !e.shiftKey ? { kind: 'bend', id: wireId, axis: r.axis, before: now, start: p, moved: false } : { kind: 'idle' };
      return;
    }

    const compId = attr(e.target, 'data-comp');
    if (compId && now.components[compId]) {
      const comp = now.components[compId];
      if (isDouble(compId) && !e.shiftKey) {
        const target = subTarget(comp.type);
        if (target) {
          st.enterCircuit(target);
          mode.current = { kind: 'idle' };
          return;
        }
        if (comp.type === 'ram' || comp.type === 'rom') {
          st.setDialog('memory', compId);
          mode.current = { kind: 'idle' };
          return;
        }
      }
      let sel = st.selection;
      if (e.shiftKey) sel = toggle(sel, compId);
      else if (!sel.includes(compId)) sel = [compId];
      st.setSelection(sel);
      const poke = e.shiftKey ? undefined : (attr(e.target, 'data-poke') ?? undefined);
      let pressed = false;
      if (poke && comp.type === 'button') {
        st.poke(poke, 'on', true);
        pressed = true;
      }
      mode.current = { kind: 'move', start: p, ids: sel.filter((id) => now.components[id]), before: now, moved: false, poke, pressed, target: e.target as Element };
      return;
    }

    if (e.pointerType === 'touch') {
      mode.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: false, tapClears: true };
      return;
    }
    if (!e.shiftKey) st.setSelection([]);
    mode.current = { kind: 'marquee', start: p, additive: e.shiftKey, base: e.shiftKey ? st.selection : [] };
  };

  const onPointerMove = (e: RPointerEvent<SVGSVGElement>) => {
    const st = useEditor.getState();
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = mode.current;
    const p = toWorld(e);
    if ((st.placing || st.pending) && m.kind === 'idle') setHover(p);
    const far = (start: Point) => Math.hypot(p.x - start.x, p.y - start.y) * st.view.zoom >= DRAG_THRESHOLD;
    switch (m.kind) {
      case 'pinch': {
        const [a, b] = [...pointers.current.values()];
        if (!a || !b) return;
        const r = svgRef.current!.getBoundingClientRect();
        const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
        const zoom = Math.min(4, Math.max(0.2, (m.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / m.dist));
        const k = zoom / m.zoom;
        st.setView({ zoom, x: mid.x - (m.mid.x - m.vx) * k, y: mid.y - (m.mid.y - m.vy) * k });
        return;
      }
      case 'pan': {
        const dx = e.clientX - m.sx;
        const dy = e.clientY - m.sy;
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD) m.moved = true;
        st.setView({ x: m.vx + dx, y: m.vy + dy });
        return;
      }
      case 'marquee': {
        const r = normRect(m.start, p);
        setMarquee(r);
        const inside = itemsIn(st.circuit(), r);
        st.setSelection(m.additive ? [...new Set([...m.base, ...inside])] : inside);
        return;
      }
      case 'move': {
        if (!m.moved && !far(m.start)) return;
        if (!m.moved && m.pressed && m.poke) {
          st.poke(m.poke, 'on', false);
          m.pressed = false;
        }
        m.moved = true;
        st.preview(moveComponents(m.before, m.ids, Math.round((p.x - m.start.x) / GRID) * GRID, Math.round((p.y - m.start.y) / GRID) * GRID));
        return;
      }
      case 'wire': {
        if (!m.moved && !far(m.start)) return;
        m.moved = true;
        const from = pinWorldOf(st.circuit(), m.from);
        const target = pinAt(document.elementFromPoint(e.clientX, e.clientY));
        const to = (target && pinWorldOf(st.circuit(), target)) || p;
        if (from) setWireDrag({ from, to });
        return;
      }
      case 'bend': {
        if (!m.moved && !far(m.start)) return;
        m.moved = true;
        st.preview(setWireMid(m.before, m.id, m.axis === 'x' ? p.x : p.y));
        return;
      }
    }
  };

  const finish = (e: RPointerEvent<SVGSVGElement>, cancelled: boolean) => {
    const st = useEditor.getState();
    pointers.current.delete(e.pointerId);
    const m = mode.current;
    if (m.kind === 'pinch') {
      if (pointers.current.size === 0) mode.current = { kind: 'idle' };
      return;
    }
    mode.current = { kind: 'idle' };
    switch (m.kind) {
      case 'pan':
        setPanning(spaceDown.current);
        if (!m.moved && m.tapClears) st.setSelection([]);
        return;
      case 'marquee':
        setMarquee(null);
        return;
      case 'move':
        if (m.moved) {
          if (cancelled) st.preview(m.before);
          else st.commitFrom(m.before);
        } else if (m.poke && !cancelled) {
          const comp = st.circuit().components[m.poke];
          if (m.pressed) st.poke(m.poke, 'on', false);
          else if (comp) pokePart(comp, m.target ?? null, toWorld(e));
        }
        return;
      case 'wire': {
        setWireDrag(null);
        if (cancelled) return;
        if (!m.moved) {
          st.setPending(m.from);
          setHover(toWorld(e));
          return;
        }
        const target = pinAt(document.elementFromPoint(e.clientX, e.clientY));
        if (target && !(target.comp === m.from.comp && target.pin === m.from.pin)) st.wire(m.from, target);
        return;
      }
      case 'bend':
        if (m.moved) {
          if (cancelled) st.preview(m.before);
          else st.commitFrom(m.before);
        }
        return;
    }
  };

  const wires = Object.values(circuit.wires);
  const comps = Object.values(circuit.components);
  const selSet = useMemo(() => new Set(selection), [selection]);
  const pendingPoint = pending ? pinWorldOf(circuit, pending) : null;
  const ghost = useMemo<Component | null>(() => {
    if (!placing || !hover) return null;
    const def = findDef(placing);
    if (!def) return null;
    const props = def.subcircuit ? {} : sanitizeProps(placing);
    const { w, h } = def.size(props);
    return { id: 'ghost', type: placing, rot: 0, label: '', props, x: Math.round((hover.x - w / 2) / GRID) * GRID, y: Math.round((hover.y - h / 2) / GRID) * GRID };
  }, [placing, hover]);

  const g = GRID * view.zoom;
  const cursor = panning ? 'grabbing' : tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : placing ? 'copy' : pending ? 'crosshair' : undefined;

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        className="canvas"
        data-testid="canvas"
        tabIndex={0}
        role="application"
        aria-label="Circuit canvas. Drag parts here from the sidebar; drag between pins to wire them."
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onPointerLeave={() => mode.current.kind === 'idle' && setHover(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          const st = useEditor.getState();
          const target = attr(e.target, 'data-comp') ?? attr(e.target, 'data-wire');
          if (target && !st.selection.includes(target)) st.setSelection([target]);
          st.setMenu({ x: e.clientX, y: e.clientY, target });
        }}
        onPointerOver={(e) => {
          const w = attr(e.target, 'data-wire');
          setHotNet(w ? netKeyOf(w) : null);
        }}
      >
        <defs>
          <pattern id="grid-minor" width={g} height={g} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={1} cy={1} r={0.9} className="grid-dot" />
          </pattern>
          <pattern id="grid-major" width={g * 5} height={g * 5} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={1.3} cy={1.3} r={1.3} className="grid-dot major" />
          </pattern>
        </defs>
        {view.zoom >= 0.5 && <rect width="100%" height="100%" fill="url(#grid-minor)" pointerEvents="none" transform="translate(-1 -1)" />}
        <rect width="100%" height="100%" fill="url(#grid-major)" pointerEvents="none" transform="translate(-1.3 -1.3)" />
        <g id="world" transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          <g className="wires">
            {wires.map((w) => {
              const from = circuit.components[w.from.comp];
              const to = circuit.components[w.to.comp];
              return from && to && findDef(from.type) && findDef(to.type) ? (
                <WireView key={w.id} wire={w} from={from} to={to} selected={selSet.has(w.id)} hot={hotNet !== null && netKeyOf(w.id) === hotNet} />
              ) : null;
            })}
            <JunctionDots circuit={circuit} />
          </g>
          <SelectionLayer circuit={circuit} selection={selection} hot={hot} />
          <g className="parts">
            {comps.map((c) => (
              <PartView key={c.id} comp={c} />
            ))}
          </g>
          <PinLayer circuit={circuit} pending={pending} />
          <g className="overlay" data-export="skip" pointerEvents="none">
            {wireDrag && <path className="wire-preview" d={`M${wireDrag.from.x} ${wireDrag.from.y} L${wireDrag.to.x} ${wireDrag.to.y}`} />}
            {pendingPoint && hover && <path className="wire-preview" d={`M${pendingPoint.x} ${pendingPoint.y} L${hover.x} ${hover.y}`} />}
            {pendingPoint && <circle className="pending-ring" cx={pendingPoint.x} cy={pendingPoint.y} r={7} />}
            {marquee && <rect className="marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />}
            {ghost && (
              <g className="ghost">
                <PartView comp={ghost} ghost />
              </g>
            )}
          </g>
        </g>
      </svg>
    </div>
  );
}

function pinWorldOf(c: Circuit, ref: PinRef): Point | null {
  const comp = c.components[ref.comp];
  const p = comp && findDef(comp.type) && placedPins(comp).find((x) => x.name === ref.pin);
  return p ? { x: p.wx, y: p.wy } : null;
}

const toggle = (sel: string[], id: string) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);

function normRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function itemsIn(c: Circuit, r: Rect): string[] {
  const comps = Object.values(c.components).filter((x) => findDef(x.type) && (rectsIntersect(boundsOf(x), r) || (labelBox(x) && rectsIntersect(labelBox(x)!, r))));
  const ids = new Set(comps.map((x) => x.id));
  const wires = Object.values(c.wires).filter((w) => {
    if (ids.has(w.from.comp) && ids.has(w.to.comp)) return true;
    const pts = wireRoute(c, w)?.points ?? [];
    return pts.some((p, i) => i > 0 && rectsIntersect(normRect(pts[i - 1], { x: p.x + 0.01, y: p.y + 0.01 }), r));
  });
  return [...ids, ...wires.map((w) => w.id)];
}
