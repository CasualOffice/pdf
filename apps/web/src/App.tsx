// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { CasualPdf, Icon, type Mode, type CasualPdfApi } from '@casualoffice/pdf';
import { MenuBar, type MenuDef } from './Menu';

const DEFAULT_PDF = 'https://snippet.embedpdf.com/ebook.pdf';

function initialSrc(): string {
  if (typeof window === 'undefined') return DEFAULT_PDF;
  try {
    return new URL(window.location.href).searchParams.get('src') || DEFAULT_PDF;
  } catch {
    return DEFAULT_PDF;
  }
}

const MODES: { id: Mode; label: string; icon: 'eye' | 'suggest' | 'pencil' }[] = [
  { id: 'view', label: 'View', icon: 'eye' },
  { id: 'suggest', label: 'Suggest', icon: 'suggest' },
  { id: 'edit', label: 'Edit', icon: 'pencil' },
];

/**
 * Professional PDF-editor shell: a slim top bar (menu + title + mode switch +
 * theme), with the tool rail / properties panel / view bar living inside the
 * @casualoffice/pdf viewer. Open/Download/Print + theme are host concerns here.
 */
export function App() {
  const [mode, setMode] = useState<Mode>('view');
  const [src, setSrc] = useState(initialSrc);
  const [title, setTitle] = useState('Untitled document');
  const [dark, setDark] = useState(false);
  const [about, setAbout] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const objectUrl = useRef<string | null>(null);
  const api = useRef<CasualPdfApi | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : '';
  }, [dark]);

  // About dialog: ARIA modal behavior — move focus in on open, Escape to
  // close, trap Tab (the dialog has a single focusable), restore focus on close.
  useEffect(() => {
    if (!about) return;
    const opener = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setAbout(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        closeBtnRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const restore =
        opener && opener !== document.body && opener.isConnected
          ? opener
          : document.querySelector<HTMLElement>('[aria-label="Menu"]');
      restore?.focus();
    };
  }, [about]);
  const revokeObjectUrl = () => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  };
  useEffect(() => revokeObjectUrl, []);

  const openFromFile = (file: File) => {
    revokeObjectUrl();
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    setSrc(url);
    setTitle(file.name.replace(/\.pdf$/i, ''));
  };
  const download = async () => {
    if (api.current) {
      api.current.download();
      return;
    }
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = /\.pdf$/i.test(title) ? title : `${title}.pdf`;
      // Append to the DOM (Firefox requires it) and revoke after the click is
      // dispatched, not synchronously (which can cancel the download).
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      window.open(src, '_blank');
    }
  };

  const menus: MenuDef[] = [
    {
      label: 'Menu',
      icon: <Icon name="menu" size={18} />,
      items: [
        { label: 'Open…', shortcut: '⌘O', onSelect: () => fileRef.current?.click() },
        { label: 'Open sample', onSelect: () => { revokeObjectUrl(); setSrc(DEFAULT_PDF); setTitle('EmbedPDF sample'); } },
        { divider: true },
        { label: 'Download', shortcut: '⌘S', onSelect: download },
        { label: 'Print / open in new tab', shortcut: '⌘P', onSelect: () => window.open(src, '_blank') },
        { divider: true },
        { label: 'About Casual PDF', onSelect: () => setAbout(true) },
      ],
    },
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'o') { e.preventDefault(); fileRef.current?.click(); }
      else if (k === 's') { e.preventDefault(); download(); }
      else if (k === 'p') { e.preventDefault(); window.open(src, '_blank'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, title]);

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar__left">
          <MenuBar menus={menus} />
          <img className="appbar__logo" src="/logo.svg" alt="" width={26} height={26} />
          <input
            className="appbar__title"
            value={title}
            spellCheck={false}
            aria-label="Document name"
            onChange={(e) => setTitle(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </div>
        <div className="appbar__actions">
          <div className="modeseg" role="tablist" aria-label="Editing mode">
            {MODES.map(({ id, label, icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mode === id}
                aria-label={`${label} mode`}
                title={`${label} mode`}
                className="modeseg__btn"
                data-active={mode === id ? 'true' : undefined}
                onClick={() => setMode(id)}
              >
                <Icon name={icon} filled={mode === id} size={16} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="appbar__icon"
            aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-pressed={dark}
            onClick={() => setDark((v) => !v)}
          >
            <Icon name={dark ? 'sun' : 'moon'} size={18} />
          </button>
          <div className="appbar__avatar" aria-hidden="true">S</div>
        </div>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openFromFile(f);
          e.target.value = '';
        }}
      />

      <main className="canvas">
        <CasualPdf key={src} src={src} mode={mode} onModeChange={setMode} apiRef={api} className="viewer" />
      </main>

      {about && (
        <div className="dialog__scrim" role="presentation" onClick={() => setAbout(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="About Casual PDF" onClick={(e) => e.stopPropagation()}>
            <img src="/logo.svg" alt="" width={48} height={48} />
            <h2 className="dialog__title">Casual PDF</h2>
            <p className="dialog__body">
              A high-fidelity PDF viewer &amp; editor — one PDFium engine across web and desktop, with annotation,
              e-signing, and granular rights.
            </p>
            <p className="dialog__shortcuts">
              <strong>Shortcuts</strong> — Open ⌘O · Save ⌘S · Undo ⌘Z · Redo ⌘⇧Z · Copy ⌘C · Paste ⌘V · Duplicate ⌘D · Select all ⌘A · Nudge ←↑↓→ (⇧ = bigger) · Find (top-right) · Tools: V H D T N R O A
            </p>
            <button ref={closeBtnRef} type="button" className="dialog__close" onClick={() => setAbout(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
