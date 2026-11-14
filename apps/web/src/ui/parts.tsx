import { memo, type ReactNode } from 'react';
import { type Bits, bitAt, formatBits, isKnown, toSigned } from '@ihatecircuits/core/bits';
import { bodyTransform, labelPlacement, rotatePoint } from '@ihatecircuits/core/geometry';
import { findDef, getDef, pinsOf, type PinDef } from '@ihatecircuits/core/library';
import { negatedInputs } from '@ihatecircuits/core/parts/gates';
import { SEGMENT_NAMES, lit } from '@ihatecircuits/core/parts/io';
import { matrixPixels, MATRIX_CELL, type KeyboardState, type TtyState } from '@ihatecircuits/core/parts/ioextra';
import type { Simulator } from '@ihatecircuits/core/sim';
import type { Component, Props } from '@ihatecircuits/core/types';
import { useEditor } from '../state/store';

/** CSS class for a single-bit value. */
export function bitClass(b: Bits | undefined): string {
  if (!b) return 'vx';
  if (b.w > 1) return b.e ? 've' : b.z === (2 ** b.w - 1) >>> 0 ? 'vz' : 'vbus';
  const s = bitAt(b, 0);
  return s === 1 ? 'v1' : s === 0 ? 'v0' : s === 'z' ? 'vz' : s === 'e' ? 've' : 'vx';
}

export function formatValue(b: Bits, radix: unknown): string {
  if (!isKnown(b)) return formatBits(b, 'bin');
  if (radix === 'hex') return '0x' + formatBits(b, 'hex');
  if (radix === 'dec') return formatBits(b, 'dec');
  if (radix === 'signed') return String(toSigned(b));
  return formatBits(b, 'bin');
}

interface Txt {
  x: number;
  y: number;
  text: string;
  anchor?: 'start' | 'middle' | 'end';
  cls: string;
}

interface Ctx {
  comp: Component;
  props: Props;
  W: number;
  H: number;
  pins: PinDef[];
  read: (pin: string) => Bits | undefined;
  state: unknown;
  texts: Txt[];
}

// ---------------------------------------------------------------- gates

function gateBody({ comp, W, H, pins, props }: Ctx): ReactNode {
  const type = comp.type;
  const bubble = type === 'nand' || type === 'nor' || type === 'xnor';
  const R = W - (bubble ? 18 : 10);
  const base = type === 'nand' ? 'and' : type === 'nor' ? 'or' : type === 'xnor' ? 'xor' : type;
  const x0 = base === 'xor' ? 16 : 10;
  const neg = negatedInputs(props);
  let body: string;
  let backAt = (_y: number) => 10;
  if (base === 'and') {
    const rx = Math.min(H / 2, R - x0 - 8);
    body = `M${x0} 0 H${R - rx} A${rx} ${H / 2} 0 0 1 ${R - rx} ${H} H${x0} Z`;
  } else {
    const c = x0 + (R - x0) * 0.55;
    body = `M${x0} 0 Q${x0 + 10} ${H / 2} ${x0} ${H} Q${c} ${H} ${R} ${H / 2} Q${c} 0 ${x0} 0 Z`;
    backAt = (y) => 10 + 20 * (y / H) * (1 - y / H);
  }
  return (
    <>
      {pins
        .filter((p) => p.dir === 'in')
        .map((p, i) =>
          neg.has(i) ? (
            <g key={p.name}>
              <line className="stub" x1={0} y1={p.y} x2={backAt(p.y) - 8} y2={p.y} />
              <circle className="body" cx={backAt(p.y) - 4} cy={p.y} r={3.5} />
            </g>
          ) : (
            <line key={p.name} className="stub" x1={0} y1={p.y} x2={backAt(p.y)} y2={p.y} />
          ),
        )}
      <line className="stub" x1={bubble ? R + 8 : R} y1={H / 2} x2={W} y2={H / 2} />
      {base === 'xor' && <path className="body-line" d={`M10 0 Q20 ${H / 2} 10 ${H}`} />}
      <path className="body" d={body} />
      {bubble && <circle className="body" cx={R + 4} cy={H / 2} r={4} />}
      {props.output && props.output !== '01' && <text className="tiny-mark" x={(x0 + R) / 2} y={H / 2}>{props.output === '0z' ? '◇' : '◆'}</text>}
    </>
  );
}

