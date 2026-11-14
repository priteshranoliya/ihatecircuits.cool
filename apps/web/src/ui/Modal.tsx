import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './icons';

/**
 * Accessible modal built on <dialog>: focus is trapped by the browser, Esc
 * and clicks on the backdrop close it.
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
  testId,
  className,
  headerExtra,
  tabs,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  testId?: string;
  className?: string;
  headerExtra?: ReactNode;
  /** Optional tab strip under the header. */
  tabs?: { value: string; label: string }[] & { active?: string; onChange?: (v: string) => void };
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    // showModal() focuses the first focusable element (usually Close); honour an explicit choice instead.
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`}
      aria-label={title}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <header className="modal-head">
        <h2>{title}</h2>
        {headerExtra}
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>
      {tabs && (
        <nav className="modal-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.value} type="button" role="tab" aria-selected={tabs.active === t.value} className={tabs.active === t.value ? 'on' : ''} onClick={() => tabs.onChange?.(t.value)}>
              {t.label}
            </button>
          ))}
        </nav>
      )}
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

/** Tab definitions helper so callers can pass active/onChange alongside the list. */
export function tabsOf(list: { value: string; label: string }[], active: string, onChange: (v: string) => void) {
  return Object.assign([...list], { active, onChange });
}
