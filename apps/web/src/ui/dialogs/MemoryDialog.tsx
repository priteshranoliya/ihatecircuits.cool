import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { updateComponent } from '@ihatecircuits/core/edit';
import { parseRomContents, ramContents, ramSetWord, type RamState } from '@ihatecircuits/core/parts/memory';
import { useEditor } from '../../state/store';
import { Icon } from '../icons';
import { Modal } from '../Modal';
import { downloadText, formatHex, hexDigits, parseHexWord, parseHexWords, safeFilename, scrollToReveal, visibleRows, wordsToText } from './dialogHelpers';
import './dialogs.css';

const ROW_H = 28;
const VIEW_H = 360;
const BODY_H = VIEW_H - ROW_H;

interface Editing {
  addr: number;
  draft: string;
}

export function MemoryDialog() {
  const target = useEditor((s) => s.memoryTarget);
  const circuit = useEditor((s) => s.circuit());
  const setDialog = useEditor((s) => s.setDialog);
  const comp = target ? circuit.components[target] : undefined;
  const kind = comp?.type === 'ram' ? 'ram' : comp?.type === 'rom' ? 'rom' : null;
  const label = comp?.label.trim() ?? '';
  const title = `${label ? `${label} ` : ''}${kind === 'ram' ? 'RAM' : kind === 'rom' ? 'ROM' : 'Memory'} contents`;
  return (
    <Modal title={title} wide testId="memory-dialog" onClose={() => setDialog(null)}>
      {comp && kind ? (
        <MemoryEditor
          key={comp.id}
          id={comp.id}
          kind={kind}
          label={label}
          addrBits={Number(comp.props.addrBits ?? (kind === 'ram' ? 8 : 4))}
          dataBits={Number(comp.props.dataBits ?? 8)}
          contents={String(comp.props.contents ?? '')}
        />
      ) : (
        <div className="dlg-empty">
          <strong>There is no RAM or ROM to show.</strong>
          <span>Select a RAM or ROM part and open its contents again.</span>
        </div>
      )}
    </Modal>
  );
}

