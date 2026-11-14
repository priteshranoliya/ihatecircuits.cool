import { useEditor, ZOOM_MAX, ZOOM_MIN, type Tool } from '../state/store';
import { canvasApi } from './Canvas';
import { Icon, type IconName } from './icons';

export function fit() {
  useEditor.getState().fitView(canvasApi.size());
}

export function zoomBy(f: number) {
  const { w, h } = canvasApi.size();
  useEditor.getState().zoomAt(f, w / 2, h / 2);
}

const TOOLS: { tool: Tool; icon: IconName; label: string; key: string }[] = [
  { tool: 'select', icon: 'pointer', label: 'Select and wire', key: 'V' },
  { tool: 'hand', icon: 'hand', label: 'Pan', key: 'H' },
  { tool: 'text', icon: 'text', label: 'Add a note', key: 'N' },
];

/** Bottom-centre tool dock: editing tools, then the most used actions. */
export function ToolDock({ focus, onFocus }: { focus: boolean; onFocus: () => void }) {
  const tool = useEditor((s) => s.tool);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const hasSel = useEditor((s) => s.selection.length > 0);
  const st = useEditor.getState();
  return (
    <div className="float tool-dock" role="toolbar" aria-label="Tools" data-testid="tool-dock">
      {TOOLS.map((t) => (
        <button key={t.tool} type="button" className="icon-btn" aria-pressed={tool === t.tool} aria-label={`${t.label} (${t.key})`} title={`${t.label} (${t.key})`} onClick={() => st.setTool(t.tool)} data-testid={`tool-${t.tool}`}>
          <Icon name={t.icon} size={17} />
          <span className="key" aria-hidden="true">
            {t.key}
          </span>
        </button>
      ))}
      <span className="vsep" />
      <button type="button" className="icon-btn" aria-label="Add a part (P)" title="Add a part (P)" onClick={() => st.setDialog('palette')} data-testid="dock-add">
        <Icon name="plus" size={17} />
        <span className="key" aria-hidden="true">
          P
        </span>
      </button>
      <span className="vsep" />
      <button type="button" className="icon-btn" onClick={st.undo} disabled={!canUndo} aria-label="Undo (⌘Z)" title="Undo (⌘Z)" data-testid="undo">
        <Icon name="undo" size={17} />
      </button>
      <button type="button" className="icon-btn" onClick={st.redo} disabled={!canRedo} aria-label="Redo (⌘⇧Z)" title="Redo (⌘⇧Z)" data-testid="redo">
        <Icon name="redo" size={17} />
      </button>
      <button type="button" className="icon-btn" onClick={st.rotateSelection} disabled={!hasSel} aria-label="Rotate (R)" title="Rotate (R)">
        <Icon name="rotate" size={17} />
      </button>
      <button type="button" className="icon-btn" onClick={st.removeSelection} disabled={!hasSel} aria-label="Delete (Del)" title="Delete (Del)" data-testid="delete">
        <Icon name="trash" size={17} />
      </button>
      <span className="vsep hide-narrow" />
      <button type="button" className="icon-btn hide-narrow" aria-pressed={focus} onClick={onFocus} aria-label="Focus mode (\\)" title="Focus mode: hide panels (\\)" data-testid="focus">
        <Icon name="focus" size={17} />
      </button>
    </div>
  );
}

export function ZoomCluster() {
  const zoom = useEditor((s) => s.view.zoom);
  return (
    <div className="float zoom-cluster" role="group" aria-label="Zoom">
      <button type="button" className="icon-btn" onClick={() => zoomBy(1 / 1.25)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out" title="Zoom out (−)">
        <Icon name="zoomOut" size={16} />
      </button>
      <button type="button" className="zoom" onClick={() => useEditor.getState().setView({ zoom: 1 })} title="Reset to 100%" data-testid="zoom-readout">
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className="icon-btn" onClick={() => zoomBy(1.25)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in (+)">
        <Icon name="zoomIn" size={16} />
      </button>
      <button type="button" className="icon-btn" onClick={fit} aria-label="Fit circuit" title="Fit circuit (0)" data-testid="fit">
        <Icon name="fit" size={16} />
      </button>
    </div>
  );
}

/** Signal key. Each state is shown with its colour AND its line pattern. */
export function Legend() {
  const items: [string, string, string, number][] = [
    ['1', 'var(--s1)', '', 2.8],
    ['0', 'var(--s0)', '', 2.4],
    ['unknown', 'var(--sx)', '6 4', 2.4],
    ['floating', 'var(--sz)', '1.5 4.5', 2.6],
    ['conflict', 'var(--se)', '', 3.4],
    ['bus', 'var(--bus)', '', 4.2],
  ];
  return (
    <div className="float legend" aria-label="Wire colours" role="note" data-testid="legend">
      {items.map(([label, color, dash, width]) => (
        <span key={label}>
          <svg width="18" height="8" aria-hidden="true">
            <line className="legend-line" x1="2" y1="4" x2="16" y2="4" stroke={color} strokeDasharray={dash || undefined} strokeWidth={width} />
          </svg>
          {label}
        </span>
      ))}
    </div>
  );
}

/** Persistent warning while the simulation cannot settle. */
export function StatusBanner() {
  useEditor((s) => s.simRev);
  const sim = useEditor((s) => s.sim);
  if (!sim.oscillating) return null;
  return (
    <div className="status-banner" role="alert" data-testid="oscillation-banner">
      <Icon name="warn" size={16} />
      <span>A feedback loop never settles. The parts involved are outlined.</span>
      <button type="button" className="btn small" onClick={() => useEditor.getState().resetSim()}>
        Reset
      </button>
    </div>
  );
}

export function Welcome() {
  const st = useEditor.getState();
  return (
    <div className="welcome" data-testid="welcome">
      <h2>Start a circuit</h2>
      <p>Everything stays in this browser and saves as you go.</p>
      <ul className="welcome-steps">
        <li>
          <kbd>drag</kbd> a part from the library onto the grid
        </li>
        <li>
          <kbd>drag</kbd> from pin to pin to wire them
        </li>
        <li>
          <kbd>click</kbd> switches to flip them, then watch the wires
        </li>
        <li>
          <kbd>⌘K</kbd> to find any part or action
        </li>
      </ul>
      <div className="welcome-actions">
        <button type="button" className="btn primary" onClick={() => st.setDialog('palette')}>
          <Icon name="plus" size={15} /> Add a part
        </button>
        <button type="button" className="btn" onClick={() => st.setDialog('examples')}>
          <Icon name="book" size={15} /> Open an example
        </button>
        <button type="button" className="btn ghost" onClick={() => st.setDialog('build')}>
          Build from an expression
        </button>
      </div>
    </div>
  );
}
