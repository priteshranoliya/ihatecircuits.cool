import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { setWireMid } from '@ihatecircuits/core/edit';
import { findDef } from '@ihatecircuits/core/library';
import { subTarget } from '@ihatecircuits/core/project';
import { useEditor } from '../state/store';
import { fit } from './CanvasChrome';
import { Icon, type IconName } from './icons';

interface Item {
  label: string;
  icon: IconName;
  hint?: string;
  run: () => void;
  danger?: boolean;
}

/** Right-click menu scoped to what was clicked; each item shows its shortcut. */
export function ContextMenu() {
  const menu = useEditor((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const close = () => useEditor.getState().setMenu(null);

  useEffect(() => {
    if (!menu) return;
    const out = (e: Event) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
        const i = els.indexOf(document.activeElement as HTMLElement);
        els[(i + (e.key === 'ArrowDown' ? 1 : els.length - 1)) % els.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', out);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', out);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(menu.x, window.innerWidth - r.width - 8), y: Math.min(menu.y, window.innerHeight - r.height - 8) });
    ref.current.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  }, [menu]);

  if (!menu) return null;
  const st = useEditor.getState();
  const c = st.circuit();
  const comp = menu.target ? c.components[menu.target] : undefined;
  const wire = menu.target ? c.wires[menu.target] : undefined;
  const groups: Item[][] = [];

  if (comp) {
    const sub = subTarget(comp.type);
    const def = findDef(comp.type);
    const open: Item[] = [];
    if (sub) open.push({ label: `Open “${def?.name}”`, icon: 'layers', hint: '2× click', run: () => st.enterCircuit(sub) });
    if (comp.type === 'ram' || comp.type === 'rom') open.push({ label: 'Edit contents…', icon: 'memory', hint: '2× click', run: () => st.setDialog('memory', comp.id) });
    if (open.length) groups.push(open);
    groups.push([
      { label: 'Rotate', icon: 'rotate', hint: 'R', run: st.rotateSelection },
      { label: 'Duplicate', icon: 'copy', hint: '⌘D', run: st.duplicate },
      { label: 'Copy', icon: 'copy', hint: '⌘C', run: st.copy },
      { label: 'Cut', icon: 'copy', hint: '⌘X', run: st.cut },
    ]);
    if (def && !def.subcircuit) {
      const fav = st.favorites.includes(comp.type);
      groups.push([{ label: fav ? `Remove ${def.name} from favourites` : `Add ${def.name} to favourites`, icon: 'star', run: () => st.toggleFavorite(comp.type) }]);
    }
    groups.push([{ label: st.selection.length > 1 ? `Delete ${st.selection.length} items` : 'Delete', icon: 'trash', hint: 'Del', run: st.removeSelection, danger: true }]);
  } else if (wire) {
    groups.push([
      ...(wire.mid !== undefined ? [{ label: 'Straighten', icon: 'arrowUp' as IconName, hint: '2× click', run: () => st.commit(setWireMid(st.circuit(), wire.id, undefined)) }] : []),
      { label: 'Delete wire', icon: 'trash', hint: 'Del', run: st.removeSelection, danger: true },
    ]);
  } else {
    groups.push([
      { label: 'Add a part…', icon: 'plus', hint: 'P', run: () => st.setDialog('palette') },
      { label: 'Paste', icon: 'copy', hint: '⌘V', run: st.paste },
      { label: 'Select all', icon: 'pointer', hint: '⌘A', run: st.selectAll },
    ]);
    groups.push([
      { label: 'Fit circuit', icon: 'fit', hint: '0', run: fit },
      { label: 'Analyze circuit…', icon: 'table', hint: 'T', run: () => st.setDialog('analysis') },
    ]);
  }

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label="Actions"
      data-testid="context-menu"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
    >
      {groups.map((g, gi) => (
        <div key={gi} style={{ display: 'contents' }}>
          {gi > 0 && <hr />}
          {g.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? 'danger' : undefined}
              onClick={() => {
                close();
                it.run();
              }}
            >
              <Icon name={it.icon} size={15} />
              <span>{it.label}</span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