function triangleBody({ comp }: Ctx): ReactNode {
  const inv = comp.type === 'not' || comp.type === 'triinv';
  const tip = inv ? 36 : 42;
  return (
    <>
      <line className="stub" x1={0} y1={10} x2={10} y2={10} />
      <line className="stub" x1={inv ? 44 : 42} y1={10} x2={50} y2={10} />
      <path className="body" d={`M10 0 L${tip} 10 L10 20 Z`} />
      {inv && <circle className="body" cx={40} cy={10} r={4} />}
      {(comp.type === 'tribuf' || comp.type === 'triinv') && <line className="stub" x1={20} y1={15} x2={20} y2={20} />}
    </>
  );
}

// ---------------------------------------------------------------- seven segment

const HEX_SEGMENTS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];

function segments(ox: number, oy: number, w: number, h: number, on: (i: number) => boolean | null, dp?: boolean | null): ReactNode {
  const m = h / 2;
  const segs: [number, number, number, number][] = [
    [ox + 3, oy, ox + w - 3, oy],
    [ox + w, oy + 3, ox + w, oy + m - 3],
    [ox + w, oy + m + 3, ox + w, oy + h - 3],
    [ox + 3, oy + h, ox + w - 3, oy + h],
    [ox, oy + m + 3, ox, oy + h - 3],
    [ox, oy + 3, ox, oy + m - 3],
    [ox + 3, oy + m, ox + w - 3, oy + m],
  ];
  return (
    <>
      {segs.map(([x1, y1, x2, y2], i) => {
        const v = on(i);
        return <line key={i} className={`seg ${v === null ? 'seg-x' : v ? 'seg-on' : 'seg-off'}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
      {dp !== undefined && <circle className={`seg-dot ${dp === null ? 'seg-x' : dp ? 'seg-on' : 'seg-off'}`} cx={ox + w + 7} cy={oy + h} r={2.4} />}
    </>
  );
}

// ---------------------------------------------------------------- chips

function chipBody(ctx: Ctx): ReactNode {
  const { comp, W, H, pins, texts } = ctx;
  const def = findDef(comp.type);
  const has = (s: string) => pins.some((p) => p.side === s);
  const L = has('l') ? 10 : 0;
  const R = has('r') ? W - 10 : W;
  const T = has('t') ? 10 : 0;
  const B = has('b') ? H - 10 : H;
  const sub = !!def?.subcircuit;
  const isMux = comp.type === 'mux' || comp.type === 'demux';
  const shape = isMux ? (
    comp.type === 'mux' ? (
      <polygon className="body" points={`${L},${T} ${R},${T + 14} ${R},${B - 14} ${L},${B}`} />
    ) : (
      <polygon className="body" points={`${L},${T + 14} ${R},${T} ${R},${B} ${L},${B - 14}`} />
    )
  ) : (
    <rect className={`body${sub ? ' sub' : ''}`} x={L} y={T} width={R - L} height={B - T} rx={sub ? 4 : 2} />
  );
  const title = def?.title?.(comp.props);
  // Keep the title clear of labels on top-edge pins (e.g. a flip-flop's SET).
  if (title) texts.push({ x: (L + R) / 2, y: T + (has('t') ? 19 : 10), text: title, cls: sub ? 'chip-title sub' : 'chip-title' });
  for (const p of pins) {
    if (p.clock || !p.label) continue;
    if (p.side === 'l') texts.push({ x: L + 4, y: p.y, text: p.label, anchor: 'start', cls: 'pin-label' });
    else if (p.side === 'r') texts.push({ x: R - 4, y: p.y, text: p.label, anchor: 'end', cls: 'pin-label' });
    else if (p.side === 't') texts.push({ x: p.x, y: T + 8, text: p.label, cls: 'pin-label' });
    else texts.push({ x: p.x, y: B - 7, text: p.label, cls: 'pin-label' });
  }
  return (
    <>
      {pins.map((p) => {
        const [x1, y1] = p.side === 'l' ? [L, p.y] : p.side === 'r' ? [R, p.y] : p.side === 't' ? [p.x, T] : [p.x, B];
        return <line key={p.name} className={`stub${p.width > 1 ? ' bus' : ''}`} x1={p.x} y1={p.y} x2={x1} y2={y1} />;
      })}
      {shape}
      {pins.map((p) =>
        p.clock ? (
          <path key={`k${p.name}`} className="body-line" d={p.side === 'b' ? `M${p.x - 5} ${B} L${p.x} ${B - 7} L${p.x + 5} ${B}` : `M${L} ${p.y - 5} L${L + 7} ${p.y} L${L} ${p.y + 5}`} />
        ) : p.bubble ? (
          <circle key={`b${p.name}`} className="body" cx={p.side === 'l' ? L - 4 : p.side === 'r' ? R + 4 : p.x} cy={p.side === 't' ? T - 4 : p.side === 'b' ? B + 4 : p.y} r={3.5} />
        ) : null,
      )}
    </>
  );
}

// ---------------------------------------------------------------- everything else

const LED_FILL: Record<string, string> = { amber: 'led-amber', red: 'led-red', green: 'led-green', blue: 'led-blue', white: 'led-white' };

function renderBody(ctx: Ctx): ReactNode {
  const { comp, props, W, H, read, texts, state } = ctx;
  const shape = findDef(comp.type)?.shape ?? '';
  const out = read('out');
  switch (shape) {
    case 'and':
    case 'or':
    case 'nand':
    case 'nor':
    case 'xor':
    case 'xnor':
      return gateBody(ctx);
    case 'not':
    case 'buffer':
    case 'tribuf':
    case 'triinv':
      return triangleBody(ctx);
    case 'switch': {
      const on = bitAt(out ?? ({ w: 1, v: 0, x: 1, z: 0, e: 0 } as Bits), 0) === 1;
      return (
        <>
          <line className="stub" x1={30} y1={10} x2={40} y2={10} />
          <rect className={`toggle ${on ? 'on' : ''}`} x={1} y={1} width={28} height={18} rx={9} />
          <circle className="knob" cx={on ? 20 : 10} cy={10} r={6} />
        </>
      );
    }
    case 'button':
      return (
        <>
          <line className="stub" x1={30} y1={10} x2={40} y2={10} />
          <rect className="body" x={1} y={-4} width={28} height={28} rx={6} />
          <circle className={`cap ${props.on ? 'on' : ''}`} cx={15} cy={10} r={8} />
        </>
      );
    case 'dip': {
      const n = Number(props.count ?? 4);
      const v = Number(props.value ?? 0);
      return (
        <>
          <line className="stub bus" x1={W - 10} y1={10} x2={W} y2={10} />
          <rect className="body" x={1} y={0} width={W - 11} height={30} rx={3} />
          {Array.from({ length: n }, (_, i) => {
            const bit = n - 1 - i;
            const on = (v >> bit) & 1;
            return (
              <g key={i} data-dip-bit={bit}>
                <rect className="dip-slot" x={6 + i * 12} y={5} width={8} height={20} rx={2} />
                <rect className={`dip-knob ${on ? 'on' : ''}`} x={6 + i * 12} y={on ? 5 : 15} width={8} height={10} rx={2} />
              </g>
            );
          })}
        </>
      );
    }
    case 'clock': {
      const high = out && bitAt(out, 0) === 1;
      return (
        <>
          <line className="stub" x1={30} y1={10} x2={40} y2={10} />
          <rect className={`body clock ${high ? 'on' : ''}`} x={1} y={1} width={28} height={18} rx={4} />
          <path className="glyph" d="M5 14 H10 V6 H15 V14 H20 V6 H25" />
        </>
      );
    }
    case 'const': {
      texts.push({ x: (W - 10) / 2, y: 10, text: formatValue(out ?? ({ w: 1, v: 0, x: 0, z: 0, e: 0 } as Bits), Number(props.bits) > 1 ? 'hex' : 'bin'), cls: 'const-text' });
      return (
        <>
          <line className={`stub${Number(props.bits) > 1 ? ' bus' : ''}`} x1={W - 10} y1={10} x2={W} y2={10} />
          <rect className="body" x={1} y={1} width={W - 11} height={18} rx={3} />
        </>
      );
    }
    case 'power':
      return (
        <>
          <line className="stub" x1={10} y1={8} x2={10} y2={30} />
          <path className="body-line" d="M2 8 H18" />
          <path className="body-line" d="M10 0 L4 8 M10 0 L16 8" />
        </>
      );
    case 'ground':
      return (
        <>
          <line className="stub" x1={10} y1={0} x2={10} y2={14} />
          <path className="body-line" d="M2 14 H18 M5 19 H15 M8 24 H12" />
        </>
      );
    case 'pin': {
      const isOut = props.io === 'out';
      const v = read('p');
      const width = Number(props.bits ?? 1);
      const radix = props.radix ?? 'bin';
      const shown = v ? (width > 1 && radix !== 'bin' ? formatValue(v, radix) : null) : null;
      const box = isOut ? { x: 10, w: W - 10 } : { x: 0, w: W - 10 };
      return (
        <>
          <line className={`stub${width > 1 ? ' bus' : ''}`} x1={isOut ? 0 : W - 10} y1={10} x2={isOut ? 10 : W} y2={10} />
          <rect className={`body pin-box ${isOut ? 'out' : 'in'}`} x={box.x} y={0} width={box.w} height={H} rx={isOut ? H / 2 > 10 ? 10 : H / 2 : 3} />
          {shown !== null ? (
            <text className="pin-bits" x={box.x + box.w / 2} y={H / 2} textAnchor="middle" dominantBaseline="central">
              {shown}
            </text>
          ) : (
            v &&
            Array.from({ length: width }, (_, i) => {
              const bit = width - 1 - i;
              const row = Math.floor(i / 8);
              const col = i % 8;
              const s = bitAt(v, bit);
              const cells = Math.min(width, 8);
              const x0 = box.x + box.w / 2 - (cells * 9) / 2;
              return (
                <text key={i} className={`pin-bits b-${s}`} x={x0 + col * 9 + 4.5} y={10 + row * 20} textAnchor="middle" dominantBaseline="central" data-pin-bit={bit}>
                  {s === 'z' ? 'Z' : s === 'e' ? 'E' : String(s)}
                </text>
              );
            })
          )}
        </>
      );
    }
    case 'probe': {
      const v = read('p');
      const text = v ? formatValue(v, props.radix) : '·';
      // Long values (32 bits in binary) are squeezed to fit the pill rather than overflowing it.
      const fitWidth = text.length * 6.6 > W - 10 ? W - 10 : undefined;
      return (
        <>
          <rect className="probe-box" x={0} y={0} width={W} height={H} rx={10} />
          <text className={`probe-text ${v ? bitClass(v) : 'vx'}`} x={W / 2} y={10} textAnchor="middle" dominantBaseline="central" textLength={fitWidth} lengthAdjust={fitWidth ? 'spacingAndGlyphs' : undefined}>
            {text}
          </text>
        </>
      );
    }
    case 'splitter': {
      const fans = ctx.pins.filter((p) => p.name !== 'c');
      return (
        <>
          <line className="split-spine" x1={0} y1={0} x2={10} y2={10} />
          <line className="split-spine" x1={10} y1={10} x2={10} y2={H - 10} />
          {fans.map((p) => (
            <g key={p.name}>
              <line className={`split-arm${p.width > 1 ? ' bus' : ''}`} x1={10} y1={p.y} x2={20} y2={p.y} />
              <text className="split-label" x={13} y={p.y - 5}>
                {p.label}
              </text>
            </g>
          ))}
        </>
      );
    }
    case 'tunnel':
      texts.push({ x: W / 2 + 4, y: 10, text: String(props.name ?? ''), cls: 'tunnel-text' });
      return <path className="body tunnel" d={`M0 10 L10 0 H${W} V20 H10 Z`} />;
    case 'pull':
      return (
        <>
          <line className="stub" x1={10} y1={34} x2={10} y2={40} />
          <path className="body-line" d="M10 2 V6 L5 9 L15 14 L5 19 L15 24 L5 29 L10 31 V34" />
          <text className="tiny-mark" x={18} y={6}>{props.pull === 'down' ? '0' : '1'}</text>
        </>
      );
    case 'junction':
      return <circle className="junction-part" cx={10} cy={10} r={4} />;
    case 'noconnect':
      return (
        <>
          <line className="stub" x1={0} y1={10} x2={10} y2={10} />
          <path className="body-line" d="M5 5 L15 15 M15 5 L5 15" />
        </>
      );
    case 'nmos':
    case 'pmos': {
      const n = shape === 'nmos';
      return (
        <>
          <line className="stub" x1={0} y1={20} x2={n ? 14 : 10} y2={20} />
          {!n && <circle className="body" cx={13} cy={20} r={3} />}
          <line className="body-line" x1={16} y1={10} x2={16} y2={30} />
          <line className="body-line" x1={21} y1={8} x2={21} y2={32} />
          <path className="body-line" d={n ? 'M21 12 H30 V0 M21 28 H30 V40' : 'M21 12 H30 V0 M21 28 H30 V40'} />
          <path className="arrow" d={n ? 'M24 28 L28 25 L28 31 Z' : 'M28 12 L24 9 L24 15 Z'} />
        </>
      );
    }
    case 'tgate':
      return (
        <>
          <line className="stub" x1={0} y1={20} x2={8} y2={20} />
          <line className="stub" x1={32} y1={20} x2={40} y2={20} />
          <path className="body" d="M8 10 L32 30 V10 L8 30 Z" />
          <line className="stub" x1={20} y1={0} x2={20} y2={15} />
          <line className="stub" x1={20} y1={25} x2={20} y2={36} />
          <circle className="body" cx={20} cy={37} r={3} />
        </>
      );
    case 'led': {
      const v = read('in');
      const on = v ? lit(bitAt(v, 0), props.active) : false;
      const unknown = !v || (bitAt(v, 0) !== 0 && bitAt(v, 0) !== 1);
      return (
        <>
          <line className="stub" x1={0} y1={10} x2={13} y2={10} />
          <circle className={`led ${on ? `on ${LED_FILL[String(props.color)] ?? 'led-amber'}` : ''}${unknown ? ' unknown' : ''}`} cx={23} cy={10} r={9} />
        </>
      );
    }
    case 'rgbled': {
      const ch = (p: string) => {
        const v = read(p);
        return v ? lit(bitAt(v, 0), props.active) : false;
      };
      const [r, g, b] = [ch('r'), ch('g'), ch('b')];
      const color = r || g || b ? `rgb(${r ? 255 : 30},${g ? 220 : 30},${b ? 255 : 30})` : undefined;
      return (
        <>
          {['r', 'g', 'b'].map((p, i) => (
            <line key={p} className="stub" x1={0} y1={10 + 20 * i} x2={12} y2={10 + 20 * i} />
          ))}
          <circle className={`led${color ? ' on' : ''}`} cx={25} cy={30} r={13} style={color ? { fill: color } : undefined} />
        </>
      );
    }
    case 'hex': {
      const bus = props.input === 'bus';
      const v = bus ? read('d') : undefined;
      let digit: number | null = null;
      if (bus) digit = v && isKnown(v) ? v.v : null;
      else {
        const bs = [0, 1, 2, 3].map((i) => read(`d${i}`));
        digit = bs.every((b) => b && isKnown(b)) ? bs.reduce((a, b, i) => a | ((b!.v & 1) << i), 0) : null;
      }
      const dpv = props.dp ? read('dp') : undefined;
      for (const p of ctx.pins) if (p.side === 'l') texts.push({ x: 14, y: p.y, text: p.label ?? '', anchor: 'start', cls: 'pin-label dim' });
      return (
        <>
          {ctx.pins.map((p) => (
            <line key={p.name} className={`stub${p.width > 1 ? ' bus' : ''}`} x1={p.x} y1={p.y} x2={p.side === 'l' ? 10 : p.x} y2={p.side === 'l' ? p.y : 90} />
          ))}
          <rect className="display" x={10} y={0} width={W - 10} height={90} rx={6} />
          {segments(34, 18, 20, 52, (i) => (digit === null ? null : !!(HEX_SEGMENTS[digit] & (1 << i))), props.dp ? (dpv ? (isKnown(dpv) ? dpv.v === 1 : null) : false) : undefined)}
        </>
      );
    }
    case 'sevenseg': {
      const bus = props.input === 'bus';
      const busV = bus ? read('seg') : undefined;
      const on = (i: number) => {
        const v = bus ? busV : read(SEGMENT_NAMES[i]);
        if (!v) return false;
        const s = bitAt(v, bus ? i : 0);
        return s === 0 || s === 1 ? lit(s, props.active) : null;
      };
      return (
        <>
          {ctx.pins.map((p) => (
            <line key={p.name} className={`stub${p.width > 1 ? ' bus' : ''}`} x1={0} y1={p.y} x2={10} y2={p.y} />
          ))}
          <rect className="display" x={10} y={0} width={W - 10} height={H} rx={6} />
          {segments(34, H / 2 - 26, 20, 52, on, on(7))}
        </>
      );
    }
    case 'ledbar': {
      const v = read('in');
      const n = Number(props.count ?? 8);
      return (
        <>
          <line className="stub bus" x1={0} y1={10} x2={10} y2={10} />
          <rect className="display" x={10} y={0} width={W - 10} height={H} rx={4} />
          {Array.from({ length: n }, (_, i) => {
            const s = v ? bitAt(v, i) : 'x';
            return <rect key={i} className={`bar-seg ${s === 1 ? `on ${LED_FILL[String(props.color)] ?? ''}` : ''}`} x={15 + i * 10} y={6} width={6} height={18} rx={1.5} />;
          })}
        </>
      );
    }
    case 'ledmatrix': {
      const px = matrixPixels(props, (name) => read(name) ?? ({ w: 1, v: 0, x: 1, z: 0, e: 0 } as Bits));
      return (
        <>
          <rect className="display" x={0} y={0} width={W} height={H} rx={4} />
          {px.flatMap((row, r) =>
            row.map((on, c) => <circle key={`${r}-${c}`} className={`dot ${on ? 'on' : ''}`} cx={c * MATRIX_CELL + 10} cy={r * MATRIX_CELL + 10} r={6} />),
          )}
        </>
      );
    }
    case 'slider': {
      const bitsN = Number(props.bits ?? 4);
      const max = 2 ** bitsN - 1;
      const v = Number(props.value ?? 0) & max;
      const x = 8 + ((W - 26) * v) / Math.max(1, max);
      return (
        <>
          <line className={`stub${bitsN > 1 ? ' bus' : ''}`} x1={W - 10} y1={10} x2={W} y2={10} />
          <line className="slider-track" x1={8} y1={10} x2={W - 18} y2={10} />
          <circle className="slider-knob" cx={x} cy={10} r={6} />
          <text className="slider-value" x={x} y={-4} textAnchor="middle">
            {v}
          </text>
        </>
      );
    }
    case 'keyboard': {
      const s = state as KeyboardState | undefined;
      const body = chipBody(ctx);
      texts.push({ x: W / 2, y: H - 14, text: s?.buffer ? `“${s.buffer.slice(0, 8).replace(/\n/g, '⏎')}”` : 'click, then type', cls: 'kbd-text' });
      return body;
    }
    case 'tty': {
      const s = state as TtyState | undefined;
      const lines = s?.lines ?? [];
      const rows = Number(props.rows ?? 8);
      const body = chipBody(ctx);
      return (
        <>
          {body}
          <foreignObject x={16} y={24} width={W - 32} height={H - 34}>
            <div className="tty-screen" style={{ height: '100%' }}>
              {lines.slice(-rows).map((l, i) => (
                <div key={i}>{l || ' '}</div>
              ))}
            </div>
          </foreignObject>
        </>
      );
    }
    case 'text':
      texts.push({ x: 0, y: 10, text: String(props.text), anchor: 'start', cls: 'note' });
      return <rect className="hit" data-export="skip" x={0} y={0} width={W} height={H} />;
    default:
      return chipBody(ctx);
  }
}

const FLIP: Record<string, 'start' | 'end'> = { start: 'end', end: 'start' };

/** Snapshot of values a part needs to draw itself; also its memo key. */
function readValues(sim: Simulator, comp: Component, pins: PinDef[]): Record<string, Bits> {
  const out: Record<string, Bits> = {};
  for (const p of pins) out[p.name] = sim.value(comp.id, p.name);
  return out;
}

function keyOf(vals: Record<string, Bits>, state: unknown, props: Props): string {
  let k = '';
  for (const [n, b] of Object.entries(vals)) k += `${n}:${b.w}.${b.v}.${b.x}.${b.z}.${b.e};`;
  return k + (state && typeof state === 'object' ? JSON.stringify(stateForKey(state)) : '') + (props === undefined ? '' : '');
}

/** Only the parts of state that affect drawing (keyboard buffer, tty lines). */
function stateForKey(s: object): unknown {
  const o = s as Record<string, unknown>;
  return { b: o.buffer, l: o.lines };
}

export const PartView = memo(function PartView({ comp, ghost }: { comp: Component; ghost?: boolean }) {
  const def = findDef(comp.type);
  const pins = def ? pinsOf(comp) : [];
  const key = useEditor((s) => (ghost || !def ? '' : keyOf(readValues(s.sim, comp, pins), s.sim.stateOf(comp.id), comp.props)));
  if (!def) return <MissingPart comp={comp} />;
  const sim = useEditor.getState().sim;
  void key;
  const vals = ghost ? {} : readValues(sim, comp, pins);
  const { w, h } = def.size(comp.props);
  const texts: Txt[] = [];
  const body = renderBody({ comp, props: comp.props, W: w, H: h, pins, read: (p) => vals[p], state: ghost ? undefined : sim.stateOf(comp.id), texts });
  const label = comp.label ? labelPlacement(comp) : null;
  const pokeable = ['switch', 'button', 'dip', 'clock', 'slider', 'keyboard'].includes(def.shape ?? '') || (comp.type === 'pin' && comp.props.io !== 'out');
  return (
    <g className={`part part-${comp.type}${def.subcircuit ? ' part-sub' : ''}`} data-comp={comp.id} data-poke={pokeable ? comp.id : undefined}>
      <g transform={bodyTransform(comp)}>
        <rect className="hit" data-export="skip" x={-2} y={-2} width={w + 4} height={h + 4} />
        {body}
      </g>
      {texts.map((t, i) => {
        const p = rotatePoint(t.x, t.y, w, h, comp.rot);
        const anchor = comp.rot === 0 ? t.anchor : comp.rot === 180 ? (FLIP[t.anchor ?? ''] ?? t.anchor) : 'middle';
        return (
          <text key={i} className={t.cls} x={comp.x + p.x} y={comp.y + p.y} textAnchor={anchor ?? 'middle'} dominantBaseline="central">
            {t.text}
          </text>
        );
      })}
      {label && (
        <text className="part-label" x={label.x} y={label.y} textAnchor={label.anchor} dominantBaseline="central">
          {comp.label}
        </text>
      )}
    </g>
  );
});

function MissingPart({ comp }: { comp: Component }) {
  return (
    <g className="part part-missing" data-comp={comp.id}>
      <rect className="missing" x={comp.x} y={comp.y} width={60} height={40} rx={3} />
      <text className="pin-label" x={comp.x + 30} y={comp.y + 20} textAnchor="middle" dominantBaseline="central">
        missing
      </text>
    </g>
  );
}

/** Static preview for the parts list and drag ghost. */
export function PartIcon({ type, size = 40 }: { type: string; size?: number }) {
  const def = findDef(type);
  if (!def) return null;
  const props: Record<string, unknown> = Object.fromEntries(def.props.map((p) => [p.key, p.default]));
  if (type === 'text') props.text = 'Aa';
  if (type === 'switch') props.on = true;
  if (type === 'dip') props.value = 5;
  const comp: Component = { id: 'icon', type, x: 0, y: 0, rot: 0, label: '', props: props as Props };
  const { w, h } = def.size(comp.props);
  const pins = def.subcircuit ? def.pins(comp.props) : getDef(type).pins(comp.props);
  const texts: Txt[] = [];
  const one = { w: 1, v: 1, x: 0, z: 0, e: 0 } as Bits;
  const body = renderBody({ comp, props: comp.props, W: w, H: h, pins, read: (p) => (type === 'led' || (type === 'switch' && p === 'out') ? one : undefined), state: undefined, texts });
  const pad = 6;
  return (
    <svg className="part-icon" viewBox={`${-pad} ${-pad - 4} ${w + 2 * pad} ${h + 2 * pad + 8}`} width={size} height={size} aria-hidden="true">
      {body}
      {texts.map((t, i) => (
        <text key={i} className={t.cls} x={t.x} y={t.y} textAnchor={t.anchor ?? 'middle'} dominantBaseline="central">
          {t.text}
        </text>
      ))}
    </svg>
  );
}
