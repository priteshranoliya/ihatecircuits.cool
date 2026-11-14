import { useEffect, useState } from 'react';
import { type Bits, formatBits, isKnown, toSigned } from '@ihatecircuits/core/bits';
import { rotateComponent, updateComponent } from '@ihatecircuits/core/edit';
import { findDef, pinsOf, type PropDef } from '@ihatecircuits/core/library';
import { portsOf, subTarget } from '@ihatecircuits/core/project';
import { duplicatePortLabels } from '@ihatecircuits/core/netlist';
import type { Component } from '@ihatecircuits/core/types';
import { useEditor } from '../state/store';
import { Icon } from './icons';
import { PartIcon } from './parts';

/** The live store. Handlers read it at event time: a snapshot taken during render can be stale. */
const live = () => useEditor.getState();

/** Text field that commits on blur/Enter, so typing is one undo step. */
function CommitInput({ value, onCommit, label, id, maxLength, validate, mono }: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  id: string;
  maxLength?: number;
  validate?: (v: string) => boolean;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const ok = !validate || validate(draft);
  return (
    <input
      id={id}
      className={`field${ok ? '' : ' invalid'}${mono ? ' mono' : ''}`}
      value={draft}
      maxLength={maxLength}
      aria-label={label}
      aria-invalid={!ok}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value && ok) onCommit(draft);
        else if (!ok) setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function PropField({ comp, def }: { comp: Component; def: PropDef }) {
  const id = `prop-${def.key}`;
  const set = (v: unknown) => {
    if (def.runtime) live().poke(comp.id, def.key, v);
    else live().commit(updateComponent(live().circuit(), comp.id, { props: { [def.key]: v } }));
  };
  const v = comp.props[def.key];
  let input;
  if (def.kind === 'int') {
    const span = (def.max ?? 0) - (def.min ?? 0);
    input =
      span <= 40 ? (
        <select id={id} className="field" value={v as number} onChange={(e) => set(Number(e.target.value))}>
          {Array.from({ length: span + 1 }, (_, i) => (def.min ?? 0) + i).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      ) : (
        <CommitInput id={id} label={def.label} value={String(v)} validate={(s) => /^\d+$/.test(s) && Number(s) >= (def.min ?? 0) && Number(s) <= (def.max ?? Infinity)} onCommit={(s) => set(Number(s))} mono />
      );
  } else if (def.kind === 'enum') {
    input =
      def.options!.length <= 3 && def.options!.every((o) => o.label.length < 12) ? (
        <div className="seg" role="radiogroup" aria-label={def.label}>
          {def.options!.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={v === o.value} className={v === o.value ? 'on' : ''} onClick={() => set(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <select id={id} className="field" value={String(v)} onChange={(e) => set(e.target.value)}>
          {def.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
  } else if (def.kind === 'bool') {
    input = (
      <label className="check">
        <input id={id} type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} />
        <span>{v ? 'Yes' : 'No'}</span>
      </label>
    );
  } else if (def.kind === 'hex') {
    input = <CommitInput id={id} label={def.label} value={String(v)} validate={(s) => /^[0-9a-fA-F]{1,8}$/.test(s)} onCommit={(s) => set(s.toUpperCase())} mono />;
  } else if (def.kind === 'memory') {
    input = (
      <button type="button" className="btn" onClick={() => live().setDialog('memory', comp.id)}>
        <Icon name="memory" size={16} /> Edit contents…
      </button>
    );
  } else {
    input = <CommitInput id={id} label={def.label} value={String(v)} onCommit={set} maxLength={200} mono={def.key === 'map' || def.key === 'value'} />;
  }
  // Wide controls (text, segmented choices with long labels, memory) sit under their label.
  const stack = def.kind === 'text' || def.kind === 'memory' || (def.kind === 'enum' && def.options!.length > 3);
  return (
    <div className={`prop${stack ? ' stack' : ''}`}>
      {def.kind === 'bool' ? <span className="prop-label">{def.label}</span> : <label htmlFor={id}>{def.label}</label>}
      {input}
      {def.hint && <p className="hint">{def.hint}</p>}
    </div>
  );
}

function valueText(b: Bits): string {
  if (b.w === 1) return formatBits(b, 'bin');
  const bin = formatBits(b, 'bin');
  if (!isKnown(b)) return bin;
  return `${bin} · 0x${formatBits(b, 'hex')} · ${b.v >>> 0}${toSigned(b)! < 0 ? ` (${toSigned(b)})` : ''}`;
}

function ComponentInspector({ comp }: { comp: Component }) {
  const def = findDef(comp.type);
  useEditor((s) => s.simRev);
  const sim = useEditor((s) => s.sim);
  if (!def) return null;
  const pins = pinsOf(comp);
  const sub = subTarget(comp.type);
  const props = def.props.filter((p) => !p.when || p.when.is.includes(comp.props[p.when.key]));
  return (
    <>
      <header className="insp-head">
        <div className="kind">
          <span className="kind-icon" aria-hidden="true">
            <PartIcon type={comp.type} size={26} />
          </span>
          <div>
            <p className="eyebrow">{def.category === 'Circuits' ? 'Subcircuit' : def.category}</p>
            <h2>{def.name}</h2>
          </div>
        </div>
        <p>{def.description}</p>
      </header>
      <div className="insp-scroll">
        <details className="section" open>
          <summary>
            <span className="chev">
              <Icon name="chevronRight" size={12} />
            </span>
            Properties
          </summary>
          <div className="insp-body">
            {comp.type !== 'text' && !sub && (
              <div className="prop">
                <label htmlFor="insp-label">Label</label>
                <CommitInput id="insp-label" label="Label" value={comp.label} maxLength={40} onCommit={(label) => live().commit(updateComponent(live().circuit(), comp.id, { label }))} />
              </div>
            )}
            {props.map((p) => (
              <PropField key={p.key} comp={comp} def={p} />
            ))}
            {sub && (
              <button type="button" className="btn" onClick={() => live().enterCircuit(sub)}>
                <Icon name="layers" size={15} /> Open “{def.name}”
              </button>
            )}
            {(comp.type === 'ram' || comp.type === 'rom') && !def.props.some((p) => p.kind === 'memory') && (
              <button type="button" className="btn" onClick={() => live().setDialog('memory', comp.id)}>
                <Icon name="memory" size={15} /> View and edit contents…
              </button>
            )}
            {props.length === 0 && comp.type === 'text' && <p className="faint small">Notes have no effect on the circuit.</p>}
          </div>
        </details>
        {pins.length > 0 && (
          <details className="section" open>
            <summary>
              <span className="chev">
                <Icon name="chevronRight" size={12} />
              </span>
              Live values
            </summary>
            <div className="insp-body">
              <table className="pin-table">
                <tbody>
                  {pins.map((p) => {
                    const v = sim.input(comp.id, p.name);
                    return (
                      <tr key={p.name}>
                        <td>{p.label || p.name}</td>
                        <td className="faint">
                          {p.dir === 'io' ? 'in/out' : p.dir}
                          {p.width > 1 ? ` · ${p.width}b` : ''}
                          {p.dir !== 'out' && !sim.connected(comp.id, p.name) ? ' · open' : ''}
                        </td>
                        <td className={v.w === 1 ? `v${formatBits(v, 'bin').toLowerCase()}` : ''}>{valueText(v)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
      <footer className="insp-foot">
        <button type="button" className="btn" onClick={() => live().commit(rotateComponent(live().circuit(), comp.id))}>
          <Icon name="rotate" size={15} /> Rotate
        </button>
        <button type="button" className="btn danger" onClick={() => live().removeSelection()}>
          <Icon name="trash" size={15} /> Delete
        </button>
      </footer>
    </>
  );
}

function CircuitInspector() {
  const circuit = useEditor((s) => s.circuit());
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const sim = useEditor((s) => s.sim);
  useEditor((s) => s.simRev);
  const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const selWires = selection.filter((id) => circuit.wires[id]);
  const selComps = selection.filter((id) => circuit.components[id]);

  if (selection.length === 1 && selWires.length === 1) {
    const w = circuit.wires[selWires[0]];
    const name = (id: string) => {
      const c = circuit.components[id];
      return c ? c.label || findDef(c.type)?.name || id : id;
    };
    const v = sim.wire(w.id);
    return (
      <>
        <header className="insp-head">
          <p className="eyebrow">Wire</p>
          <h2>
            {name(w.from.comp)} → {name(w.to.comp)}
          </h2>
          <p>Drag the wire to move its middle leg; double-click it to straighten.</p>
        </header>
        <div className="insp-body">
          <dl className="kv">
            <dt>Carries</dt>
            <dd className="mono">{sim.wireWidthError(w.id) ? <span className="ve">width mismatch</span> : v ? valueText(v) : '–'}</dd>
            <dt>Width</dt>
            <dd>{v ? `${v.w} bit${v.w === 1 ? '' : 's'}` : '–'}</dd>
          </dl>
        </div>
        <footer className="insp-foot">
          <button type="button" className="btn danger" onClick={() => live().removeSelection()}>
            <Icon name="trash" size={16} /> Delete wire
          </button>
        </footer>
      </>
    );
  }

  if (selection.length > 1) {
    return (
      <>
        <header className="insp-head">
          <p className="eyebrow">Selection</p>
          <h2>
            {selComps.length} part{selComps.length === 1 ? '' : 's'}, {selWires.length} wire{selWires.length === 1 ? '' : 's'}
          </h2>
        </header>
        <div className="insp-body">
          <button type="button" className="btn" onClick={() => live().rotateSelection()} disabled={!selComps.length}>
            <Icon name="rotate" size={16} /> Rotate each
          </button>
          <button type="button" className="btn" onClick={() => live().duplicate()} disabled={!selComps.length}>
            <Icon name="copy" size={16} /> Duplicate
          </button>
        </div>
        <footer className="insp-foot">
          <button type="button" className="btn danger" onClick={() => live().removeSelection()}>
            <Icon name="trash" size={16} /> Delete {selection.length} items
          </button>
        </footer>
      </>
    );
  }

  const { inputs, outputs } = portsOf(circuit);
  const dupes = duplicatePortLabels(circuit);
  const usedBy = project.circuits.filter((c) => Object.values(c.components).some((x) => x.type === `sub:${circuit.id}`)).map((c) => c.name);
  return (
    <>
      <header className="insp-head">
        <p className="eyebrow">Circuit</p>
        <h2>{circuit.name}</h2>
        <p>{circuit.id === project.main ? 'The main circuit of this project.' : 'Part of this project. Place it inside another circuit from Parts › Your circuits.'}</p>
      </header>
      <div className="insp-body">
        <dl className="kv">
          <dt>Parts</dt>
          <dd>{Object.keys(circuit.components).length}</dd>
          <dt>Wires</dt>
          <dd>{Object.keys(circuit.wires).length}</dd>
          <dt>Connections</dt>
          <dd>{inputs.length + outputs.length ? `${inputs.length} in, ${outputs.length} out` : 'none'}</dd>
          {usedBy.length > 0 && (
            <>
              <dt>Used in</dt>
              <dd>{usedBy.join(', ')}</dd>
            </>
          )}
          <dt>Signals</dt>
          <dd className={sim.oscillating ? 've' : ''}>{sim.oscillating ? 'oscillating' : `settled in ${sim.lastSettle.steps} delays`}</dd>
        </dl>
        {dupes.length > 0 && (
          <p className="callout warn" role="alert">
            {dupes.length === 1 ? `Two pins are labelled “${dupes[0]}”.` : `Several pins share labels: ${dupes.join(', ')}.`} Where this circuit is used as a part, the repeats get their part id added to stay separate. Give each pin its own label.
          </p>
        )}
        <div className="prop stack">
          <span className="prop-label">Getting around</span>
          <ul className="tips">
            {coarse ? (
              <>
                <li>Open the menu, tap a part, then tap the canvas to place it.</li>
                <li>Tap one pin, then another, to wire them.</li>
                <li>Tap switches to flip them; drag empty space to pan; pinch to zoom.</li>
              </>
            ) : (
              <>
                <li>Drag parts in from the sidebar, or press ⌘K to search.</li>
                <li>Drag from pin to pin to wire. Wires may join any pins; a net with several drivers resolves like a real bus.</li>
                <li>Click switches, input-pin bits and DIP switches to change them.</li>
                <li>Double-click a subcircuit to open it, or a RAM/ROM to edit it.</li>
              </>
            )}
          </ul>
        </div>
      </div>
    </>
  );
}

export function Inspector({ open, handle, onCollapse, onClose }: { open: boolean; handle: React.ReactNode; onCollapse: () => void; onClose: () => void }) {
  const selection = useEditor((s) => s.selection);
  const comp = useEditor((s) => (s.selection.length === 1 ? s.circuit().components[s.selection[0]] : undefined));
  return (
    <aside className={`inspector${open ? ' open' : ''}`} aria-label="Properties" data-testid="inspector">
      {handle}
      <div className="panel-head" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <h2>{comp ? 'Part' : selection.length ? 'Selection' : 'Circuit'}</h2>
        <button type="button" className="icon-btn hide-narrow" onClick={onCollapse} aria-label="Hide properties" title="Hide properties (])">
          <Icon name="chevronRight" size={16} />
        </button>
        <button type="button" className="icon-btn only-narrow" onClick={onClose} aria-label="Close properties">
          <Icon name="close" size={16} />
        </button>
      </div>
      {comp && selection.length === 1 && findDef(comp.type) ? <ComponentInspector key={comp.id} comp={comp} /> : <CircuitInspector />}
    </aside>
  );
}
