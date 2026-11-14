import { useMemo, useState, type CSSProperties } from 'react';
import {
  expressions,
  formatPos,
  formatSop,
  kmap,
  truthTable,
  MAX_TABLE_INPUTS,
  type Cell,
  type OutputExpression,
  type TableError,
  type TruthTable,
} from '@ihatecircuits/core/analysis';
import { toTruthTable } from '@ihatecircuits/core/expr';
import { hazardFreeCover, staticHazards } from '@ihatecircuits/core/hazards';
import { addCircuit, replaceCircuit } from '@ihatecircuits/core/project';
import { buildCircuit } from '@ihatecircuits/core/synth';
import { useEditor } from '../../state/store';
import { Icon } from '../icons';
import { Modal, tabsOf } from '../Modal';
import { groupRects, parseBuildLines, truthTableText } from './dialogHelpers';
import './dialogs.css';

type Tab = 'table' | 'expr' | 'kmap' | 'build';
const TABS: { value: Tab; label: string }[] = [
  { value: 'table', label: 'Truth table' },
  { value: 'expr', label: 'Expressions' },
  { value: 'kmap', label: 'K-map' },
  { value: 'build', label: 'Build from expression' },
];

const GROUP_COLORS = ['#2b6cdf', '#2f9e6b', '#c2410c', '#8f7cc7', '#a07a00', '#c2478f', '#0f8a9d', '#7a6a55'];

const isError = (t: TruthTable | TableError): t is TableError => 'error' in t;

function emptyMessage(e: TableError): { title: string; hint: string } {
  switch (e.error) {
    case 'no-inputs':
      return { title: 'This circuit has no inputs yet.', hint: 'Add switches, buttons or input pins, then open this again.' };
    case 'no-outputs':
      return { title: 'This circuit has no outputs yet.', hint: 'Add LEDs or output pins so there is something to tabulate.' };
    case 'too-many-inputs':
      return { title: `This circuit has ${e.count} input bits.`, hint: `A truth table can have up to ${MAX_TABLE_INPUTS} input bits (${1 << MAX_TABLE_INPUTS} rows). Test a smaller part of the circuit instead.` };
  }
}

const cache = new WeakMap<TruthTable, OutputExpression[]>();
function expressionsOf(t: TruthTable): OutputExpression[] {
  let hit = cache.get(t);
  if (!hit) {
    hit = expressions(t);
    cache.set(t, hit);
  }
  return hit;
}

const Value = ({ v }: { v: Cell }) => <span className={v === 1 ? 'tt-1' : v === 0 ? 'tt-0' : 'tt-x'}>{v}</span>;

