import { useEffect, useState } from 'react';
import { saveProject } from '../export/exporters';
import { useEditor } from '../state/store';
import { Canvas } from './Canvas';
import { fit, Legend, StatusBanner, ToolDock, Welcome, ZoomCluster, zoomBy } from './CanvasChrome';
import { CommandPalette } from './CommandPalette';
import { ContextMenu } from './ContextMenu';
import { ExamplesDialog, HelpDialog } from './Dialogs';
import { AnalysisDialog } from './dialogs/AnalysisDialog';
import { MemoryDialog } from './dialogs/MemoryDialog';
import { TestsDialog } from './dialogs/TestsDialog';
import { Header, openFilePicker } from './Header';
import { Inspector } from './Inspector';
import { Sidebar, useResizable } from './Sidebar';
import { Timeline } from './Timeline';

export { fit };

const narrowQuery = () => window.matchMedia('(max-width: 860px)').matches;

function isTyping(e: KeyboardEvent) {
  return !!(e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]');
}

function useShortcuts(ui: { toggleFocus: () => void; toggleLib: () => void; toggleInsp: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'k') {
        e.preventDefault();
        st.setDialog(st.dialog === 'palette' ? null : 'palette');
        return;
      }
      if (isTyping(e) || st.dialog || st.menu) return;
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (mod && k === 'z') return run(e.shiftKey ? st.redo : st.undo);
      if (mod && k === 'y') return run(st.redo);
      if (mod && k === 'c') return run(st.copy);
      if (mod && k === 'x') return run(st.cut);
      if (mod && k === 'v') return run(st.paste);
      if (mod && k === 'd') return run(st.duplicate);
      if (mod && k === 'a') return run(st.selectAll);
      if (mod && k === 's') return run(() => saveProject(st.project));
      if (mod && k === 'o') return run(openFilePicker);
      if (mod || e.altKey) return;
      if (k === 'delete' || k === 'backspace') return run(st.removeSelection);
      if (k === 'escape') {
        if (st.pending || st.placing) return run(() => (st.setPending(null), st.setPlacing(null)));
        if (st.tool !== 'select') return run(() => st.setTool('select'));
        if (st.selection.length) return run(() => st.setSelection([]));
        if (st.trail.length) return run(() => st.ascend());
        return;
      }
      if (k === 'v') return run(() => st.setTool('select'));
      if (k === 'h') return run(() => st.setTool('hand'));
      if (k === 'n') return run(() => st.setTool('text'));
      if (k === 'p') return run(() => st.setDialog('palette'));
      if (k === '?') return run(() => st.setDialog('help'));
      if (k === '\\') return run(ui.toggleFocus);
      if (k === '[') return run(ui.toggleLib);
      if (k === ']') return run(ui.toggleInsp);
      if (k === 'r') return run(st.rotateSelection);
      if (k === 'k') return run(st.step);
      if (k === 't') return run(() => st.setDialog('analysis'));
      if (k === '0') return run(fit);
      if (k === '+' || k === '=') return run(() => zoomBy(1.25));
      if (k === '-' || k === '_') return run(() => zoomBy(0.8));
      const arrows: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
      const c = st.circuit();
      if (arrows[k] && st.selection.some((id) => c.components[id])) {
        const s = e.shiftKey ? 50 : 10;
        return run(() => st.nudge(arrows[k][0] * s, arrows[k][1] * s));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui]);
}

/** Drives clocks while running. Above ~30 Hz several ticks are batched per frame. */
function useClock() {
  const running = useEditor((s) => s.running);
  const rate = useEditor((s) => s.rate);
  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    let debt = 0;
    let raf = 0;
    const loop = (now: number) => {
      debt += ((now - last) / 1000) * rate;
      last = now;
      const ticks = Math.min(16, Math.floor(debt));
      if (ticks > 0) {
        debt -= ticks;
        const st = useEditor.getState();
        for (let i = 1; i < ticks; i++) st.sim.step();
        st.step();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, rate]);
}

