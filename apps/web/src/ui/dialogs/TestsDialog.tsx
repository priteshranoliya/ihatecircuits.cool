import { useEffect, useMemo, useRef, useState } from 'react';
import { parseVectors, runVectors, type ParsedVectors, type VectorCell, type VectorRun } from '@ihatecircuits/core/testvec';
import { useEditor } from '../../state/store';
import { Icon } from '../icons';
import { Modal } from '../Modal';
import { downloadText, safeFilename, testsStorageKey, testTemplate } from './dialogHelpers';
import './dialogs.css';

type Outcome = { kind: 'error'; message: string; line?: number } | { kind: 'run'; parsed: ParsedVectors; run: VectorRun };

const MAX_ROWS_SHOWN = 500;

const cellText = (c: VectorCell) => (c.kind === 'x' ? 'x' : c.kind === 'z' ? 'z' : c.text);

function readSaved(id: string): string | null {
  try {
    return localStorage.getItem(testsStorageKey(id));
  } catch {
    return null;
  }
}
function writeSaved(id: string, text: string) {
  try {
    localStorage.setItem(testsStorageKey(id), text);
  } catch {
    /* storage is optional */
  }
}

export function TestsDialog() {
  const circuit = useEditor((s) => s.circuit());
  const sim = useEditor((s) => s.sim);
  const setDialog = useEditor((s) => s.setDialog);
  const notify = useEditor((s) => s.notify);
  const template = useMemo(() => testTemplate(circuit), [circuit]);
  const [text, setText] = useState(() => readSaved(circuit.id) ?? template);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [onlyFailing, setOnlyFailing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => writeSaved(circuit.id, text), [circuit.id, text]);

  const run = () => {
    const parsed = parseVectors(text);
    if ('error' in parsed) return setOutcome({ kind: 'error', message: parsed.error, line: parsed.line });
    const res = runVectors(circuit, sim, parsed);
    if ('error' in res) return setOutcome({ kind: 'error', message: res.error, line: res.line });
    setOutcome({ kind: 'run', parsed, run: res });
  };

  const load = async (file: File | undefined) => {
    if (!file) return;
    try {
      setText(await file.text());
      setOutcome(null);
    } catch {
      notify('That file could not be read.', 'error');
    }
  };

  return (
    <Modal title="Test vectors" wide testId="tests-dialog" onClose={() => setDialog(null)}>
      <div className="dlg-stack">
        <details className="dlg-details">
          <summary>Format</summary>
          <p>
            The first line is a header of signal names separated by spaces. Each name must match the label of a switch, button, DIP switch, input pin, LED, output pin or probe in this circuit. Add a width with <code>Sum[4]</code> if you want it checked.
          </p>
          <p>Every line after that is one test row, with one value per column.</p>
          <ul>
            <li>
              Binary <code>0101</code>, hex <code>0x1F</code>, or decimal <code>13</code> and <code>-3</code>.
            </li>
            <li>
              <code>x</code> in an output column means any value is fine. <code>z</code> expects a floating output. Inputs cannot be x or z.
            </li>
            <li>
              Start a comment with <code>#</code>. Blank lines are ignored.
            </li>
            <li>
              For clocked circuits add a <code>#clock</code> column. <code>0</code> only applies the inputs, <code>1</code> advances half a clock period and <code>^</code> advances a whole one. State carries from row to row. Without that column every row starts from a fresh reset.
            </li>
          </ul>
        </details>

        <label className="dlg-label">
          Test vectors for “{circuit.name}”
          <textarea
            className="field vec-text"
            rows={10}
            value={text}
            spellCheck={false}
            wrap="off"
            onChange={(e) => {
              setText(e.target.value);
              setOutcome(null);
            }}
          />
        </label>

        <div className="dlg-row">
          <button type="button" className="btn primary" onClick={run}>
            <Icon name="play" size={15} /> Run tests
          </button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            <Icon name="open" size={15} /> Load file…
          </button>
          <button type="button" className="btn" onClick={() => downloadText(`${safeFilename(circuit.name)}-tests.txt`, text.endsWith('\n') ? text : `${text}\n`)}>
            <Icon name="save" size={15} /> Save…
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setText(template);
              setOutcome(null);
            }}
          >
            Reset to template
          </button>
          <input ref={fileRef} type="file" accept=".txt,text/plain" hidden aria-label="Choose a test vector file" onChange={(e) => {
            void load(e.target.files?.[0]);
            e.target.value = '';
          }} />
        </div>

        {outcome?.kind === 'error' && (
          <div className="callout error" role="alert">
            {outcome.line !== undefined && <strong>Line {outcome.line}. </strong>}
            {outcome.message}
          </div>
        )}
        {outcome?.kind === 'run' && <Results outcome={outcome} onlyFailing={onlyFailing} setOnlyFailing={setOnlyFailing} />}
      </div>
    </Modal>
  );
}

function Results({ outcome, onlyFailing, setOnlyFailing }: { outcome: Extract<Outcome, { kind: 'run' }>; onlyFailing: boolean; setOnlyFailing: (v: boolean) => void }) {
  const { parsed, run } = outcome;
  const total = run.passed + run.failed;
  const rows = onlyFailing ? run.results.filter((r) => !r.ok) : run.results;
  const shown = rows.slice(0, MAX_ROWS_SHOWN);
  return (
    <div className="dlg-stack" aria-live="polite">
      <div className="dlg-row">
        <span className={`vec-status ${run.failed ? 'fail' : 'pass'}`}>
          {total === 0 ? 'There are no rows to check. Add a row of values under the header.' : run.failed === 0 ? (total === 1 ? 'The row passes' : `All ${total} rows pass`) : `${run.passed} of ${total} rows pass`}
        </span>
        {run.failed > 0 && (
          <label className="check small">
            <input type="checkbox" checked={onlyFailing} onChange={(e) => setOnlyFailing(e.target.checked)} /> Show failing rows only
          </label>
        )}
      </div>
      {shown.length > 0 && (
        <div className="table-scroll dlg-scroll">
          <table className="data-table vec-table">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Result</th>
                {parsed.sequential && <th scope="col">#clock</th>}
                {parsed.header.map((h, i) => (
                  <th key={i} scope="col">
                    {h.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const row = parsed.rows[r.row];
                return (
                  <tr key={r.row} className={r.ok ? undefined : 'fail'}>
                    <th scope="row">{r.line}</th>
                    <td>
                      {r.ok ? 'Pass' : 'Fail'}
                      {r.mismatches
                        .filter((m) => !parsed.header.some((h) => h.name === m.signal))
                        .map((m, k) => (
                          <span key={k} className="exp-got">
                            <span>{m.signal === '(circuit)' ? 'The circuit did not settle' : m.signal}</span>
                          </span>
                        ))}
                    </td>
                    {parsed.sequential && <td>{row.clock ?? ''}</td>}
                    {parsed.header.map((h, i) => {
                      const m = r.mismatches.find((x) => x.signal === h.name);
                      return m ? (
                        <td key={i} className="bad">
                          <span className="exp-got">
                            <span>expected {m.expected}</span>
                            <span>got {m.got}</span>
                          </span>
                        </td>
                      ) : (
                        <td key={i}>{cellText(row.cells[i])}</td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > shown.length && <p className="faint small">Showing the first {MAX_ROWS_SHOWN} of {rows.length} rows.</p>}
    </div>
  );
}