function TruthGrid({ table, limit }: { table: TruthTable; limit?: number }) {
  const rows = limit ? table.rows.slice(0, limit) : table.rows;
  return (
    <>
      <div className="table-scroll dlg-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {table.inputs.map((c, i) => (
                <th key={`i${i}`} scope="col">
                  {c.name}
                </th>
              ))}
              {table.outputs.map((c, i) => (
                <th key={`o${i}`} scope="col" className={i === 0 ? 'sep' : undefined}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.inputs.map((v, i) => (
                  <td key={i}>
                    <Value v={v} />
                  </td>
                ))}
                {r.outputs.map((v, i) => (
                  <td key={i} className={i === 0 ? 'sep' : undefined}>
                    <Value v={v} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {limit && table.rows.length > limit && <p className="faint small">Showing the first {limit} of {table.rows.length} rows.</p>}
    </>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="dlg-empty">
      <strong>{title}</strong>
      <span>{hint}</span>
    </div>
  );
}

// ---------------------------------------------------------------- truth table tab

function TableTab({ table }: { table: TruthTable | TableError }) {
  const notify = useEditor((s) => s.notify);
  if (isError(table)) return <Empty {...emptyMessage(table)} />;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(truthTableText(table));
      notify('Copied the truth table as tab-separated text.');
    } catch {
      notify('The browser would not let iHateCircuits copy to the clipboard.', 'error');
    }
  };
  return (
    <div className="dlg-stack">
      {table.hasMemory && (
        <div className="callout warn">
          This circuit has memory, so its outputs can depend on stored state. The table shows what happens from the current state only.
        </div>
      )}
      <div className="dlg-row">
        <span className="muted small dlg-grow">
          {table.inputs.length} input{table.inputs.length === 1 ? '' : 's'}, {table.outputs.length} output{table.outputs.length === 1 ? '' : 's'}, {table.rows.length} rows
        </span>
        <button type="button" className="btn small" onClick={copy}>
          <Icon name="copy" size={15} /> Copy as text
        </button>
      </div>
      <TruthGrid table={table} />
    </div>
  );
}

// ---------------------------------------------------------------- expressions tab

type Form = 'sop' | 'pos';

function FormToggle({ form, onChange, label }: { form: Form; onChange: (f: Form) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      <button type="button" className={form === 'sop' ? 'on' : ''} aria-pressed={form === 'sop'} onClick={() => onChange('sop')}>
        Sum of products
      </button>
      <button type="button" className={form === 'pos' ? 'on' : ''} aria-pressed={form === 'pos'} onClick={() => onChange('pos')}>
        Product of sums
      </button>
    </div>
  );
}

function Hazards({ e, names }: { e: OutputExpression; names: string[] }) {
  const n = names.length;
  const found = useMemo(() => staticHazards(n, e.sopTerms, e.minterms), [n, e]);
  const free = useMemo(() => {
    if (!found.length) return null;
    try {
      return hazardFreeCover(n, e.minterms, e.dontCares);
    } catch {
      return null;
    }
  }, [found, n, e]);
  if (!found.length) return <p className="hazard-note">No static hazards. Every pair of neighbouring 1s shares a product term.</p>;
  const shown = found.slice(0, 12);
  return (
    <div className="hazard-note">
      <strong>Static hazards.</strong> The output can glitch to 0 for a moment when one input changes and these terms hand over:
      <ul>
        {shown.map((h, i) => {
          const others = [...h.consensus].flatMap((ch, k) => (ch === '-' || k === h.variable ? [] : [`${names[k]} = ${ch}`]));
          return (
            <li key={i}>
              {names[h.variable]} changes{others.length ? ` while ${others.join(', ')}` : ''}, add <span className="mono">{formatSop([h.consensus], names)}</span>
            </li>
          );
        })}
      </ul>
      {found.length > shown.length && <p className="faint small">and {found.length - shown.length} more.</p>}
      {free && (
        <p>
          Hazard-free cover: <span className="mono">{formatSop(free.cover, names)}</span>
        </p>
      )}
    </div>
  );
}

function ExprTab({ table }: { table: TruthTable | TableError }) {
  const [form, setForm] = useState<Form>('sop');
  const exprs = useMemo(() => (isError(table) ? [] : expressionsOf(table)), [table]);
  if (isError(table)) return <Empty {...emptyMessage(table)} />;
  const names = table.inputs.map((c) => c.name);
  return (
    <div className="dlg-stack">
      <div className="dlg-row">
        <FormToggle form={form} onChange={setForm} label="Expression form" />
        <span className="muted small">Minimised with Quine–McCluskey. Unknown (x) rows count as don’t-cares.</span>
      </div>
      {table.hasMemory && <div className="callout warn">This circuit has memory, so these expressions describe the current state only.</div>}
      {exprs.map((e) => (
        <section key={e.output} className="card expr-card" aria-label={`Expressions for ${e.output}`}>
          <h3>{e.output}</h3>
          <div className="expr-line">
            {e.output} = {form === 'sop' ? e.sop : e.pos}
          </div>
          <div className="expr-lists">
            <span>Σm({e.minterms.join(', ')})</span>
            <span>ΠM({e.maxterms.join(', ')})</span>
            <span>d({e.dontCares.join(', ')})</span>
          </div>
          {form === 'sop' && <Hazards e={e} names={names} />}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- k-map tab

const CELL = 56;
const GUTTER_W = 92;
const GUTTER_H = 44;

function KmapTab({ table }: { table: TruthTable | TableError }) {
  const [out, setOut] = useState(0);
  const [form, setForm] = useState<Form>('sop');
  const exprs = useMemo(() => (isError(table) ? [] : expressionsOf(table)), [table]);
  if (isError(table)) return <Empty {...emptyMessage(table)} />;
  const n = table.inputs.length;
  if (n < 2 || n > 4) {
    return (
      <Empty
        title={n < 2 ? 'A K-map needs at least 2 inputs.' : 'K-maps are shown for up to 4 inputs.'}
        hint="Use the Expressions tab for the minimised form of larger circuits."
      />
    );
  }
  const k = Math.min(out, table.outputs.length - 1);
  const names = table.inputs.map((c) => c.name);
  const values = table.rows.map((r) => r.outputs[k]);
  const map = kmap(n, values, names)!;
  const e = exprs[k];
  const terms = form === 'sop' ? e.sopTerms : e.posTerms;
  const rows = map.rowCodes.length;
  const cols = map.colCodes.length;
  const code = (v: number, bits: number) => v.toString(2).padStart(bits, '0');
  const joiner = (v: string[]) => v.join(v.every((s) => s.length === 1) ? '' : ' ');
  const termText = (imp: string) => (form === 'sop' ? formatSop([imp], names) : formatPos([imp], names));
  const style: CSSProperties = { gridTemplateColumns: `${GUTTER_W}px repeat(${cols}, ${CELL}px)`, gridTemplateRows: `${GUTTER_H}px repeat(${rows}, ${CELL}px)` };
  return (
    <div className="dlg-stack">
      <div className="dlg-row">
        <label className="dlg-label">
          Output
          <select className="field" value={k} onChange={(ev) => setOut(Number(ev.target.value))}>
            {table.outputs.map((o, i) => (
              <option key={i} value={i}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <div className="dlg-label">
          Groups
          <FormToggle form={form} onChange={setForm} label="Group form" />
        </div>
      </div>
      {table.hasMemory && <div className="callout warn">This circuit has memory, so the map shows the current state only.</div>}
      <div className="kmap-wrap">
        <div className="kmap" style={style} role="table" aria-label={`Karnaugh map for ${e.output}`}>
          <div className="kmap-corner" role="columnheader">
            {joiner(map.rowVars)} ╲ {joiner(map.colVars)}
          </div>
          {map.colCodes.map((cc) => (
            <div key={cc} className="kmap-axis col" role="columnheader">
              {code(cc, map.colVars.length)}
            </div>
          ))}
          {map.cells.map((row, r) => [
            <div key={`r${r}`} className="kmap-axis" role="rowheader">
              {code(map.rowCodes[r], map.rowVars.length)}
            </div>,
            ...row.map((cell) => (
              <div key={cell.m} className="kmap-cell" role="cell" title={`Row ${cell.m}: ${cell.v}`}>
                <small>{cell.m}</small>
                <Value v={cell.v} />
              </div>
            )),
          ])}
          <div className="kmap-layer" aria-hidden="true" style={{ left: GUTTER_W, top: GUTTER_H, width: cols * CELL, height: rows * CELL }}>
            {terms.flatMap((imp, gi) =>
              groupRects(map, imp).map((g, pi) => {
                const pad = 4 + (gi % 3) * 2;
                const cls = ['kmap-group', g.openTop && 'open-top', g.openBottom && 'open-bottom', g.openLeft && 'open-left', g.openRight && 'open-right'].filter(Boolean).join(' ');
                const st = {
                  '--gc': GROUP_COLORS[gi % GROUP_COLORS.length],
                  left: g.c0 * CELL + (g.openLeft ? -2 : pad),
                  top: g.r0 * CELL + (g.openTop ? -2 : pad),
                  width: (g.c1 - g.c0 + 1) * CELL - (g.openLeft ? 0 : pad) - (g.openRight ? 0 : pad) + (g.openLeft ? 2 : 0) + (g.openRight ? 2 : 0),
                  height: (g.r1 - g.r0 + 1) * CELL - (g.openTop ? 0 : pad) - (g.openBottom ? 0 : pad) + (g.openTop ? 2 : 0) + (g.openBottom ? 2 : 0),
                } as CSSProperties;
                return <div key={`${gi}-${pi}`} className={cls} style={st} />;
              }),
            )}
          </div>
        </div>
      </div>
      {terms.length ? (
        <div className="kmap-legend" aria-label="Groups">
          {terms.map((imp, i) => (
            <span key={imp} style={{ '--gc': GROUP_COLORS[i % GROUP_COLORS.length] } as CSSProperties}>
              <i />
              {termText(imp)}
            </span>
          ))}
        </div>
      ) : (
        <p className="muted small">{form === 'sop' ? 'This output is never 1, so there are no groups.' : 'This output is never 0, so there are no groups.'}</p>
      )}
      <p className="faint small">Neighbouring cells differ in one variable, and the edges wrap round. Dashed edges show a group that continues on the other side.</p>
    </div>
  );
}

// ---------------------------------------------------------------- build tab

const EXAMPLE = 'F = A·B + A′C';

function BuildTab({ table }: { table: TruthTable | TableError }) {
  const project = useEditor((s) => s.project);
  const commitProject = useEditor((s) => s.commitProject);
  const setDialog = useEditor((s) => s.setDialog);
  const [text, setText] = useState(EXAMPLE);
  const [form, setForm] = useState<'expression' | 'sop' | 'pos'>('expression');
  const [twoInputOnly, setTwo] = useState(false);
  const [nandOnly, setNand] = useState(false);
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const parsed = useMemo(() => parseBuildLines(text), [text]);
  const preview = useMemo(
    () => (parsed.outputs.length ? toTruthTable(parsed.outputs.map((o) => ({ name: o.name, ast: o.ast })), parsed.inputs) : null),
    [parsed],
  );
  const previewError = preview && 'error' in preview ? preview.error : null;
  const previewTable = preview && !('error' in preview) ? preview : null;
  const defaultName = parsed.outputs.map((o) => o.name).join(', ') || 'New circuit';
  const canCreate = parsed.problems.length === 0 && previewTable !== null;

  const fromCircuit = useMemo(() => {
    if (isError(table)) return null;
    return expressionsOf(table)
      .map((e) => `${e.output} = ${e.sop}`)
      .join('\n');
  }, [table]);

  const create = () => {
    if (!previewTable) return;
    try {
      const label = name.trim() || defaultName;
      const built = buildCircuit(
        parsed.outputs.map((o) => ({ name: o.name, expr: o.ast })),
        parsed.inputs,
        { form, twoInputOnly, nandOnly, name: label },
      );
      const added = addCircuit(project, label);
      const finalName = added.project.circuits.find((c) => c.id === added.id)!.name;
      const next = replaceCircuit(added.project, { ...built, id: added.id, name: finalName });
      commitProject(next, added.id, `Built “${finalName}”. It is a new circuit in the sidebar.`);
      setDialog(null);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The circuit could not be built.');
    }
  };

  return (
    <div className="dlg-stack">
      <label className="dlg-label">
        Expressions, one per line
        <textarea
          className={`field build-text${parsed.problems.length ? ' invalid' : ''}`}
          rows={5}
          value={text}
          spellCheck={false}
          aria-describedby="build-help"
          onChange={(e) => {
            setText(e.target.value);
            setFailure(null);
          }}
        />
      </label>
      <p id="build-help" className="faint small">
        Write Name = expression. Use · or * for AND, + for OR, ′ or ! for NOT, and ⊕ or ^ for XOR. Variables become input pins and each name on the left becomes an output pin.
      </p>
      {parsed.problems.length > 0 && (
        <ul className="problem-list" role="alert">
          {parsed.problems.map((p, i) => (
            <li key={i}>
              <span className="where">
                Line {p.line}
                {p.column ? `, column ${p.column}` : ''}
              </span>
              {p.message}
            </li>
          ))}
        </ul>
      )}
      <div className="dlg-row">
        <button type="button" className="btn small" disabled={!fromCircuit} onClick={() => fromCircuit && setText(fromCircuit)}>
          Use this circuit’s table
        </button>
        {!fromCircuit && <span className="faint small">Needs a circuit with inputs and outputs.</span>}
      </div>

      <div className="opt-grid">
        <div className="dlg-label">
          Form
          <div className="seg" role="group" aria-label="Circuit form">
            {(
              [
                ['expression', 'As written'],
                ['sop', 'Minimal SOP'],
                ['pos', 'Minimal POS'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} type="button" className={form === v ? 'on' : ''} aria-pressed={form === v} onClick={() => setForm(v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={twoInputOnly} onChange={(e) => setTwo(e.target.checked)} /> 2-input gates only
        </label>
        <label className="check">
          <input type="checkbox" checked={nandOnly} onChange={(e) => setNand(e.target.checked)} /> NAND gates only
        </label>
        <label className="dlg-label">
          Circuit name
          <input className="field" value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>

      {previewError && <div className="callout error">{previewError}</div>}
      {failure && <div className="callout error" role="alert">{failure}</div>}
      {previewTable ? (
        <div className="dlg-stack">
          <h3 className="eyebrow">Preview</h3>
          <TruthGrid table={previewTable} limit={256} />
        </div>
      ) : (
        !previewError && <p className="muted small">The truth table appears here once an expression parses.</p>
      )}
      <div className="dlg-row end">
        <button type="button" className="btn primary" disabled={!canCreate} onClick={create}>
          Create circuit
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- dialog

export function AnalysisDialog({ initialTab = 'table' }: { initialTab?: Tab } = {}) {
  const circuit = useEditor((s) => s.circuit());
  const sim = useEditor((s) => s.sim);
  const setDialog = useEditor((s) => s.setDialog);
  const [tab, setTab] = useState<Tab>(initialTab);
  const table = useMemo(() => truthTable(circuit, sim), [circuit, sim]);
  return (
    <Modal title="Analyze circuit" wide testId="analysis-dialog" onClose={() => setDialog(null)} tabs={tabsOf(TABS, tab, (v) => setTab(v as Tab))}>
      {tab === 'table' && <TableTab table={table} />}
      {tab === 'expr' && <ExprTab table={table} />}
      {tab === 'kmap' && <KmapTab table={table} />}
      {tab === 'build' && <BuildTab table={table} />}
    </Modal>
  );
}
