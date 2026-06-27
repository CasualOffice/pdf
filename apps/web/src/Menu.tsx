/**
 * A Google-Docs-style menu bar (File / View / Help …). One menu open at a time;
 * hovering switches between open menus. Accessible: each top button is a
 * `aria-haspopup` menu trigger, items are `role="menuitem"`, Escape closes.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItemDef {
  label?: string;
  shortcut?: string;
  onSelect?: () => void;
  disabled?: boolean;
  checked?: boolean;
  divider?: boolean;
}
export interface MenuDef {
  label: string;
  /** Optional icon shown instead of the label text (button keeps `label` as its
   *  accessible name). */
  icon?: ReactNode;
  items: MenuItemDef[];
}

export function MenuBar({ menus }: { menus: MenuDef[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="menubar" ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(null)}>
      {menus.map((m, i) => (
        <div className="menubar__menu" key={m.label}>
          <button
            type="button"
            className={m.icon ? 'menubar__btn menubar__btn--icon' : 'menubar__btn'}
            data-open={open === i ? 'true' : undefined}
            aria-haspopup="menu"
            aria-expanded={open === i}
            aria-label={m.label}
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.icon ?? m.label}
          </button>
          {open === i && (
            <div className="menubar__dropdown" role="menu" aria-label={m.label}>
              {m.items.map((it, j) =>
                it.divider ? (
                  <div className="menubar__divider" key={j} role="separator" />
                ) : (
                  <button
                    key={j}
                    type="button"
                    role="menuitem"
                    className="menubar__item"
                    data-checked={it.checked ? 'true' : undefined}
                    disabled={it.disabled}
                    onClick={() => {
                      it.onSelect?.();
                      setOpen(null);
                    }}
                  >
                    <span className="menubar__check" aria-hidden="true">
                      {it.checked && (
                        <svg width="15" height="15" viewBox="0 0 24 24" focusable="false">
                          <polyline
                            points="5 12.5 10 17.5 19 6.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </span>
                    <span className="menubar__item-label">{it.label}</span>
                    {it.shortcut && <span className="menubar__item-sc">{it.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
