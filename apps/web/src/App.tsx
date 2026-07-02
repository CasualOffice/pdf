// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { CasualPdf, Icon, type Mode, type CasualPdfApi } from '@casualoffice/pdf';
import { MenuBar, type MenuDef } from './Menu';
import { SignDialog } from './SignDialog';
import { PageFurnitureDialog } from './PageFurnitureDialog';
import { saveSnapshot, loadSnapshot, clearSnapshot, relativeTime, type RecoverySnapshot } from './recovery';

const DEFAULT_PDF = 'https://snippet.embedpdf.com/ebook.pdf';

// Returns the URL from ?src= param, or null (welcome screen) when none is set.
function initialSrc(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URL(window.location.href).searchParams.get('src') || null;
  } catch {
    return null;
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
  const [src, setSrc] = useState<string | null>(initialSrc);
  const [title, setTitle] = useState('');
  const [dark, setDark] = useState(false);
  const [about, setAbout] = useState(false);
  const [signing, setSigning] = useState(false);
  const [pageFurniture, setPageFurniture] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [recovery, setRecovery] = useState<RecoverySnapshot | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const objectUrl = useRef<string | null>(null);
  const api = useRef<CasualPdfApi | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef(title);
  titleRef.current = title;
  const srcRef = useRef(src);
  srcRef.current = src;
  const snapshotTimer = useRef<number | null>(null);
  // Version undo/redo stack: blob URLs for doc-rebuild ops (redaction, organize,
  // text-edit). Annotation-level undo/redo is handled by EmbedPDF's history plugin.
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const revokeUrl = (url: string) => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); };
  const clearStack = (stack: { current: string[] }) => {
    stack.current.forEach(revokeUrl);
    stack.current = [];
  };

  // Crash recovery (UX-I5): on load, offer to restore the last unsaved session.
  useEffect(() => {
    void loadSnapshot().then((s) => { if (s) setRecovery(s); });
  }, []);

  // Autosave: debounce a full-bytes snapshot after edits settle (2.5s idle), so
  // a crash/close loses at most a couple of seconds of work.
  const cancelSnapshot = () => {
    if (snapshotTimer.current) {
      clearTimeout(snapshotTimer.current);
      snapshotTimer.current = null;
    }
  };
  const scheduleSnapshot = () => {
    cancelSnapshot();
    snapshotTimer.current = window.setTimeout(async () => {
      snapshotTimer.current = null;
      const bytes = await api.current?.getBytes();
      if (bytes && bytes.byteLength) {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        await saveSnapshot({ title: titleRef.current, bytes: ab, savedAt: Date.now() });
      }
    }, 2500);
  };
  const markEdited = () => {
    setDirty(true);
    scheduleSnapshot();
  };
  // Routes bytes from destructive ops (redaction, organize, text-edit) through a
  // new Blob URL → `src` prop change. This forces EmbedPDF to fully reinitialize
  // (including text geometry), fixing selection/search after those operations.
  // `openDocumentBuffer` skips that re-index step so is avoided here.
  // The old src is pushed to the version undo stack (not revoked) so Ctrl+Z can
  // restore it. Any pending redo history is discarded (new branch).
  const onDocumentReplaced = (bytes: Uint8Array) => {
    if (srcRef.current) undoStack.current.push(srcRef.current);
    clearStack(redoStack);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([buffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    objectUrl.current = url;
    setSrc(url);
    markEdited();
  };

  const versionUndo = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    if (srcRef.current) redoStack.current.push(srcRef.current);
    objectUrl.current = prev.startsWith('blob:') ? prev : null;
    setSrc(prev);
    setDirty(true);
    scheduleSnapshot(); // snapshot the restored state after viewer remounts
  };

  const versionRedo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    if (srcRef.current) undoStack.current.push(srcRef.current);
    objectUrl.current = next.startsWith('blob:') ? next : null;
    setSrc(next);
    setDirty(true);
    scheduleSnapshot();
  };

  useEffect(() => cancelSnapshot, []);

  const restoreRecovery = (snap: RecoverySnapshot) => {
    revokeObjectUrl();
    clearStack(undoStack);
    clearStack(redoStack);
    const url = URL.createObjectURL(new Blob([snap.bytes], { type: 'application/pdf' }));
    objectUrl.current = url;
    setSrc(url);
    setTitle(snap.title || 'Recovered document');
    setDirty(true); // recovered work isn't on disk yet — keep the unsaved guard
    setRecovery(null); // keep the snapshot itself until a clean Download
  };
  const discardRecovery = () => {
    setRecovery(null);
    void clearSnapshot();
  };

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
  useEffect(() => () => {
    revokeObjectUrl();
    clearStack(undoStack);
    clearStack(redoStack);
  }, []);

  // Warn before discarding unsaved edits (Open, Open-sample, tab close).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  const confirmDiscard = () =>
    !dirty ||
    window.confirm('You have unsaved changes that will be lost. Download first to keep them.\n\nDiscard changes and continue?');

  const openFromFile = (file: File) => {
    revokeObjectUrl();
    clearStack(undoStack);
    clearStack(redoStack);
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    setSrc(url);
    setTitle(file.name.replace(/\.pdf$/i, ''));
    setDirty(false);
    setMode('view');
  };
  const download = async () => {
    if (!src) return;
    // A clean save to disk supersedes the recovery snapshot.
    cancelSnapshot();
    void clearSnapshot();
    if (api.current) {
      api.current.download();
      setDirty(false);
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
        { label: 'Open…', shortcut: '⌘O', onSelect: () => { if (confirmDiscard()) fileRef.current?.click(); } },
        { label: 'Open sample', onSelect: () => { if (confirmDiscard()) { revokeObjectUrl(); clearStack(undoStack); clearStack(redoStack); setSrc(DEFAULT_PDF); setTitle('EmbedPDF sample'); setDirty(false); setMode('view'); } } },
        { divider: true },
        { label: 'Download', shortcut: '⌘S', onSelect: download },
        { label: 'Print / open in new tab', shortcut: '⌘P', onSelect: () => src && window.open(src, '_blank') },
        { divider: true },
        { label: 'Digitally sign…', onSelect: () => setSigning(true) },
        { label: 'Watermark / Header / Bates…', onSelect: () => setPageFurniture(true) },
        { divider: true },
        { label: 'About Casual PDF', onSelect: () => setAbout(true) },
      ],
    },
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'o') { e.preventDefault(); if (confirmDiscard()) fileRef.current?.click(); }
      else if (k === 's') { e.preventDefault(); download(); }
      else if (k === 'p') { e.preventDefault(); if (src) window.open(src, '_blank'); }
      else if (k === 'f' && !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) { e.preventDefault(); api.current?.openSearch(); }
      else if (k === 'z' && !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        // Two-level undo: annotation history first, then document-version undo.
        e.preventDefault();
        if (e.shiftKey) {
          if (api.current?.canRedo()) api.current.redo();
          else if (redoStack.current.length > 0) versionRedo();
        } else {
          if (api.current?.canUndo()) api.current.undo();
          else if (undoStack.current.length > 0) versionUndo();
        }
      }
      else if (k === 'y' && !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        e.preventDefault();
        if (api.current?.canRedo()) api.current.redo();
        else if (redoStack.current.length > 0) versionRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, title, dirty]);

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar__left">
          <MenuBar menus={menus} />
          <img className="appbar__logo" src="/logo.svg" alt="" width={26} height={26} />
          <input
            className="appbar__title"
            value={title}
            placeholder={src ? 'Untitled document' : 'No document open'}
            spellCheck={false}
            aria-label="Document name"
            readOnly={!src}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={(e) => src && e.target.select()}
          />
          {dirty && <span className="appbar__dirty" aria-label="Unsaved changes" title="Unsaved changes" />}
        </div>
        <div className="appbar__actions">
          <button
            type="button"
            className="appbar__quick"
            aria-label="Open PDF (⌘O)"
            title="Open PDF (⌘O)"
            onClick={() => { if (confirmDiscard()) fileRef.current?.click(); }}
          >
            <Icon name="open" size={15} />
            <span>Open</span>
          </button>
          {src && (
            <button
              type="button"
              className={`appbar__quick${dirty ? ' appbar__quick--save' : ''}`}
              aria-label={dirty ? 'Download — unsaved changes (⌘S)' : 'Download (⌘S)'}
              title={dirty ? 'Download — unsaved changes (⌘S)' : 'Download (⌘S)'}
              onClick={download}
            >
              <Icon name="download" size={15} />
              <span>{dirty ? 'Save' : 'Download'}</span>
            </button>
          )}
          {src && <span className="appbar__sep" aria-hidden="true" />}
          {src && <div className="modeseg" role="tablist" aria-label="Editing mode">
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
          </div>}
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

      {recovery && (
        <div className="recoverybar" role="status">
          <Icon name="refresh" size={16} />
          <span className="recoverybar__text">
            Unsaved changes from a previous session{recovery.title ? ` (“${recovery.title}”)` : ''} —{' '}
            {relativeTime(recovery.savedAt, Date.now())}.
          </span>
          <button type="button" className="recoverybar__btn recoverybar__btn--primary" onClick={() => restoreRecovery(recovery)}>
            Restore
          </button>
          <button type="button" className="recoverybar__btn" onClick={discardRecovery}>
            Discard
          </button>
        </div>
      )}

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

      <main
        className="canvas"
        onDragEnter={(e) => {
          e.preventDefault();
          dragCounterRef.current += 1;
          if (e.dataTransfer.types.includes('Files')) setDragOver(true);
        }}
        onDragLeave={() => {
          dragCounterRef.current -= 1;
          if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDragOver(false); }
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          dragCounterRef.current = 0;
          setDragOver(false);
          const file = Array.from(e.dataTransfer.files).find(
            (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
          );
          if (file && confirmDiscard()) openFromFile(file);
        }}
      >
        {src ? (
          <>
            {dragOver && (
              <div className="canvas__dropzone" aria-hidden="true">
                <div className="canvas__dropzone-inner">
                  <Icon name="open" size={36} />
                  <span>Drop PDF to open</span>
                </div>
              </div>
            )}
            <CasualPdf
              key={src}
              src={src}
              mode={mode}
              onModeChange={setMode}
              apiRef={api}
              onEdited={markEdited}
              onDocumentReplaced={onDocumentReplaced}
              onUndo={() => { if (api.current?.canUndo()) api.current.undo(); else versionUndo(); }}
              onRedo={() => { if (api.current?.canRedo()) api.current.redo(); else versionRedo(); }}
              className="viewer"
            />
          </>
        ) : (
          <div className={`welcome${dragOver ? ' welcome--drag' : ''}`} aria-label="Welcome to Casual PDF">
            <img src="/logo.svg" alt="" className="welcome__logo" width={56} height={56} />
            <div className="welcome__hero">
              <h1 className="welcome__title">Casual PDF</h1>
              <p className="welcome__sub">High-fidelity PDF viewer &amp; editor</p>
            </div>
            <div className="welcome__dropzone" role="button" tabIndex={0} aria-label="Open PDF — click or drop a file"
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}>
              <Icon name="open" size={32} />
              <span className="welcome__drop-label">Drop a PDF here</span>
              <span className="welcome__drop-hint">or click to browse</span>
            </div>
            <div className="welcome__actions">
              <button type="button" className="welcome__btn welcome__btn--primary" onClick={() => fileRef.current?.click()}>
                Open PDF
              </button>
              <button type="button" className="welcome__btn" onClick={() => { setSrc(DEFAULT_PDF); setTitle('EmbedPDF sample'); }}>
                Try sample
              </button>
            </div>
          </div>
        )}
      </main>

      {signing && <SignDialog api={api.current} title={title} onClose={() => setSigning(false)} />}
      {pageFurniture && (
        <PageFurnitureDialog
          api={api.current}
          onDocumentReplaced={onDocumentReplaced}
          onClose={() => setPageFurniture(false)}
        />
      )}

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
              <strong>Shortcuts</strong> — Open ⌘O · Save ⌘S · Find ⌘F · Undo ⌘Z · Redo ⌘⇧Z · Copy ⌘C · Paste ⌘V · Duplicate ⌘D · Select all ⌘A · Nudge ←↑↓→ (⇧ = bigger) · Tools: V H D T N R O A
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
