// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { CasualPdf, Icon, type Mode, type CasualPdfApi } from '@casualoffice/pdf';
import { signPdf } from '@casualoffice/pdf/sign';
import { AiPanel } from '@casualoffice/pdf/ai';
import { MenuBar, type MenuDef } from './Menu';
import { SignDialog } from './SignDialog';
import { SignatureInfoDialog } from './SignatureInfoDialog';
import { PageFurnitureDialog } from './PageFurnitureDialog';
import { saveSnapshot, loadSnapshot, clearSnapshot, relativeTime, type RecoverySnapshot } from './recovery';
import { isDesktop } from './desk-bridge-bootstrap';

const DEFAULT_PDF = 'https://snippet.embedpdf.com/ebook.pdf';
// Collab mode: the AI connects to a collab server's /api/ai (the server env —
// LLM_ENDPOINT/LLM_API_KEY — picks the provider). Set at deploy time; when unset
// the AI runs in desktop mode (the shell's local model) only.
const COLLAB_WS_URL = import.meta.env.VITE_COLLAB_WS_URL as string | undefined;

type SignatureStatus = 'certified' | 'signed' | 'unsigned' | 'unknown';

function bytesInclude(bytes: Uint8Array, ascii: string): boolean {
  const needle = new TextEncoder().encode(ascii);
  outer:
  for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}


// A *visible* signature is a stamp annotation, not a cryptographic signature.
// Detect only stamp subtypes here — NOT the generic `/Type/Annot`, which every
// PDF with a link/form field/comment carries and would falsely badge as signed.
// (This still can't distinguish a signature stamp from an inserted-image stamp;
// the reliable trust signal is hasPdfSignature, the certified badge.)
function hasVisibleSignatureBytes(bytes: Uint8Array): boolean {
  return (
    bytesInclude(bytes, '/Subtype/Stamp') ||
    bytesInclude(bytes, '/Subtype /Stamp')
  );
}

