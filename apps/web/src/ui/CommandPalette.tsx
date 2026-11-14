import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { EXAMPLES } from '@ihatecircuits/core/examples';
import { LIBRARY, type ComponentDef } from '@ihatecircuits/core/library';
import { canNest, subcircuitDef } from '@ihatecircuits/core/project';
import { newProjectAction, useEditor } from '../state/store';
import { canvasApi } from './Canvas';
import { openFilePicker, runExport, toggleTheme } from './Header';
import { Icon, type IconName } from './icons';
import { Modal } from './Modal';
import { PartIcon } from './parts';
import { saveProject } from '../export/exporters';

interface Item {
  id: string;
  group: 'Recent' | 'Parts' | 'Actions' | 'Circuits' | 'Examples';
  label: string;
  desc?: string;
  keywords: string;
  icon?: IconName;
  part?: string;
  run: () => void;
}

/** Simple fuzzy score: all query words must appear; earlier and label matches rank higher. */
function score(item: Item, words: string[]): number {
  let s = 0;
  const label = item.label.toLowerCase();
  const hay = `${label} ${item.keywords}`;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return -1;
    s += label.startsWith(w) ? 30 : label.includes(w) ? 15 : 5;
    s -= Math.min(i, 40) / 10;
  }
  return s;
}

export function CommandPalette() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const project = useEditor((s) => s.project);
  const active = useEditor((s) => s.active);
  const recents = useEditor((s) => s.recents);
  const st = useEditor.getState();
  const close = () => st.setDialog(null);

  const items = useMemo<Item[]>(() => {
    const place = (type: string) => () => {
      const c = canvasApi.centerWorld();
      useEditor.getState().place(type, c.x, c.y);
    };
    const partItem = (d: ComponentDef): Item => ({
      id: `part:${d.type}`,
      group: 'Parts',
      label: d.name,
      desc: d.category === 'Circuits' ? 'your circuit' : d.category,
      keywords: `${d.type} ${(d.keywords ?? []).join(' ')} ${d.description}`.toLowerCase(),
      part: d.type,
      run: place(d.type),
    });
    const subs = project.circuits.filter((c) => c.id !== active && canNest(project, active, c.id)).map((c) => partItem(subcircuitDef(c)));
    const act = (id: string, label: string, icon: IconName, run: () => void, keywords = ''): Item => ({ id, group: 'Actions', label, icon, run, keywords });
    return [
      ...[...LIBRARY.values()].map(partItem),
      ...subs,
      act('run', 'Run or pause the clock', 'play', () => st.setRunning(!useEditor.getState().running), 'start simulate'),
      act('step', 'Step one clock tick', 'step', st.step, 'tick advance'),
      act('reset', 'Reset the simulation', 'reset', st.resetSim, 'power on clear'),
      act('analyze', 'Analyze: truth table, K-map, expressions', 'table', () => st.setDialog('analysis'), 'karnaugh boolean minimise sop pos'),
      act('build', 'Build a circuit from an expression', 'chip', () => st.setDialog('build'), 'synthesize synthesis generate'),
      act('tests', 'Run test vectors', 'test', () => st.setDialog('tests'), 'check verify'),
      act('new-circuit', 'Add a circuit to this project', 'plus', () => st.newCircuit(), 'subcircuit module'),
      act('new', 'New project', 'file', newProjectAction),
      act('open', 'Open a project file', 'open', openFilePicker, 'load import json'),
      act('save', 'Save the project file', 'save', () => saveProject(useEditor.getState().project), 'download export json'),
      act('svg', 'Export SVG image', 'export', () => runExport('svg'), 'vector picture'),
      act('png', 'Export PNG image', 'export', () => runExport('png'), 'picture raster'),
      act('pdf', 'Export PDF document', 'export', () => runExport('pdf'), 'print report'),
      act('theme', 'Switch light or dark theme', 'moon', toggleTheme, 'dark mode appearance'),
      act('help', 'Help and keyboard shortcuts', 'help', () => st.setDialog('help'), 'shortcuts keys'),
      ...project.circuits.map((c) => ({ id: `circuit:${c.id}`, group: 'Circuits' as const, label: `Open ${c.name}`, icon: 'layers' as IconName, keywords: c.name.toLowerCase(), run: () => st.openCircuit(c.id) })),
      ...EXAMPLES.map((e) => ({ id: `ex:${e.id}`, group: 'Examples' as const, label: e.title, desc: e.topic, icon: 'book' as IconName, keywords: `${e.summary} ${e.topic}`.toLowerCase(), run: () => st.loadExample(e.id) })),
    ];
  }, [project, active]); // eslint-disable-line react-hooks/exhaustive-deps

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length
    ? items
        .map((it) => ({ it, s: score(it, words) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40)
        .map((x) => x.it)
    : [
        ...recents.map((t) => items.find((it) => it.part === t)).filter((it): it is Item => !!it).map((it) => ({ ...it, group: 'Recent' as const })),
        ...items.filter((it) => it.group === 'Actions'),
        ...items.filter((it) => ['and', 'or', 'not', 'switch', 'led', 'pin', 'splitter', 'dff', 'counter', 'mux'].includes(it.part ?? '') && !recents.includes(it.part!)),
      ].slice(0, 28);

  const choose = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(shown.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(shown[sel]);
    }
  };

  let lastGroup = '';
  return (
    <Modal title="Search" onClose={close} className="palette-dialog" testId="palette">
      <div className="palette-input" style={{ margin: '-16px -20px 0' }}>
        <Icon name="search" />
        <input
          data-autofocus
          value={q}
          placeholder="Find a part, action, circuit or example"
          aria-label="Search parts and actions"
          aria-controls="palette-list"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
        />
      </div>
      <div className="palette-list" id="palette-list" ref={listRef} role="listbox" style={{ margin: '0 -20px' }}>
        {shown.length === 0 && <p className="palette-empty">Nothing matches “{q}”.</p>}
        {shown.map((it, i) => {
          const header = it.group !== lastGroup ? it.group : null;
          lastGroup = it.group;
          return (
            <div key={it.id}>
              {header && <div className="palette-group">{header}</div>}
              <button
                type="button"
                role="option"
                aria-selected={i === sel}
                className={`palette-item${i === sel ? ' on' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(it)}
                data-testid={`palette-${it.id}`}
              >
                {it.part ? <PartIcon type={it.part} size={22} /> : <Icon name={it.icon ?? 'more'} size={18} />}
                <span>{it.label}</span>
                {it.desc && <span className="desc">{it.desc}</span>}
              </button>
            </div>
          );
        })}
      </div>
      <div className="palette-foot" style={{ margin: '0 -20px -20px' }}>
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> to move
        </span>
        <span>
          <kbd>↵</kbd> to choose
        </span>
        <span>
          <kbd>esc</kbd> to close
        </span>
      </div>
    </Modal>
  );
}
