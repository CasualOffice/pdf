// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

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
  // Tracks whether the last open was via keyboard, so we only pull focus into the
  // dropdown for keyboard users (a mouse hover-switch shouldn't steal focus).
  const keyboardOpenRef = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Move focus onto the first enabled item when a menu opens via keyboard.
  useEffect(() => {
    if (open === null || !keyboardOpenRef.current) return;
    menuItems()[0]?.focus();
  }, [open]);

  const menuItems = () =>
    Array.from(dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

  const openMenu = (i: number, viaKeyboard: boolean) => {
    keyboardOpenRef.current = viaKeyboard;
    setOpen(i);
  };
  const closeToTrigger = (i: number) => {
    setOpen(null);
    triggerRefs.current[i]?.focus();
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(i, true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); openMenu(i, true); }
    else if (e.key === 'ArrowRight' && menus.length > 1) { e.preventDefault(); openMenu((i + 1) % menus.length, true); }
    else if (e.key === 'ArrowLeft' && menus.length > 1) { e.preventDefault(); openMenu((i - 1 + menus.length) % menus.length, true); }
  };

  const onDropdownKeyDown = (e: React.KeyboardEvent, i: number) => {
    const items = menuItems();
    if (e.key === 'Escape') { e.preventDefault(); closeToTrigger(i); return; }
    if (e.key === 'Tab') { setOpen(null); return; } // let focus leave naturally
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'ArrowRight' && menus.length > 1) { e.preventDefault(); openMenu((i + 1) % menus.length, true); }
    else if (e.key === 'ArrowLeft' && menus.length > 1) { e.preventDefault(); openMenu((i - 1 + menus.length) % menus.length, true); }
  };

  return (
    <div className="menubar" ref={ref}>
      {menus.map((m, i) => (
        <div className="menubar__menu" key={m.label}>
          <button
            type="button"
            ref={(el) => { triggerRefs.current[i] = el; }}
            className={m.icon ? 'menubar__btn menubar__btn--icon' : 'menubar__btn'}
            data-open={open === i ? 'true' : undefined}
            aria-haspopup="menu"
            aria-expanded={open === i}
            aria-label={m.label}
            onClick={() => (open === i ? setOpen(null) : openMenu(i, false))}
            onKeyDown={(e) => onTriggerKeyDown(e, i)}
            onMouseEnter={() => open !== null && openMenu(i, false)}
          >
            {m.icon ?? m.label}
          </button>
          {open === i && (
            <div className="menubar__dropdown" role="menu" aria-label={m.label} ref={dropdownRef} onKeyDown={(e) => onDropdownKeyDown(e, i)}>
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
