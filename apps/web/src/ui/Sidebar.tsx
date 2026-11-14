import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { CATEGORIES, findDef, LIBRARY, type Category, type ComponentDef } from '@ihatecircuits/core/library';
import { canNest, subcircuitDef } from '@ihatecircuits/core/project';
import { useEditor } from '../state/store';
import { canvasApi } from './Canvas';
import { Icon } from './icons';
import { PartIcon } from './parts';

const CATEGORY_LABEL: Record<Category, string> = {
  Gates: 'Gates',
  Wiring: 'Wiring',
  Inputs: 'Inputs',
  Outputs: 'Outputs',
  Plexers: 'Multiplexers',
  Arithmetic: 'Arithmetic',
  Memory: 'Memory',
  Circuits: 'Your circuits',
  Notes: 'Notes',
};

interface Drag {
  type: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
  active: boolean;
}

/** Parts can be dragged onto the canvas, or clicked to arm and then placed with a canvas click. */
function usePartDrag(onPlaced?: () => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const ref = useRef<Drag | null>(null);
  useEffect(() => {
    if (!drag) return;
    const move = (e: globalThis.PointerEvent) => {
      const d = ref.current!;
      ref.current = { ...d, x: e.clientX, y: e.clientY, active: d.active || Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 6 };
      setDrag(ref.current);
    };
    const up = (e: globalThis.PointerEvent) => {
      const d = ref.current!;
      ref.current = null;
      setDrag(null);
      const st = useEditor.getState();
      if (!d.active) {
        st.setPlacing(st.placing === d.type ? null : d.type);
        onPlaced?.();
        return;
      }
      if (canvasApi.isOver(e.clientX, e.clientY)) {
        const p = canvasApi.clientToWorld(e.clientX, e.clientY)!;
        st.place(d.type, p.x, p.y);
        onPlaced?.();
      }
    };
    const cancel = () => {
      ref.current = null;
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (type: string) => (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('.fav')) return;
    e.preventDefault();
    ref.current = { type, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, active: false };
    setDrag(ref.current);
  };
  return { drag, start };
}

function PartButton({ def, onStart, onKey, grid }: { def: ComponentDef; onStart: (e: PointerEvent) => void; onKey: () => void; grid: boolean }) {
  const placing = useEditor((s) => s.placing);
  const fav = useEditor((s) => s.favorites.includes(def.type));
  return (
    <li>
      <button
        type="button"
        className={`part-item${placing === def.type ? ' armed' : ''}`}
        data-testid={`part-${def.type}`}
        title={`${def.name} — ${def.description}`}
        aria-pressed={placing === def.type}
        onPointerDown={onStart}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onKey();
          }
        }}
      >
        <PartIcon type={def.type} size={grid ? 34 : 22} />
        <span>{def.name}</span>
        {!def.subcircuit && (
          <span
            role="button"
            tabIndex={0}
            className={`fav${fav ? ' on' : ''}`}
            aria-label={fav ? `Remove ${def.name} from favourites` : `Add ${def.name} to favourites`}
            aria-pressed={fav}
            onClick={(e) => {
              e.stopPropagation();
              useEditor.getState().toggleFavorite(def.type);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                useEditor.getState().toggleFavorite(def.type);
              }
            }}
          >
            <Icon name="star" size={12} />
          </span>
        )}
      </button>
    </li>
  );
}