function MemoryEditor({ id, kind, label, addrBits, dataBits, contents }: { id: string; kind: 'ram' | 'rom'; label: string; addrBits: number; dataBits: number; contents: string }) {
  const circuit = useEditor((s) => s.circuit());
  const sim = useEditor((s) => s.sim);
  useEditor((s) => (kind === 'ram' ? s.simRev : 0));
  const commit = useEditor((s) => s.commit);
  const setPartState = useEditor((s) => s.setPartState);
  const notify = useEditor((s) => s.notify);

  const size = 2 ** addrBits;
  const perRow = dataBits <= 8 ? 16 : 8;
  const rowCount = Math.ceil(size / perRow);
  const digits = hexDigits(dataBits);
  const addrDigits = hexDigits(addrBits);
  const cellW = digits * 9 + 24;

  const romWords = useMemo(() => (kind === 'rom' ? parseRomContents(contents, dataBits) : []), [kind, contents, dataBits]);
  const ramState = kind === 'ram' ? (sim.stateOf(id) as RamState | undefined) : undefined;
  const ramWords = useMemo(() => (ramState ? ramContents(ramState) : {}), [ramState]);
  const read = (a: number) => (kind === 'rom' ? romWords[a] : ramWords[a]) ?? 0;
  const unknownBits = (a: number) => ramState?.unk[a] ?? 0;

  const [active, setActive] = useState(0);
  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  const selectNext = useRef(false);
  const setEditing = (e: Editing | null) => {
    editingRef.current = e;
    setEditingState(e);
  };
  const [scrollTop, setScrollTop] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [goText, setGoText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const focusPending = useRef(false);

  const { start, end } = visibleRows(scrollTop, VIEW_H, ROW_H, rowCount);
  const activeRow = Math.floor(active / perRow);
  const activeRendered = activeRow >= start && activeRow < end;

  useLayoutEffect(() => {
    if (!focusPending.current) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-addr="${active}"]`);
    if (el) {
      focusPending.current = false;
      const input = el.querySelector('input');
      (input ?? el).focus();
    }
  });

  const moveTo = (addr: number, focus = true) => {
    const a = Math.min(size - 1, Math.max(0, addr));
    setActive(a);
    const st = scrollRef.current;
    if (st) {
      const next = scrollToReveal(Math.floor(a / perRow), st.scrollTop, BODY_H, ROW_H);
      if (next !== null) {
        st.scrollTop = next;
        setScrollTop(next);
      }
    }
    focusPending.current = focus;
  };

  const allWords = () => {
    if (kind === 'rom') return romWords.slice();
    const top = Math.max(-1, ...Object.keys(ramWords).map(Number));
    return Array.from({ length: top + 1 }, (_, i) => ramWords[i] ?? 0);
  };

  const replaceAll = (words: number[]) => {
    if (kind === 'rom') {
      commit(updateComponent(circuit, id, { props: { contents: wordsToText(words, dataBits, 0) } }));
    } else if (ramState) {
      const next: Record<number, number> = {};
      words.forEach((w, i) => w && (next[i] = w));
      setPartState(id, { ...ramState, words: next, unk: {} } satisfies RamState);
    }
  };

  const writeWord = (addr: number, value: number) => {
    if (kind === 'rom') {
      const words = romWords.slice();
      while (words.length <= addr) words.push(0);
      words[addr] = value;
      replaceAll(words);
    } else if (ramState) {
      setPartState(id, ramSetWord(ramState, addr, value));
    }
  };

  const begin = (addr: number, draft?: string) => {
    setStatus(null);
    setActive(addr);
    selectNext.current = draft === undefined;
    setEditing({ addr, draft: draft ?? formatHex(read(addr), dataBits) });
    focusPending.current = true;
  };

  const finish = (step: number | null, refocus = true) => {
    const cur = editingRef.current;
    if (!cur) return;
    const { addr, draft } = cur;
    if (draft.trim() !== '') {
      const v = parseHexWord(draft, dataBits);
      if (v === null) {
        setStatus('Use hex digits 0–9 and A–F.');
        return;
      }
      if (v !== read(addr) || unknownBits(addr)) writeWord(addr, v);
    }
    setEditing(null);
    setStatus(null);
    if (refocus) moveTo(step === null ? addr : addr + step);
    else if (step !== null) setActive(addr + step);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || e.ctrlKey || e.metaKey || e.altKey) return;
    const pageStep = Math.floor(BODY_H / ROW_H) * perRow;
    const key = e.key;
    const go = (addr: number) => {
      e.preventDefault();
      moveTo(addr);
    };
    if (key === 'ArrowRight') go(active + 1);
    else if (key === 'ArrowLeft') go(active - 1);
    else if (key === 'ArrowDown') go(active + perRow);
    else if (key === 'ArrowUp') go(active - perRow);
    else if (key === 'PageDown') go(active + pageStep);
    else if (key === 'PageUp') go(active - pageStep);
    else if (key === 'Home') go(e.shiftKey ? 0 : active - (active % perRow));
    else if (key === 'End') go(e.shiftKey ? size - 1 : active - (active % perRow) + perRow - 1);
    else if (key === 'Enter' || key === 'F2') {
      e.preventDefault();
      begin(active);
    } else if (key.length === 1 && /[0-9a-f]/i.test(key)) {
      e.preventDefault();
      begin(active, key.toUpperCase());
    }
  };

  const onEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      setEditing(null);
      setStatus(null);
      focusPending.current = true;
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      finish(e.shiftKey ? -1 : 1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      finish(e.key === 'ArrowDown' ? perRow : -perRow);
    }
  };

  const goTo = () => {
    const a = parseHexWord(goText, 53);
    if (a === null || a >= size) {
      setStatus(`Enter an address from 0 to ${formatHex(size - 1, addrBits)} in hex.`);
      return;
    }
    setStatus(null);
    setEditing(null);
    moveTo(a);
  };

  const load = async (file: File | undefined) => {
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      notify('That file could not be read.', 'error');
      return;
    }
    const parsed = parseHexWords(text, dataBits, size);
    if (parsed.bad) {
      notify(`Word ${parsed.bad.index + 1} of the file, “${parsed.bad.token.slice(0, 20)}”, is not hex. Nothing was loaded.`, 'error');
      return;
    }
    replaceAll(parsed.words);
    notify(`Loaded ${parsed.words.length} word${parsed.words.length === 1 ? '' : 's'}.${parsed.dropped ? ` ${parsed.dropped} extra word${parsed.dropped === 1 ? ' was' : 's were'} left out because the memory is full.` : ''}`);
  };

  const rowsOut = [];
  for (let r = start; r < end; r++) {
    const base = r * perRow;
    rowsOut.push(
      <div key={r} className="dlg-grid-row" role="row" aria-rowindex={r + 2}>
        <div className="dlg-addr" role="rowheader">
          {formatHex(base, addrBits)}
        </div>
        {Array.from({ length: Math.min(perRow, size - base) }, (_, k) => {
          const addr = base + k;
          const value = read(addr);
          const isEditing = editing?.addr === addr;
          const x = unknownBits(addr) !== 0;
          return (
            <div
              key={addr}
              role="gridcell"
              data-addr={addr}
              aria-label={`Address ${formatHex(addr, addrBits)}`}
              tabIndex={active === addr || (!activeRendered && addr === base && r === start) ? 0 : -1}
              className={`dlg-cell${value || x ? ' nz' : ''}${active === addr ? ' active' : ''}`}
              onClick={() => !isEditing && begin(addr)}
            >
              {isEditing ? (
                <input
                  aria-label={`Value at address ${formatHex(addr, addrBits)}, hex`}
                  className={/^[0-9a-f]*$/i.test(editing.draft) ? '' : 'invalid'}
                  value={editing.draft}
                  maxLength={digits}
                  spellCheck={false}
                  autoComplete="off"
                  onFocus={(e) => {
                    const n = e.target.value.length;
                    if (selectNext.current) e.target.select();
                    else e.target.setSelectionRange(n, n);
                    selectNext.current = false;
                  }}
                  onChange={(e) => setEditing({ addr, draft: e.target.value })}
                  onKeyDown={onEditKey}
                  onBlur={() => editingRef.current?.addr === addr && !focusPending.current && finish(null, false)}
                />
              ) : x ? (
                'x'.repeat(digits)
              ) : (
                formatHex(value, dataBits)
              )}
            </div>
          );
        })}
      </div>,
    );
  }

  return (
    <div className="dlg-stack">
      <div className="mem-meta">
        <span>
          {size.toLocaleString()} words × {dataBits} bits
        </span>
        <span>Address bits {addrBits}</span>
        <span>Data bits {dataBits}</span>
      </div>
      <p className="muted small">
        {kind === 'ram'
          ? 'Edits change the running simulation. RAM contents are cleared when the simulation resets.'
          : 'Edits change the ROM’s contents in the circuit, so you can undo them. Words you leave out read as 0.'}
      </p>

      <div className="dlg-row">
        <form
          className="dlg-row"
          onSubmit={(e) => {
            e.preventDefault();
            goTo();
          }}
        >
          <label className="dlg-label">
            Go to address (hex)
            <input className="field mem-go mono" value={goText} placeholder={formatHex(0, addrBits)} maxLength={addrDigits} spellCheck={false} onChange={(e) => setGoText(e.target.value)} />
          </label>
          <button type="submit" className="btn" style={{ alignSelf: 'end' }}>
            Go
          </button>
        </form>
        <span className="dlg-grow" />
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          <Icon name="open" size={15} /> Load…
        </button>
        <button type="button" className="btn" onClick={() => downloadText(`${safeFilename(label || kind)}-contents.txt`, `${wordsToText(allWords(), dataBits, perRow) || '0'}\n`)}>
          <Icon name="save" size={15} /> Save…
        </button>
        <button type="button" className="btn danger" onClick={() => replaceAll([])}>
          Clear all
        </button>
        <input ref={fileRef} type="file" accept=".txt,.hex,text/plain" hidden aria-label="Choose a file of hex words" onChange={(e) => {
          void load(e.target.files?.[0]);
          e.target.value = '';
        }} />
      </div>

      <div
        ref={scrollRef}
        className="dlg-grid"
        role="grid"
        aria-label={`${kind === 'ram' ? 'RAM' : 'ROM'} words in hex`}
        aria-rowcount={rowCount + 1}
        aria-colcount={perRow + 1}
        style={{ '--cw': `${cellW}px`, '--aw': `${addrDigits * 9 + 28}px` } as CSSProperties}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onGridKey}
      >
        <div className="dlg-grid-head" role="row" aria-rowindex={1} style={{ width: 'max-content' }}>
          <div className="dlg-addr" role="columnheader">
            Address
          </div>
          {Array.from({ length: perRow }, (_, k) => (
            <div key={k} className="dlg-cell" role="columnheader">
              +{k.toString(16).toUpperCase()}
            </div>
          ))}
        </div>
        <div style={{ paddingTop: start * ROW_H, paddingBottom: (rowCount - end) * ROW_H, width: 'max-content' }}>{rowsOut}</div>
      </div>
      <p className="faint small" role="status">
        {status ?? 'Click a word or press Enter to edit it. Arrow keys move, Tab and Enter save and go to the next word, Esc cancels.'}
      </p>
    </div>
  );
}
