import { defaultKeymap, history, historyKeymap, indentWithTab, temporarilySetTabFocusMode } from '@codemirror/commands';
import { bracketMatching } from '@codemirror/language';
import { type Diagnostic, lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { useDarkTheme } from '../ui/Header';
import { verilog, verilogHighlight } from './language';
import type { Problem } from './protocol';

/** What the panel can ask of the editor. */
export interface EditorApi {
  /** Replace everything. This is one undo step, so the old text can come back with ⌘Z. */
  setText(text: string): void;
  jump(from: number, to: number): void;
  focus(): void;
}

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg-canvas)', color: 'var(--text)', fontSize: '12.5px' },
  '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--text)', padding: '6px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-panel)', color: 'var(--text-faint)', border: 'none', borderRight: '1px solid var(--border-subtle)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-element)', color: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--focus) 24%, transparent)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--focus) 16%, transparent)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--focus) 22%, transparent)', outline: '1px solid var(--focus)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'color-mix(in srgb, var(--danger) 22%, transparent)' },
  '.cm-lintRange': { backgroundImage: 'none', textDecorationThickness: '1.5px', textUnderlineOffset: '3px' },
  '.cm-lintRange-error': { textDecoration: 'underline wavy var(--danger)' },
  '.cm-lintRange-warning': { textDecoration: 'underline wavy var(--werr)' },
  '.cm-lintRange-info': { textDecoration: 'underline dotted var(--focus)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', boxShadow: 'var(--shadow-2)', fontFamily: 'var(--font)', fontSize: '12.5px' },
  '.cm-tooltip-lint': { maxWidth: '360px' },
  '.cm-diagnostic': { padding: '4px 8px', borderLeftWidth: '3px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--werr)' },
  '.cm-diagnostic-info': { borderLeftColor: 'var(--focus)' },
  '.cm-diagnosticSource': { fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--text-faint)' },
  '.cm-panels': { backgroundColor: 'var(--bg-panel)', color: 'var(--text)', borderColor: 'var(--border-subtle)', fontFamily: 'var(--font)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--border-subtle)' },
  '.cm-panels input, .cm-panels button': { fontFamily: 'var(--font)', fontSize: '12px' },
  '.cm-textfield': { backgroundColor: 'var(--bg-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-1)', padding: '3px 6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--bg-element)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-1)', padding: '2px 8px' },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--bg-active)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--focus) 20%, transparent)', outline: '1px solid color-mix(in srgb, var(--focus) 50%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--focus) 38%, transparent)' },
});

const levelName = { error: 'error', warning: 'warning', info: 'info' } as const;

export function toDiagnostics(problems: readonly Problem[], length: number): Diagnostic[] {
  return problems.map((p) => ({ from: Math.min(p.from, length), to: Math.min(Math.max(p.to, p.from), length), severity: levelName[p.level], source: p.code, message: p.message }));
}

export function Editor({
  initial,
  problems,
  apiRef,
  onChange,
  onBuild,
}: {
  initial: string;
  problems: readonly Problem[];
  apiRef: React.MutableRefObject<EditorApi | null>;
  onChange: (text: string) => void;
  onBuild: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const dark = useDarkTheme();
  const darkSlot = useRef(new Compartment());
  // The view is created once, so the callbacks are read through refs and are never stale.
  const cb = useRef({ onChange, onBuild });
  cb.current = { onChange, onBuild };
  const latestProblems = useRef(problems);
  latestProblems.current = problems;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          EditorView.lineWrapping,
          history(),
          bracketMatching(),
          highlightSelectionMatches(),
          lintGutter(),
          verilog,
          verilogHighlight,
          theme,
          darkSlot.current.of(EditorView.darkTheme.of(false)),
          EditorView.contentAttributes.of({ 'aria-label': 'Verilog source', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
          Prec.high(keymap.of([{ key: 'Mod-Enter', run: () => (cb.current.onBuild(), true) }])),
          keymap.of([
            ...searchKeymap,
            ...lintKeymap,
            // Tab indents, so Esc then Tab is the way out of the editor for a keyboard user.
            { key: 'Escape', run: temporarilySetTabFocusMode },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
        ],
      }),
    });
    view.current = v;
    apiRef.current = {
      setText: (text) => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: 0 }, scrollIntoView: true }),
      jump: (from, to) => {
        const end = v.state.doc.length;
        v.dispatch({ selection: { anchor: Math.min(from, end), head: Math.min(to, end) }, scrollIntoView: true });
        v.focus();
      },
      focus: () => v.focus(),
    };
    v.dispatch(setDiagnostics(v.state, toDiagnostics(latestProblems.current, v.state.doc.length)));
    return () => {
      apiRef.current = null;
      v.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the editor is created once; later text goes through apiRef.setText
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v) v.dispatch(setDiagnostics(v.state, toDiagnostics(problems, v.state.doc.length)));
  }, [problems]);

  useEffect(() => {
    view.current?.dispatch({ effects: darkSlot.current.reconfigure(EditorView.darkTheme.of(dark)) });
  }, [dark]);

  return <div className="vlog-editor" ref={host} />;
}
