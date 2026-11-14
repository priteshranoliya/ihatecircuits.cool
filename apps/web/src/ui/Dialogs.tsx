import { EXAMPLES } from '@ihatecircuits/core/examples';
import { useEditor } from '../state/store';
import { Modal } from './Modal';

export function ExamplesDialog() {
  const st = useEditor.getState();
  const topics = [...new Set(EXAMPLES.map((e) => e.topic))];
  return (
    <Modal title="Examples" onClose={() => st.setDialog(null)} wide testId="examples-dialog">
      <p className="muted" style={{ marginTop: 0 }}>
        Opening an example replaces what is on screen. Undo brings your work back.
      </p>
      {topics.map((t) => (
        <section key={t} className="ex-group">
          <h3>{t}</h3>
          <div className="ex-grid">
            {EXAMPLES.filter((e) => e.topic === t).map((e) => (
              <button
                key={e.id}
                type="button"
                className="ex-card"
                data-testid={`example-${e.id}`}
                onClick={() => {
                  st.setDialog(null);
                  st.loadExample(e.id);
                }}
              >
                <strong>{e.title}</strong>
                <span>{e.summary}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['⌘K', 'Search parts, actions and examples'],
  ['V · H · N', 'Select and wire · pan · add a note'],
  ['P', 'Add a part'],
  ['\\', 'Focus mode: hide both panels'],
  ['[ · ]', 'Show or hide the library · the properties'],
  ['Right-click', 'Actions for what is under the pointer'],
  ['Esc', 'Cancel, clear the selection, then leave a subcircuit'],
  ['Delete', 'Delete the selection'],
  ['⌘Z · ⌘⇧Z', 'Undo · redo'],
  ['R', 'Rotate the selected parts'],
  ['⌘C · ⌘X · ⌘V · ⌘D', 'Copy · cut · paste · duplicate'],
  ['⌘A', 'Select everything'],
  ['Arrows', 'Move the selection (⇧ for bigger steps)'],
  ['Space + drag, scroll', 'Pan'],
  ['⌘ + scroll, pinch', 'Zoom'],
  ['+ − 0', 'Zoom in · out · fit'],
  ['K', 'Step the clock one tick'],
  ['T', 'Analyze the circuit'],
  ['⌘S · ⌘O', 'Save · open a project file'],
];

export function HelpDialog() {
  const st = useEditor.getState();
  return (
    <Modal title="How iHateCircuits works" onClose={() => st.setDialog(null)} wide testId="help-dialog">
      <div className="help-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', gap: 28 }}>
        <div>
          <h3 className="eyebrow">Build</h3>
          <ul className="tips">
            <li>Drag a part from the sidebar onto the canvas, or press ⌘K and pick it. With the keyboard, focus a part in the list and press Enter.</li>
            <li>Drag from one pin to another to wire them, or click both. Wires join pins into one net; a net may have several drivers, which resolve like a real bus.</li>
            <li>Parts and wires carry 1 to 32 bits. Use a splitter to join single wires into a bus or break one apart; a tunnel connects to every tunnel with the same name.</li>
            <li>Every circuit in a project can be used inside another. Pin parts become its connections. Double-click a subcircuit to open it.</li>
          </ul>
          <h3 className="eyebrow" style={{ marginTop: 18 }}>Values</h3>
          <ul className="tips">
            <li>
              <b className="v1">1</b> and <b className="v0">0</b> are driven levels. <b className="vx">x</b> is unknown: driven, but undetermined (for example a latch that has not been set). <b className="vz">Z</b> is floating: nothing drives the wire.
            </li>
            <li>
              <b className="ve">Conflict</b> means two outputs drive the same wire to different levels, as in a real short circuit. A pull resistor gives a floating wire a default level.
            </li>
            <li>Thick dark wires are buses; their value is shown in hex on the wire. A dashed orange wire joins pins of different widths and carries nothing.</li>
          </ul>
          <h3 className="eyebrow" style={{ marginTop: 18 }}>Time</h3>
          <ul className="tips">
            <li>Every part has a propagation delay (one gate delay by default; change it per part). Unequal paths really glitch, and the Timing panel shows it.</li>
            <li>Run advances clocks continuously; Step advances one tick. Reset clears stored values. A loop that never settles is reported as oscillating and the parts involved are outlined in red.</li>
          </ul>
        </div>
        <div>
          <h3 className="eyebrow">Keyboard</h3>
          <table className="pin-table">
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td style={{ textAlign: 'left', fontFamily: 'var(--font)' }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="faint small" style={{ marginTop: 16 }}>
            Your work stays in this browser and is saved automatically; nothing is uploaded. iHateCircuits is an independent project inspired by classic educational logic simulators and shares no code, artwork or text with them.
          </p>
        </div>
      </div>
    </Modal>
  );
}