function CircuitList() {
  const project = useEditor((s) => s.project);
  const active = useEditor((s) => s.active);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const st = useEditor.getState();
  return (
    <section className="side-section" aria-label="Circuits" style={{ marginTop: 0 }}>
      <div className="side-head">
        <h2>Circuits</h2>
        <button type="button" className="icon-btn" onClick={() => st.newCircuit()} aria-label="Add a circuit" title="Add a circuit" data-testid="add-circuit">
          <Icon name="plus" size={15} />
        </button>
      </div>
      {project.circuits.map((c) =>
        editing === c.id ? (
          <form
            key={c.id}
            className="circuit-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) st.renameCircuit(c.id, draft.trim());
              setEditing(null);
            }}
          >
            <input
              className="field"
              autoFocus
              value={draft}
              aria-label="Circuit name"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft.trim() && draft.trim() !== c.name) st.renameCircuit(c.id, draft.trim());
                setEditing(null);
              }}
              onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
            />
          </form>
        ) : (
          <div key={c.id} className="circuit-row">
            <button type="button" className={`nav-item${c.id === active ? ' active' : ''}`} onClick={() => st.openCircuit(c.id)} onDoubleClick={() => (setDraft(c.name), setEditing(c.id))} data-testid={`circuit-${c.id}`}>
              <Icon name="layers" size={15} />
              <span className="grow">{c.name}</span>
              {c.id === project.main && <span className="tag">main</span>}
            </button>
            <div className="row-actions">
              <button type="button" className="icon-btn" aria-label={`Rename ${c.name}`} title="Rename" onClick={() => (setDraft(c.name), setEditing(c.id))}>
                <Icon name="pencil" size={14} />
              </button>
              {c.id !== project.main && (
                <>
                  <button type="button" className="icon-btn" aria-label={`Make ${c.name} the main circuit`} title="Make main (opens first)" onClick={() => st.setMain(c.id)}>
                    <Icon name="star" size={14} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Delete ${c.name}`} title="Delete" onClick={() => st.deleteCircuit(c.id)}>
                    <Icon name="trash" size={14} />
                  </button>
                </>
              )}
            </div>
          </div>
        ),
      )}
    </section>
  );
}

/** Drag the panel edge to resize; the width persists per device. */
export function useResizable(key: string, initial: number, min: number, max: number, side: 'left' | 'right') {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return v >= min && v <= max ? v : initial;
    } catch {
      return initial;
    }
  });
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setDragging(true);
    const move = (ev: globalThis.PointerEvent) => {
      const dx = (ev.clientX - startX) * (side === 'left' ? 1 : -1);
      setWidth(Math.min(max, Math.max(min, startW + dx)));
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidth((w) => {
        try {
          localStorage.setItem(key, String(w));
        } catch {
          /* convenience only */
        }
        return w;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const handle = <div className={`resize-handle${dragging ? ' dragging' : ''}`} onPointerDown={onPointerDown} role="separator" aria-orientation="vertical" aria-label="Resize panel" />;
  return { width, handle };
}

export function Sidebar({ open, onClose, onCollapse, handle }: { open: boolean; onClose: () => void; onCollapse: () => void; handle: React.ReactNode }) {
  const project = useEditor((s) => s.project);
  const active = useEditor((s) => s.active);
  const favorites = useEditor((s) => s.favorites);
  const recents = useEditor((s) => s.recents);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['Gates', 'Inputs', 'Outputs']));
  const [query, setQuery] = useState('');
  const [grid, setGrid] = useState(() => {
    try {
      return localStorage.getItem('ihatecircuits:libview') === 'grid';
    } catch {
      return false;
    }
  });
  const { drag, start } = usePartDrag(onClose);
  const st = useEditor.getState();

  const byCat = new Map<Category, ComponentDef[]>();
  for (const d of LIBRARY.values()) byCat.set(d.category, [...(byCat.get(d.category) ?? []), d]);
  const subs = project.circuits.filter((c) => c.id !== active && canNest(project, active, c.id)).map((c) => subcircuitDef(c));
  byCat.set('Circuits', subs);
  const all = [...LIBRARY.values(), ...subs];

  const placeAtCenter = (type: string) => {
    const c = canvasApi.centerWorld();
    st.place(type, c.x, c.y);
    onClose();
  };
  const toggle = (cat: string) => {
    const next = new Set(expanded);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    setExpanded(next);
  };
  const setView = (g: boolean) => {
    setGrid(g);
    try {
      localStorage.setItem('ihatecircuits:libview', g ? 'grid' : 'list');
    } catch {
      /* convenience only */
    }
  };
  const list = (defs: ComponentDef[]) => (
    <ul className={grid ? 'part-grid' : 'part-list'}>
      {defs.map((d) => (
        <PartButton key={d.type} def={d} grid={grid} onStart={start(d.type)} onKey={() => placeAtCenter(d.type)} />
      ))}
    </ul>
  );

  const q = query.trim().toLowerCase();
  const matches = q ? all.filter((d) => `${d.name} ${d.type} ${(d.keywords ?? []).join(' ')} ${d.category}`.toLowerCase().includes(q)) : [];
  const favDefs = favorites.map((t) => findDef(t)).filter((d): d is ComponentDef => !!d);
  const recentDefs = recents.map((t) => findDef(t)).filter((d): d is ComponentDef => !!d && !d.subcircuit).slice(0, 6);

  return (
    <aside className={`library${open ? ' open' : ''}`} aria-label="Library">
      {handle}
      <div className="panel-head">
        <h2>Library</h2>
        <div className="seg" role="radiogroup" aria-label="Parts view">
          <button type="button" role="radio" aria-checked={!grid} className={!grid ? 'on' : ''} onClick={() => setView(false)} aria-label="List view" title="List">
            <Icon name="menu" size={13} />
          </button>
          <button type="button" role="radio" aria-checked={grid} className={grid ? 'on' : ''} onClick={() => setView(true)} aria-label="Grid view" title="Grid">
            <Icon name="grid" size={13} />
          </button>
        </div>
        <button type="button" className="icon-btn hide-narrow" onClick={onCollapse} aria-label="Hide library" title="Hide library ([)">
          <Icon name="chevronLeft" size={16} />
        </button>
        <button type="button" className="icon-btn only-narrow" onClick={onClose} aria-label="Close library">
          <Icon name="close" size={16} />
        </button>
      </div>
      <label className="lib-search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="Filter parts" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter parts" data-testid="lib-filter" />
      </label>
      <div className="side-scroll">
        {q ? (
          <section className="side-section" style={{ marginTop: 0 }}>
            <div className="side-head">
              <h2>{matches.length ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : 'No matches'}</h2>
            </div>
            {matches.length ? list(matches) : <p className="faint small" style={{ padding: '0 8px' }}>Try another word, or press ⌘K to search actions too.</p>}
          </section>
        ) : (
          <>
            <CircuitList />
            {favDefs.length > 0 && (
              <section className="side-section">
                <div className="side-head">
                  <h2>Favourites</h2>
                </div>
                {list(favDefs)}
              </section>
            )}
            {recentDefs.length > 0 && (
              <section className="side-section">
                <div className="side-head">
                  <h2>Recent</h2>
                </div>
                {list(recentDefs)}
              </section>
            )}
            <section className="side-section" aria-label="Parts">
              <div className="side-head">
                <h2>Parts</h2>
              </div>
              {CATEGORIES.map((cat) => {
                const items = byCat.get(cat) ?? [];
                if (cat === 'Circuits' && items.length === 0) return null;
                const isOpen = expanded.has(cat);
                return (
                  <div key={cat}>
                    <button type="button" className="nav-item" aria-expanded={isOpen} onClick={() => toggle(cat)} data-testid={`cat-${cat}`}>
                      <span className={`chev${isOpen ? ' open' : ''}`}>
                        <Icon name="chevronRight" size={13} />
                      </span>
                      <span>{CATEGORY_LABEL[cat]}</span>
                      <span className="count">{items.length}</span>
                    </button>
                    {isOpen && list(items)}
                  </div>
                );
              })}
            </section>
          </>
        )}
      </div>
      <div className="lib-foot">
        <button type="button" className="nav-item" onClick={() => (st.setDialog('examples'), onClose())} data-testid="open-examples">
          <Icon name="book" size={15} />
          <span>Examples</span>
        </button>
        <button type="button" className="nav-item" onClick={() => (st.setDialog('help'), onClose())} data-testid="help">
          <Icon name="help" size={15} />
          <span>Help and shortcuts</span>
          <kbd style={{ marginLeft: 'auto' }}>?</kbd>
        </button>
      </div>
      {drag?.active && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          <PartIcon type={drag.type} size={56} />
        </div>
      )}
    </aside>
  );
}
