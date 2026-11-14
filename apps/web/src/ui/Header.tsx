import { useEffect, useRef, useState } from 'react';
import { exportCircuit, saveProject, type ExportFormat } from '../export/exporters';
import { newProjectAction, useEditor } from '../state/store';
import { canvasApi } from './Canvas';
import { Icon, type IconName } from './icons';

export function openFilePicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) useEditor.getState().openFile(await f.text());
  };
  input.click();
}

export async function runExport(format: ExportFormat) {
  const st = useEditor.getState();
  if (!Object.keys(st.circuit().components).length) return st.notify('This circuit is empty. Add some parts before exporting.', 'error');
  try {
    const ok = canvasApi.el && (await exportCircuit(format, st.circuit(), canvasApi.el));
    st.notify(ok ? `Exported ${format.toUpperCase()}.` : `Could not export ${format.toUpperCase()}.`, ok ? 'info' : 'error');
  } catch {
    st.notify(`Could not export ${format.toUpperCase()}. Try SVG, which works in every browser.`, 'error');
  }
}

export function toggleTheme() {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try {
    localStorage.setItem('ihatecircuits:theme', next);
  } catch {
    /* per-device preference only */
  }
  window.dispatchEvent(new Event('ihatecircuits:theme'));
}

export function useDarkTheme() {
  const [dark, setDark] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark');
  useEffect(() => {
    const on = () => setDark(document.documentElement.getAttribute('data-theme') === 'dark');
    window.addEventListener('ihatecircuits:theme', on);
    return () => window.removeEventListener('ihatecircuits:theme', on);
  }, []);
  return dark;
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  hint?: string;
  run: () => void;
  testId?: string;
  divider?: boolean;
  heading?: boolean;
}