function Toasts() {
  const toast = useEditor((s) => s.toast);
  const [visible, setVisible] = useState<typeof toast>(null);
  useEffect(() => {
    if (!toast) return;
    setVisible(toast);
    const t = setTimeout(() => setVisible(null), toast.tone === 'error' ? 6000 : toast.action ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {visible && (
        <div key={visible.id} className={`toast ${visible.tone}`} data-testid="toast">
          <span>{visible.text}</span>
          {visible.action && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                visible.action!.run();
                setVisible(null);
              }}
            >
              {visible.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function readFlag(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* convenience only */
  }
}

export function App() {
  const dialog = useEditor((s) => s.dialog);
  const hasSelection = useEditor((s) => s.selection.length > 0);
  const empty = useEditor((s) => Object.keys(s.circuit().components).length === 0);
  const placing = useEditor((s) => s.placing);
  const [narrow, setNarrow] = useState(narrowQuery);
  const [libOpen, setLibOpen] = useState(false);
  const [inspOpen, setInspOpen] = useState(false);
  const [focus, setFocus] = useState(false);
  const [libHidden, setLibHidden] = useState(() => readFlag('ihatecircuits:libHidden', false));
  const [inspHidden, setInspHidden] = useState(() => readFlag('ihatecircuits:inspHidden', false));
  const [timeOpen, setTimeOpen] = useState(() => !narrowQuery() && window.innerHeight > 720);
  const lib = useResizable('ihatecircuits:libW', 260, 200, 420, 'left');
  const insp = useResizable('ihatecircuits:inspW', 296, 240, 460, 'right');
  const [ui] = useState(() => ({
    toggleFocus: () => setFocus((f) => !f),
    toggleLib: () =>
      setLibHidden((h) => {
        writeFlag('ihatecircuits:libHidden', !h);
        return !h;
      }),
    toggleInsp: () =>
      setInspHidden((h) => {
        writeFlag('ihatecircuits:inspHidden', !h);
        return !h;
      }),
  }));
  useShortcuts(ui);
  useClock();

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    requestAnimationFrame(fit);
    const onFit = () => {
      setLibOpen(false);
      setInspOpen(false);
      fit();
      // Fit again once drawers/dialogs have closed — but never after the user has started editing or moved the view.
      const before = useEditor.getState();
      setTimeout(() => {
        const now = useEditor.getState();
        if (now.project === before.project && now.view === before.view) fit();
      }, 220);
    };
    window.addEventListener('ihatecircuits:fit', onFit);
    return () => window.removeEventListener('ihatecircuits:fit', onFit);
  }, []);

  // Re-fit when panels change the canvas size.
  useEffect(() => {
    const t = setTimeout(fit, 30);
    return () => clearTimeout(t);
  }, [focus, libHidden, inspHidden]);

  useEffect(() => {
    if (!narrow) {
      setLibOpen(false);
      setInspOpen(false);
    }
  }, [narrow]);

  useEffect(() => {
    if (dialog) {
      setLibOpen(false);
      setInspOpen(false);
    }
  }, [dialog]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useEditor.getState().dialog) {
        setLibOpen(false);
        setInspOpen(false);
      }
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const cols = `${focus || libHidden ? 0 : lib.width}px minmax(0, 1fr) ${focus || inspHidden ? 0 : insp.width}px`;
  return (
    <div className={`app${focus ? ' focus' : ''}`}>
      <Header onLibrary={() => (setLibOpen(true), setInspOpen(false))} onInspector={() => (setInspOpen(!inspOpen), setLibOpen(false))} />
      <div className="body-row" style={narrow ? undefined : { gridTemplateColumns: cols }}>
        <div style={{ display: 'contents', visibility: libHidden && !narrow ? 'hidden' : undefined }}>
          <Sidebar open={libOpen} onClose={() => setLibOpen(false)} onCollapse={ui.toggleLib} handle={lib.handle} />
        </div>
        <div className="stage">
          <div className="canvas-area">
            <Canvas />
            <StatusBanner />
            {empty && !placing && <Welcome />}
            <ZoomCluster />
            <ToolDock focus={focus} onFocus={ui.toggleFocus} />
            <Legend />
            {!narrow && libHidden && !focus && (
              <button type="button" className="float icon-btn" style={{ left: 10, top: 10, width: 34, height: 34 }} onClick={ui.toggleLib} aria-label="Show library" title="Show library ([)">
                <span style={{ transform: 'rotate(180deg)', display: 'grid' }}>
                  <svg className="icon" width="16" height="16" viewBox="0 0 20 20">
                    <path d="M12 5l-5 5 5 5" />
                  </svg>
                </span>
              </button>
            )}
            {!narrow && inspHidden && !focus && (
              <button type="button" className="float icon-btn" style={{ right: 10, top: 10, width: 34, height: 34 }} onClick={ui.toggleInsp} aria-label="Show properties" title="Show properties (])">
                <svg className="icon" width="16" height="16" viewBox="0 0 20 20">
                  <path d="M12 5l-5 5 5 5" />
                </svg>
              </button>
            )}
            {narrow && hasSelection && !inspOpen && (
              <button type="button" className="btn primary" style={{ position: 'absolute', right: 12, top: 12, zIndex: 12 }} onClick={() => setInspOpen(true)}>
                Edit selection
              </button>
            )}
          </div>
          <Timeline open={timeOpen} onToggle={() => setTimeOpen(!timeOpen)} />
        </div>
        <div style={{ display: 'contents', visibility: inspHidden && !narrow ? 'hidden' : undefined }}>
          <Inspector open={inspOpen} handle={insp.handle} onCollapse={ui.toggleInsp} onClose={() => setInspOpen(false)} />
        </div>
      </div>
      {narrow && (libOpen || inspOpen) && <div className="scrim" onClick={() => (setLibOpen(false), setInspOpen(false))} />}
      <ContextMenu />
      <Toasts />
      {dialog === 'examples' && <ExamplesDialog />}
      {dialog === 'help' && <HelpDialog />}
      {dialog === 'palette' && <CommandPalette />}
      {dialog === 'analysis' && <AnalysisDialog />}
      {dialog === 'build' && <AnalysisDialog initialTab="build" />}
      {dialog === 'tests' && <TestsDialog />}
      {dialog === 'memory' && <MemoryDialog />}
    </div>
  );
}
