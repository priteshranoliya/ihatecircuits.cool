import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../state/store';
import { Menu } from '../ui/Header';
import { Icon } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { CompilerClient, type WorkerLike } from './client';
import { Editor, type EditorApi } from './Editor';
import { DEFAULT_EXAMPLE, VERILOG_EXAMPLES } from './examples';
import { addLowered, scopeTo } from './merge';
import { loadText, saveText } from './persist';
import { countProblems, summarize, type Problem, type View } from './protocol';
import './verilog.css';

const TIMEOUT_NOTE = 'Checking took more than 5 seconds, so it was stopped and restarted. Try a smaller design, or edit the text to try again.';
const CRASH_NOTE = 'The checker stopped unexpectedly. Edit the text to try again.';
const LEVEL_WORD = { error: 'Error', warning: 'Warning', info: 'Note' } as const;

const spawnWorker = (): WorkerLike => new Worker(new URL('./compiler.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;

interface Confirm {
  question: string;
  apply: () => void;
}

export default function VerilogPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [initial] = useState(() => loadText() ?? DEFAULT_EXAMPLE.source);
  const [text, setText] = useState(initial);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [autoTop, setAutoTop] = useState<string | undefined>();
  const [note, setNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [top, setTop] = useState('auto');
  const [view, setView] = useState<View>('blocks');
  const [building, setBuilding] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const api = useRef<EditorApi | null>(null);
  const client = useRef<CompilerClient | null>(null);
  const getClient = () => (client.current ??= new CompilerClient(spawnWorker));
  // Text that came from us (the starting example, a picked example, a circuit). Anything else is the student's own.
  const pristine = useRef(DEFAULT_EXAMPLE.source);
  const live = useRef({ text, top, view });
  live.current = { text, top, view };
  const topArg = (t: string) => (t === 'auto' ? undefined : t);

  useEffect(() => () => client.current?.dispose(), []);

  useEffect(() => {
    saveText(text);
  }, [text]);

  // Check as you type: wait for a short pause, then ask the worker. Answers to older text are dropped.
  useEffect(() => {
    setChecking(true);
    const t = setTimeout(async () => {
      const source = text;
      const out = await getClient().request<'lint'>({ kind: 'lint', source, top: topArg(top) });
      if (out.type === 'stale' || live.current.text !== source) return;
      setChecking(false);
      if (out.type === 'timeout') return setNote(TIMEOUT_NOTE);
      if (out.type === 'crashed') return setNote(CRASH_NOTE);
      setNote(null);
      setProblems(out.response.problems);
      setModules(out.response.modules);
      setAutoTop(out.response.top);
    }, 250);
    return () => clearTimeout(t);
  }, [text, top]);

  // The chosen top module may have been deleted or renamed since.
  useEffect(() => {
    if (top !== 'auto' && modules.length && !modules.includes(top)) setTop('auto');
  }, [modules, top]);

  useEffect(() => {
    if (open) api.current?.focus();
  }, [open]);

  const build = async () => {
    if (building) return;
    const { text: source, top: topNow, view: viewNow } = live.current;
    const st = useEditor.getState();
    setBuilding(true);
    const out = await getClient().request<'build'>({ kind: 'build', source, top: topArg(topNow), view: viewNow });
    setBuilding(false);
    if (out.type === 'stale') return;
    if (out.type === 'timeout') return st.notify(`Building took more than 5 seconds, so it was stopped.${viewNow === 'gates' ? ' Try the Blocks view, which uses far fewer parts.' : ' Try a smaller design.'}`, 'error');
    if (out.type === 'crashed') return st.notify('The builder stopped unexpectedly. Try again.', 'error');
    const r = out.response;
    if (live.current.text === source) {
      setProblems(r.problems);
      setModules(r.modules);
      setAutoTop(r.top);
      setNote(null);
      setChecking(false);
    }
    const { outcome } = r;
    if (outcome.type === 'blocked') {
      const first = r.problems.find((p) => p.level === 'error');
      if (first) api.current?.jump(first.from, first.to);
      const n = countProblems(r.problems).error;
      return st.notify(`Nothing was built. Fix the ${n === 1 ? 'error' : `${n} errors`} listed under the editor, then build again.`, 'error');
    }
    if (outcome.type === 'failed') return st.notify(`Could not build this design. ${outcome.message}`, 'error');
    const live2 = useEditor.getState();
    const added = addLowered(live2.project, outcome.project);
    live2.commitBuilt(added.project, added.topId);
    const name = added.project.circuits.find((c) => c.id === added.topId)?.name ?? outcome.top;
    useEditor.getState().notify(
      `Built ${added.circuits} circuit${added.circuits === 1 ? '' : 's'} with ${added.parts} part${added.parts === 1 ? '' : 's'}. “${name}” is open.`,
      'info',
      { label: 'Undo', run: () => useEditor.getState().undo() },
    );
  };
  const buildRef = useRef(build);
  buildRef.current = build;

  // The ⌘K command "Build from Verilog". Each request is answered once.
  const tick = useEditor((s) => s.verilogBuildTick);
  const handled = useRef(0);
  useEffect(() => {
    if (tick > handled.current) {
      handled.current = tick;
      void buildRef.current();
    }
  }, [tick]);

  const replaceText = (next: string, question: string) => {
    const apply = () => {
      pristine.current = next;
      api.current?.setText(next);
      api.current?.focus();
    };
    if (live.current.text.trim() !== '' && live.current.text !== pristine.current) setConfirm({ question, apply });
    else apply();
  };

  const loadFromCircuit = async () => {
    const st = useEditor.getState();
    const out = await getClient().request<'export'>({ kind: 'export', project: scopeTo(st.project, st.active) });
    if (out.type === 'stale') return;
    if (out.type !== 'ok') return st.notify('Turning the circuit into Verilog took too long and was stopped. Try a smaller circuit.', 'error');
    if (out.response.error !== undefined || out.response.text === undefined) return st.notify(out.response.error ?? 'This circuit could not be turned into Verilog.', 'error');
    replaceText(out.response.text, 'Replace the Verilog in the editor with the open circuit as Verilog?');
  };

  const counts = countProblems(problems);
  const status = note ?? (checking ? 'Checking…' : summarize(problems));
  const errored = !note && !checking && counts.error > 0;

  return (
    <>
      <div className="panel-head vlog-head">
        <h2 className="vlog-title">
          <Icon name="code" size={16} />
          Verilog
        </h2>
        <span className="spacer" />
        <Menu
          label="Examples"
          icon="book"
          testId="verilog-examples"
          items={VERILOG_EXAMPLES.map((e) => ({ label: e.title, run: () => replaceText(e.source, `Replace the Verilog in the editor with the “${e.title}” example?`), testId: `verilog-example-${e.id}` }))}
        />
        <button type="button" className="btn ghost" onClick={loadFromCircuit} data-testid="verilog-load-circuit" title="Replace the editor text with Verilog for the open circuit">
          <Icon name="chip" size={16} />
          <span className="hide-mid">From circuit</span>
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close Verilog editor" title="Close (E)" data-testid="verilog-close">
          <Icon name="close" />
        </button>
      </div>

      <div className="vlog-bar">
        <label className="vlog-field">
          <span>Top module</span>
          <select className="field" value={top} onChange={(e) => setTop(e.target.value)} data-testid="verilog-top">
            <option value="auto">{autoTop ? `Auto (${autoTop})` : 'Auto'}</option>
            {modules.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <div className="vlog-field">
          <span id="vlog-view-label">Build as</span>
          <div className="seg" role="group" aria-labelledby="vlog-view-label">
            <button type="button" className={view === 'blocks' ? 'on' : ''} aria-pressed={view === 'blocks'} onClick={() => setView('blocks')} title="Word-level parts: adders, registers and multiplexers" data-testid="verilog-view-blocks">
              Blocks
            </button>
            <button type="button" className={view === 'gates' ? 'on' : ''} aria-pressed={view === 'gates'} onClick={() => setView('gates')} title="Everything as logic gates and single-bit flip-flops" data-testid="verilog-view-gates">
              Gates
            </button>
          </div>
        </div>
        <button type="button" className="btn primary vlog-build" onClick={() => void build()} disabled={building} data-testid="verilog-build" title="Add circuits from this Verilog to the project (⌘Enter)">
          {building ? 'Building…' : 'Build'}
        </button>
      </div>

      <Editor initial={initial} problems={problems} apiRef={api} onChange={setText} onBuild={() => void buildRef.current()} />

      <section className="vlog-problems" aria-label="Problems" data-testid="verilog-problems">
        <div className={`vlog-status${errored ? ' bad' : ''}`} role="status" data-testid="verilog-status">
          {status}
        </div>
        {problems.length > 0 && (
          <ul>
            {problems.map((p, i) => (
              <li key={`${p.from}-${p.code}-${i}`}>
                <button type="button" className={`vlog-problem ${p.level}`} onClick={() => api.current?.jump(p.from, p.to)} data-testid="verilog-problem" data-line={p.line} data-level={p.level}>
                  <span className="vlog-level">{LEVEL_WORD[p.level]}</span>
                  <span className="vlog-where">
                    Line {p.line}, column {p.col}
                  </span>
                  <span className="vlog-msg">
                    <code>{p.code}</code> {p.message}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="vlog-hint">
          <kbd>⌘</kbd> <kbd>↵</kbd> builds. Tab indents, so press <kbd>Esc</kbd> then <kbd>Tab</kbd> to leave the editor.
        </p>
      </section>

      {confirm && (
        <Modal title="Replace your Verilog?" onClose={() => setConfirm(null)} testId="verilog-confirm">
          <p style={{ margin: '0 0 16px' }}>{confirm.question} Your current text is lost, unless you undo in the editor with ⌘Z.</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setConfirm(null)} data-autofocus>
              Keep my text
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                c.apply();
              }}
              data-testid="verilog-confirm-replace"
            >
              Replace
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