/** Dropdown menu with arrow-key navigation (WAI-ARIA menu button pattern). */
export function Menu({ label, icon, items, testId, iconOnly, trigger, align = 'right' }: {
  label: string;
  icon: IconName;
  items: MenuItem[];
  testId?: string;
  iconOnly?: boolean;
  trigger?: React.ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[(i + (e.key === 'ArrowDown' ? 1 : els.length - 1)) % els.length]?.focus();
  };
  return (
    <div className="menu" ref={ref} onKeyDown={onKey}>
      {trigger ? (
        <button type="button" className="brand" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)} data-testid={testId}>
          {trigger}
        </button>
      ) : (
        <button type="button" className={iconOnly ? 'icon-btn' : 'btn ghost'} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)} data-testid={testId}>
          <Icon name={icon} size={17} />
          {!iconOnly && <span className="hide-mid">{label}</span>}
        </button>
      )}
      {open && (
        <div className="menu-pop" role="menu" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}>
          {items.map((it, i) =>
            it.divider ? (
              <hr key={`d${i}`} />
            ) : it.heading ? (
              <div key={`h${i}`} className="menu-label">
                {it.label}
              </div>
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                data-testid={it.testId}
                onClick={() => {
                  setOpen(false);
                  it.run();
                }}
              >
                {it.icon && <Icon name={it.icon} size={16} />}
                <span>{it.label}</span>
                {it.hint && <kbd>{it.hint}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

const RATES = [1, 2, 4, 8, 16, 32, 64];
const nop = () => {};

export function Header({ onLibrary, onInspector }: { onLibrary: () => void; onInspector: () => void }) {
  const project = useEditor((s) => s.project);
  const active = useEditor((s) => s.active);
  const trail = useEditor((s) => s.trail);
  const running = useEditor((s) => s.running);
  const rate = useEditor((s) => s.rate);
  const tick = useEditor((s) => s.sim.tick);
  useEditor((s) => s.simRev);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const dark = useDarkTheme();
  const st = useEditor.getState();
  const name = (id: string) => project.circuits.find((c) => c.id === id)?.name ?? id;

  const appItems: MenuItem[] = [
    { label: 'Project', run: nop, heading: true },
    { label: 'New project', icon: 'file', run: newProjectAction, testId: 'menu-new' },
    { label: 'Open project file…', icon: 'open', hint: '⌘O', run: openFilePicker, testId: 'menu-open' },
    { label: 'Save project file', icon: 'save', hint: '⌘S', run: () => saveProject(useEditor.getState().project), testId: 'menu-save' },
    { label: 'Examples…', icon: 'book', run: () => st.setDialog('examples'), testId: 'menu-examples' },
    { label: '', run: nop, divider: true },
    { label: 'Export', run: nop, heading: true },
    { label: 'SVG image', icon: 'export', run: () => runExport('svg'), testId: 'export-svg' },
    { label: 'PNG image', icon: 'export', run: () => runExport('png'), testId: 'export-png' },
    { label: 'PDF document', icon: 'export', run: () => runExport('pdf'), testId: 'export-pdf' },
    { label: '', run: nop, divider: true },
    { label: dark ? 'Light theme' : 'Dark theme', icon: dark ? 'sun' : 'moon', run: toggleTheme, testId: 'theme' },
    { label: 'Help and shortcuts', icon: 'help', hint: '?', run: () => st.setDialog('help') },
  ];

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button type="button" className="icon-btn only-narrow" onClick={onLibrary} aria-label="Open library" data-testid="toggle-sidebar">
          <Icon name="menu" />
        </button>
        <Menu
          label="iHateCircuits menu"
          icon="more"
          items={appItems}
          testId="menu-file"
          align="left"
          trigger={
            <>
              <span className="brand-mark" aria-hidden="true">
                <svg viewBox="0 0 20 20" width="15" height="15">
                  <path d="M3 7h3 M3 13h3 M14 10h3 M6 4h4a6 6 0 0 1 0 12H6z" />
                </svg>
              </span>
              <span className="brand-name">iHateCircuits</span>
              <Icon name="chevron" size={14} />
            </>
          }
        />
        <span className="vsep hide-narrow" />
        <nav className="crumbs" aria-label="Location">
          {editing ? (
            <input
              className="field"
              style={{ width: 180, height: 28 }}
              autoFocus
              value={draft}
              aria-label="Project name"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft.trim()) st.commitProject({ ...useEditor.getState().project, name: draft.trim().slice(0, 80) });
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
          ) : (
            <button type="button" className="proj hide-narrow" title="Rename project" onClick={() => (setDraft(project.name), setEditing(true))}>
              {project.name}
            </button>
          )}
          {trail.map((id, i) => (
            <span key={`${id}-${i}`} style={{ display: 'contents' }}>
              <span className="sep">/</span>
              <button type="button" onClick={() => st.ascend(i)} title={`Back to ${name(id)} (Esc)`} data-testid={`crumb-${i}`}>
                {name(id)}
              </button>
            </span>
          ))}
          <span className="sep hide-narrow">/</span>
          <span className="here" data-testid="crumb-here">
            {name(active)}
          </span>
        </nav>
      </div>

      <div className="topbar-center">
        <button type="button" className="search-btn" onClick={() => st.setDialog('palette')} data-testid="open-palette">
          <Icon name="search" size={15} />
          <span>Search parts, actions and examples</span>
          <kbd>⌘K</kbd>
        </button>
      </div>

      <div className="topbar-right">
        <div className="run-cluster" role="group" aria-label="Simulation">
          <button type="button" className={`run-btn${running ? ' on' : ''}`} onClick={() => st.setRunning(!running)} aria-pressed={running} data-testid="run" title={running ? 'Pause the clock (Space)' : 'Run the clock continuously'}>
            {running ? <span className="pulse" aria-hidden="true" /> : <Icon name="play" size={14} />}
            <span className="hide-narrow">{running ? 'Running' : 'Run'}</span>
          </button>
          <button type="button" className="icon-btn" onClick={st.step} disabled={running} aria-label="Step one tick" title="Step one tick (K)" data-testid="step">
            <Icon name="step" size={15} />
          </button>
          <button type="button" className="icon-btn hide-narrow" onClick={st.resetSim} aria-label="Reset simulation" title="Reset: clear stored values and restart the clock" data-testid="reset">
            <Icon name="reset" size={15} />
          </button>
          <select className="hide-narrow" value={rate} onChange={(e) => st.setRate(Number(e.target.value))} aria-label="Clock speed" title="Clock ticks per second">
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r} Hz
              </option>
            ))}
          </select>
          <span className="tick hide-mid" title="Clock ticks since reset" data-testid="tick">
            tick {tick}
          </span>
        </div>
        <span className="vsep hide-narrow" />
        <button type="button" className="btn ghost" onClick={() => st.setDialog('analysis')} data-testid="analyze" title="Truth table, K-map and expressions (T)">
          <Icon name="table" size={16} />
          <span className="hide-mid">Analyze</span>
        </button>
        <button type="button" className="btn ghost hide-narrow" onClick={() => st.setDialog('tests')} data-testid="tests" title="Check the circuit against test vectors">
          <Icon name="test" size={16} />
          <span className="hide-mid">Test</span>
        </button>
        <button type="button" className="icon-btn hide-narrow" onClick={toggleTheme} aria-label={dark ? 'Light theme' : 'Dark theme'} title={dark ? 'Light theme' : 'Dark theme'}>
          <Icon name={dark ? 'sun' : 'moon'} size={16} />
        </button>
        <button type="button" className="icon-btn only-narrow" onClick={onInspector} aria-label="Properties" data-testid="toggle-inspector">
          <Icon name="sliders" />
        </button>
      </div>
    </header>
  );
}