function titleFromSrc(value: string | null): string {
  if (!value) return '';
  if (value.startsWith('blob:')) return 'Untitled document';
  try {
    const url = new URL(value, typeof window === 'undefined' ? 'http://localhost' : window.location.href);
    const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    return (last || url.hostname || 'PDF document').replace(/\.pdf$/i, '') || 'PDF document';
  } catch {
    const last = value.split(/[\\/]/).filter(Boolean).pop() || value;
    return decodeURIComponent(last).replace(/\.pdf$/i, '') || 'PDF document';
  }
}

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
  const [title, setTitle] = useState(() => titleFromSrc(initialSrc()));
  const [dark, setDark] = useState(false);
  const [about, setAbout] = useState(false);
  const [sigInfo, setSigInfo] = useState(false);
  const [certSigning, setCertSigning] = useState(false);
  const [signBusy, setSignBusy] = useState(false);
  const [pendingVisibleSignature, setPendingVisibleSignature] = useState(false);
  const [pageFurniture, setPageFurniture] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [signatureStatus, setSignatureStatus] = useState<SignatureStatus>('unknown');
  const [recovery, setRecovery] = useState<RecoverySnapshot | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const insertFileRef = useRef<HTMLInputElement>(null);
  const objectUrl = useRef<string | null>(null);
  const api = useRef<CasualPdfApi | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  // True inside the Casual Office desktop shell (?desk=1). Routes Open/Save and
  // the initial document load through the native Tauri bridge instead of the
  // browser file picker / <a download>. A no-op in a plain browser.
  const desktop = isDesktop();
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
  // Bound the version history so a long redact/organize/text-edit session can't
  // grow blob-URL memory without limit. Evicted (oldest) URLs are revoked.
  const MAX_VERSIONS = 20;
  const pushVersion = (stack: { current: string[] }, url: string) => {
    stack.current.push(url);
    while (stack.current.length > MAX_VERSIONS) {
      const dropped = stack.current.shift();
      if (dropped) revokeUrl(dropped);
    }
  };

  // Crash recovery (UX-I5): on load, offer to restore the last unsaved session.
  // Skipped on desktop — there the native shell owns crash recovery (its sidecar);
  // wiring the web bytes-snapshot to __deskApp__ recovery is a follow-up.
  useEffect(() => {
    if (desktop) return;
    void loadSnapshot().then((s) => { if (s) setRecovery(s); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Desktop: load the file the shell bound to this window (?file=) via the native
  // bridge (chunked read), bypassing the welcome screen. Runs once on mount.
  useEffect(() => {
    if (!desktop) return;
    const bridge = window.__deskApp__;
    if (!bridge?.filePath) { bridge?.dismissBoot(); return; }
    let cancelled = false;
    void (async () => {
      try {
        const buf = await bridge.loadDocument();
        if (cancelled) return;
        const url = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
        objectUrl.current = url;
        setSrc(url);
        setTitle(bridge.filePath!.split(/[/\\]/).pop()!.replace(/\.pdf$/i, ''));
        setMode('view');
        setDirty(false);
      } catch (e) {
        console.error('desktop load failed', e);
      } finally {
        bridge.dismissBoot();
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Desktop: follow the shell's theme (initial ?theme= + live deskapp:theme events).
  useEffect(() => {
    if (!desktop) return;
    const initial = window.__deskApp__?.theme;
    if (initial) setDark(initial === 'dark');
    const onTheme = (e: Event) => {
      const resolved = (e as CustomEvent<{ resolved?: 'light' | 'dark' }>).detail?.resolved;
      if (resolved) setDark(resolved === 'dark');
    };
    window.addEventListener('deskapp:theme', onTheme);
    return () => window.removeEventListener('deskapp:theme', onTheme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (desktop) return; // desktop recovery uses the native sidecar (follow-up), not IndexedDB
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
    if (desktop) window.__deskApp__?.setDirty(true);
    scheduleSnapshot();
  };
  // Routes bytes from destructive ops (redaction, organize, text-edit) through a
  // new Blob URL → `src` prop change. This forces EmbedPDF to fully reinitialize
  // (including text geometry), fixing selection/search after those operations.
  // `openDocumentBuffer` skips that re-index step so is avoided here.
  // The old src is pushed to the version undo stack (not revoked) so Ctrl+Z can
  // restore it. Any pending redo history is discarded (new branch).
  const onDocumentReplaced = (bytes: Uint8Array) => {
    if (srcRef.current) pushVersion(undoStack, srcRef.current);
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
    if (srcRef.current) pushVersion(redoStack, srcRef.current);
    objectUrl.current = prev.startsWith('blob:') ? prev : null;
    setSrc(prev);
    markEdited(); // marks dirty, propagates to the desktop shell, and snapshots (web)
  };

  const versionRedo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    if (srcRef.current) pushVersion(undoStack, srcRef.current);
    objectUrl.current = next.startsWith('blob:') ? next : null;
    setSrc(next);
    markEdited(); // marks dirty, propagates to the desktop shell, and snapshots (web)
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
    setRecovery(null); // dismiss any stale recovery banner from the prior session
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    setSrc(url);
    setTitle(file.name.replace(/\.pdf$/i, ''));
    setDirty(false);
    setMode('view');
  };
  // Open a print-ready blob in a new tab so the browser's native print dialog
  // can be used. Bakes annotations first (same as Download) so annotations
  // are included. Revokes the URL after 30 s (enough for the browser to load).
  const printPdf = async () => {
    if (!src) return;
    // Print via a browser tab is a web-only path — in the Tauri shell a blob: URL
    // won't resolve in an external browser and would leak a savable PDF tab that
    // bypasses native Save. Native print-to-PDF is a follow-up; no-op for now.
    if (desktop) return;
    // Open the tab synchronously inside the click gesture — deferring window.open
    // until after `await getBytes()` puts it outside the gesture, where pop-up
    // blockers silently block it. We navigate the already-open tab once ready.
    const win = window.open('', '_blank');
    if (!win) {
      alert('Your browser blocked the print tab. Allow pop-ups for this site, or use Download instead.');
      return;
    }
    try {
      const bytes = api.current ? await api.current.getBytes() : null;
      if (bytes) {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const blob = new Blob([ab], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        win.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } else {
        win.location.href = src;
      }
    } catch {
      win.location.href = src; // fall back to the raw source on a bake failure
    }
  };

  // On desktop, "downloading" a produced file (signed PDF, etc.) must not use a
  // browser <a download> (forbidden in the shell) — route it through the native
  // Save-As dialog instead. In a browser this is the normal anchor download.
  const downloadBlob = (blob: Blob, filename: string) => {
    if (desktop && window.__deskApp__) {
      void blob.arrayBuffer().then((buf) => window.__deskApp__!.saveAs(filename, buf)).catch((e) => {
        console.error('desktop saveAs failed', e);
      });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const download = async () => {
    if (!src) return;
    // Desktop: Save writes the current bytes back to the bound file path (atomic,
    // chunked) via the native bridge — never a browser download.
    if (desktop && window.__deskApp__) {
      try {
        const bytes = await api.current?.getBytes();
        if (!bytes?.byteLength) throw new Error('Could not read the current document.');
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const saved = await window.__deskApp__.save(buf);
        if (saved) setDirty(false);
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
      return;
    }
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
      downloadBlob(blob, /\.pdf$/i.test(title) ? title : `${title}.pdf`);
    } catch {
      window.open(src, '_blank');
    }
  };

  // Open a document. On desktop this goes through the native picker and spawns a
  // new document window (the shell's one-window-per-file model); in a browser it
  // opens the hidden file input (after the unsaved-changes guard).
  const openDocument = () => {
    if (desktop && window.__deskApp__) {
      void window.__deskApp__.openFile();
      return;
    }
    if (confirmDiscard()) fileRef.current?.click();
  };

  const signDocument = async () => {
    if (!src) return;
    if (signBusy) return;
    setSignBusy(true);
    try {
      let bytes = await api.current?.getBytes();
      if (!bytes) {
        const res = await fetch(src);
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      if (!bytes) throw new Error('Could not read the current document.');
      const signed = await signPdf({
        pdf: bytes,
        signerName: title || 'Casual PDF Signer',
        reason: 'Signed in Casual PDF',
      });
      cancelSnapshot();
      void clearSnapshot();
      const buffer = signed.buffer.slice(signed.byteOffset, signed.byteOffset + signed.byteLength) as ArrayBuffer;
      revokeObjectUrl();
      const blob = new Blob([buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      objectUrl.current = url;
      setSrc(url);
      setDirty(false);
      clearStack(undoStack);
      clearStack(redoStack);
      downloadBlob(blob, /\.pdf$/i.test(title) ? title : `${title}.signed.pdf`);
      setCertSigning(false); // success → dismiss the dialog (kept open on error to retry)
    } catch (e) {
      console.error('Sign document failed', e);
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSignBusy(false);
    }
  };

  const insertPdf = async (file: File) => {
    if (!src) return;
    let primaryBytes: Uint8Array | null = null;
    let secondaryBytes: Uint8Array;
    try {
      secondaryBytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      alert('Could not read the selected PDF file.');
      return;
    }
    try {
      primaryBytes = (await api.current?.getBytes()) ?? null;
    } catch { /* fall through — use src fetch below */ }
    if (!primaryBytes) {
      try {
        const res = await fetch(src);
        primaryBytes = new Uint8Array(await res.arrayBuffer());
      } catch {
        alert('Could not read the current document.');
        return;
      }
    }
    try {
      const { mergePdfs } = await import('@casualoffice/pdf/merge');
      const merged = await mergePdfs(primaryBytes, secondaryBytes);
      onDocumentReplaced(merged);
    } catch {
      alert('Could not merge the PDF files. The inserted file may be corrupt or encrypted.');
    }
  };

  const addVisibleSignature = () => {
    setPendingVisibleSignature(true);
    setMode('edit');
  };

  useEffect(() => {
    if (!pendingVisibleSignature) return;
    let cancelled = false;
    const tryOpen = (remaining: number) => {
      if (cancelled) return;
      if (mode === 'edit' && api.current) {
        api.current.openSignature();
        setPendingVisibleSignature(false);
        return;
      }
      if (remaining > 0) window.setTimeout(() => tryOpen(remaining - 1), 50);
    };
    tryOpen(40);
    return () => {
      cancelled = true;
    };
  }, [pendingVisibleSignature, mode]);

  useEffect(() => {
    if (!src) {
      setSignatureStatus('unknown');
      return;
    }
    let cancelled = false;
    setSignatureStatus('unsigned');
    const withTimeout = async <T,>(promise: Promise<T> | undefined, ms: number): Promise<T | null> => {
      if (!promise) return null;
      return await Promise.race([
        promise.then((value) => value ?? null).catch(() => null),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms)),
      ]);
    };
    const check = async () => {
      // "Certified" must mean exactly what the details dialog shows: a real,
      // parseable cryptographic signature in the PRISTINE loaded bytes. We run
      // the SAME verifier on the SAME fetch(src) bytes the dialog uses, so the
      // badge can never claim "Certified" for a signature the dialog then
      // reports as "not found" (a string-match on the PDFium re-export could —
      // e.g. an empty/unsigned /Sig field survives the re-export).
      try {
        const res = await fetch(src);
        const pristine = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;
        const { verifyPdfSignatures } = await import('@casualoffice/pdf/verify');
        const sigs = await verifyPdfSignatures(pristine);
        if (cancelled) return;
        if (sigs.length > 0) {
          setSignatureStatus('certified');
          return;
        }
      } catch {
        /* fall through to the visible-stamp check */
      }
      // A *visible* signature is a stamp annotation in the overlay — check the
      // live baked bytes (retry while the viewer is still initializing).
      for (let i = 0; i < 4 && !cancelled; i++) {
        try {
          const live = await withTimeout(api.current?.getBytes(), 500);
          if (live?.byteLength) {
            if (!cancelled) setSignatureStatus(hasVisibleSignatureBytes(live) ? 'signed' : 'unsigned');
            return;
          }
        } catch {
          /* retry while the viewer is still initializing */
        }
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [src, dirty, mode]);

  const menus: MenuDef[] = [
    {
      label: 'Menu',
      icon: <Icon name="menu" size={18} />,
      items: [
        { label: 'Open…', shortcut: '⌘O', onSelect: openDocument },
        { label: 'Open sample', onSelect: () => { if (confirmDiscard()) { revokeObjectUrl(); clearStack(undoStack); clearStack(redoStack); setSrc(DEFAULT_PDF); setTitle('EmbedPDF sample'); setDirty(false); setMode('view'); } } },
        { divider: true },
        { label: desktop ? 'Save' : (dirty ? 'Download changes' : 'Download'), shortcut: '⌘S', disabled: !src, onSelect: download },
        { label: desktop ? 'Print' : 'Print / open in new tab', shortcut: '⌘P', disabled: !src || desktop, onSelect: () => { void printPdf(); } },
        { divider: true },
        { label: 'Insert PDF…', disabled: !src, onSelect: () => insertFileRef.current?.click() },
        { divider: true },
        { label: 'Add visible signature…', disabled: !src, onSelect: addVisibleSignature },
        { label: 'Sign document…', disabled: !src, onSelect: () => setCertSigning(true) },
        { label: 'Watermark / Header / Bates…', disabled: !src, onSelect: () => setPageFurniture(true) },
        { divider: true },
        { label: 'About Casual PDF', onSelect: () => setAbout(true) },
      ],
    },
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const isTyping = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
      if ((e.key === '?' || e.key === '/') && !isTyping && !(e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setAbout(true);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'o') { e.preventDefault(); openDocument(); }
      else if (k === 's') { e.preventDefault(); void download(); }
      else if (k === 'p' && !desktop) { e.preventDefault(); void printPdf(); }
      else if (k === 'f' && !isTyping) { e.preventDefault(); api.current?.openSearch(); }
      else if (k === 'z' && !isTyping) {
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
      else if (k === 'y' && !isTyping) {
        e.preventDefault();
        if (api.current?.canRedo()) api.current.redo();
        else if (redoStack.current.length > 0) versionRedo();
      }
      else if ((e.key === '?' || e.key === '/') && !isTyping) {
        e.preventDefault();
        setAbout(true);
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
            onChange={(e) => { setTitle(e.target.value); if (src) markEdited(); }}
            onFocus={(e) => src && e.target.select()}
          />
          {dirty && <span className="appbar__dirty" aria-label="Unsaved changes" title="Unsaved changes" />}
          {src && (signatureStatus === 'certified' || signatureStatus === 'signed') && (
            <button
              type="button"
              className="appbar__sigstatus"
              data-state={signatureStatus}
              onClick={() => setSigInfo(true)}
              title="View signature details & verification"
            >
              {signatureStatus === 'certified' ? 'Certified' : 'Signed'}
            </button>
          )}
          {src && (signatureStatus === 'unsigned' || signatureStatus === 'unknown') && (
            <span
              className="appbar__sigstatus"
              data-state={signatureStatus}
              title={
                signatureStatus === 'unsigned'
                  ? 'No signature was detected.'
                  : 'Signature status could not be confirmed yet.'
              }
            >
              {signatureStatus === 'unsigned' ? 'Unsigned' : 'Unknown'}
            </span>
          )}
        </div>
        <div className="appbar__actions">
          <button
            type="button"
            className="appbar__quick"
            aria-label="Open PDF (⌘O)"
            title="Open PDF (⌘O)"
            onClick={openDocument}
          >
            <Icon name="open" size={15} />
            <span>Open</span>
          </button>
          {src && (
            <button
              type="button"
              className={`appbar__quick${dirty ? ' appbar__quick--save' : ''}`}
              aria-label={desktop ? 'Save (⌘S)' : dirty ? 'Download changes (⌘S)' : 'Download (⌘S)'}
              title={desktop ? 'Save (⌘S)' : dirty ? 'Download changes (⌘S)' : 'Download (⌘S)'}
              onClick={() => void download()}
            >
              <Icon name="download" size={15} />
              <span>{desktop ? 'Save' : dirty ? 'Download changes' : 'Download'}</span>
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
      <input
        ref={insertFileRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void insertPdf(f);
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
            {!aiOpen && (
              <button
                type="button"
                data-testid="ai-toggle"
                onClick={() => setAiOpen(true)}
                aria-pressed={aiOpen}
                style={{ position: 'absolute', right: 16, bottom: 16, zIndex: 20, padding: '10px 16px', borderRadius: 24, border: 'none', background: 'var(--cpdf-accent, #2563eb)', color: '#fff', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.2)' }}
              >
                Ask AI
              </button>
            )}
            {aiOpen && (
              <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 360, zIndex: 19, borderLeft: '1px solid var(--cpdf-border, #e5e7eb)', background: 'var(--cpdf-surface, #fff)', boxShadow: '-2px 0 12px rgba(0,0,0,.08)' }}>
                <AiPanel
                  getApi={() => api.current}
                  onClose={() => setAiOpen(false)}
                  provider={COLLAB_WS_URL ? { provider: 'auto', collabWsUrl: COLLAB_WS_URL } : undefined}
                />
              </div>
            )}
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

      {certSigning && (
        <SignDialog
          onClose={() => setCertSigning(false)}
          onAddVisibleSignature={addVisibleSignature}
          onSignDocument={signDocument}
          busy={signBusy}
        />
      )}
      {pageFurniture && (
        <PageFurnitureDialog
          api={api.current}
          onDocumentReplaced={onDocumentReplaced}
          onClose={() => setPageFurniture(false)}
        />
      )}
      {sigInfo && (
        <SignatureInfoDialog
          // Verify the PRISTINE loaded bytes, not api.getBytes() — a PDFium
          // re-export shifts byte offsets and breaks the byte-exact /ByteRange.
          getBytes={async () => {
            if (!src) return null;
            const r = await fetch(src);
            return new Uint8Array(await r.arrayBuffer());
          }}
          onClose={() => setSigInfo(false)}
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
            <dl className="dialog__shortcuts">
              <div><dt>Open</dt><dd>⌘O</dd></div>
              <div><dt>Save / Download</dt><dd>⌘S</dd></div>
              <div><dt>Print / open in tab</dt><dd>⌘P</dd></div>
              <div><dt>Find</dt><dd>⌘F</dd></div>
              <div><dt>Undo / Redo</dt><dd>⌘Z / ⌘⇧Z</dd></div>
              <div><dt>Copy / Paste / Duplicate</dt><dd>⌘C / ⌘V / ⌘D</dd></div>
              <div><dt>Select all</dt><dd>⌘A</dd></div>
              <div><dt>Nudge (×10 with ⇧)</dt><dd>← ↑ ↓ →</dd></div>
              <div><dt>Tools</dt><dd>V · H · D · T · N · R · O · A · S</dd></div>
              <div><dt>Cancel / Deselect</dt><dd>Esc</dd></div>
              <div><dt>Delete selected</dt><dd>⌫ Delete</dd></div>
            </dl>
            <button ref={closeBtnRef} type="button" className="dialog__close" onClick={() => setAbout(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
