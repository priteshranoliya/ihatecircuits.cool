import { useEffect, useRef, useState, type ReactElement } from 'react';
import { type Bits, bitAt, formatBits, isKnown } from '@ihatecircuits/core/bits';
import { useEditor, type Signal } from '../state/store';
import { Icon } from './icons';

const ROW = 26;
const AXIS = 18;
const WINDOW = 3000;

/** One waveform: levels for single bits, labelled segments for buses. Time runs left to right. */
function Trace({ sig, t0, now, px, y }: { sig: Signal; t0: number; now: number; px: number; y: number }) {
  const X = (t: number) => (Math.max(t, t0) - t0) * px;
  const hi = y + 5;
  const lo = y + ROW - 5;
  const mid = (hi + lo) / 2;
  const parts: ReactElement[] = [];
  const changes = sig.changes;
  let line = '';
  for (let i = 0; i < changes.length; i++) {
    const { t, v } = changes[i];
    const end = i + 1 < changes.length ? changes[i + 1].t : now;
    if (end < t0) continue;
    const x0 = X(t);
    const x1 = Math.max(x0 + 1, X(end));
    if (sig.width === 1) {
      const s = bitAt(v, 0);
      if (s === 0 || s === 1) {
        const yy = s === 1 ? hi : lo;
        line += `${line ? 'L' : 'M'}${x0} ${yy} L${x1} ${yy} `;
      } else {
        if (line) parts.push(<path key={`l${i}`} className={`tl-line ${sig.kind}`} d={line} />);
        line = '';
        if (s === 'z') parts.push(<line key={i} className="tl-z" x1={x0} x2={x1} y1={mid} y2={mid} />);
        else parts.push(<rect key={i} className={s === 'e' ? 'tl-e' : 'tl-x'} x={x0} y={hi} width={x1 - x0} height={lo - hi} />);
      }
    } else {
      const label = isKnown(v) ? formatBits(v, 'hex') : (v as Bits).e ? 'E' : formatBits(v, 'bin').replace(/^[Z]+$/, 'Z');
      const slant = Math.min(3, (x1 - x0) / 2);
      parts.push(
        <g key={i}>
          <path className={isKnown(v) ? 'tl-bus' : v.e ? 'tl-e' : 'tl-x'} d={`M${x0} ${mid} L${x0 + slant} ${hi} L${x1 - slant} ${hi} L${x1} ${mid} L${x1 - slant} ${lo} L${x0 + slant} ${lo} Z`} />
          {x1 - x0 > label.length * 6 + 6 && (
            <text className="tl-bus-text" x={(x0 + x1) / 2} y={mid} textAnchor="middle" dominantBaseline="central">
              {label}
            </text>
          )}
        </g>,
      );
    }
  }
  if (line) parts.push(<path key="last" className={`tl-line ${sig.kind}`} d={line} />);
  return <g>{parts}</g>;
}

export function Timeline({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const signals = useEditor((s) => s.signals);
  useEditor((s) => s.simRev);
  const sim = useEditor((s) => s.sim);
  // null = fit the recorded span to the panel; a number = the user's zoom (px per gate delay).
  const [zoom, setZoom] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [plotW, setPlotW] = useState(800);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPlotW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  const now = sim.time + 2;
  const first = signals.reduce((m, s) => Math.min(m, s.changes[0]?.t ?? now), now);
  const t0 = Math.max(first, now - WINDOW);
  const px = zoom ?? Math.min(24, Math.max(1, (plotW - 24) / Math.max(1, now - t0)));
  const setPx = (v: number) => setZoom(Math.min(40, Math.max(0.5, v)));
  const width = Math.max(200, (now - t0) * px + 20);
  const height = AXIS + signals.length * ROW;

  // Keep the newest values in view as time advances.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [now, open, px]);

  const step = px >= 12 ? 5 : px >= 4 ? 10 : px >= 1.5 ? 50 : 100;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= now; t += step) ticks.push(t);

  return (
    <section className="timeline" aria-label="Timing diagram">
      <div className="timeline-head">
        <button type="button" className="title" aria-expanded={open} onClick={onToggle} data-testid="timeline-toggle">
          <Icon name="wave" size={16} />
          Timing
          <span className="faint small">{signals.length ? `${signals.length} signals · time in gate delays` : 'Add inputs, clocks, probes or LEDs to see them here'}</span>
        </button>
        <span style={{ flex: 1 }} />
        {open && (
          <>
            <button type="button" className="icon-btn" onClick={() => setPx(px / 1.6)} aria-label="Zoom timing out">
              <Icon name="zoomOut" size={16} />
            </button>
            <button type="button" className="icon-btn" onClick={() => setPx(px * 1.6)} aria-label="Zoom timing in">
              <Icon name="zoomIn" size={16} />
            </button>
            {zoom !== null && (
              <button type="button" className="btn ghost small" onClick={() => setZoom(null)}>
                Fit
              </button>
            )}
            <button type="button" className="btn ghost small" onClick={() => useEditor.getState().clearSignals()}>
              Clear
            </button>
          </>
        )}
        <button type="button" className="icon-btn" onClick={onToggle} aria-label={open ? 'Hide timing' : 'Show timing'}>
          <span style={{ display: 'grid', transform: open ? 'rotate(90deg)' : 'rotate(-90deg)' }}>
            <Icon name="chevronRight" size={16} />
          </span>
        </button>
      </div>
      {open && (
        <div className="timeline-body">
          <div className="tl-names">
            {signals.map((s) => (
              <div key={`${s.id}:${s.pin}`} className={`tl-name ${s.kind}`} title={`${s.name}${s.width > 1 ? ` (${s.width} bits)` : ''}`}>
                {s.name}
              </div>
            ))}
          </div>
          <div className="tl-plot" ref={scroller}>
            <svg width={width} height={height} role="img" aria-label="Signal values over time">
              <g className="tl-axis">
                {ticks.map((t) => (
                  <g key={t}>
                    <line x1={(t - t0) * px} x2={(t - t0) * px} y1={AXIS - 4} y2={height} />
                    <text x={(t - t0) * px + 3} y={11}>
                      {t}
                    </text>
                  </g>
                ))}
              </g>
              {signals.map((s, i) => (
                <Trace key={`${s.id}:${s.pin}`} sig={s} t0={t0} now={now} px={px} y={AXIS + i * ROW} />
              ))}
              <line className="tl-now" x1={(now - t0) * px} x2={(now - t0) * px} y1={0} y2={height} />
            </svg>
          </div>
        </div>
      )}
    </section>
  );
}
