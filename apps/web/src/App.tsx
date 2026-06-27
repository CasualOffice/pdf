import { useEffect, useRef, useState } from 'react';
import { CasualPdf, type Mode } from '@casualoffice/pdf';
import { MenuBar, type MenuDef } from './Menu';

const DEFAULT_PDF = 'https://snippet.embedpdf.com/ebook.pdf';

/** A `?src=` query param overrides the document (used by the UX-F1 render-parity
 *  harness and by embedders); falls back to the bundled sample. */
function initialSrc(): string {
  if (typeof window === 'undefined') return DEFAULT_PDF;
  try {
    return new URL(window.location.href).searchParams.get('src') || DEFAULT_PDF;
  } catch {
    return DEFAULT_PDF;
  }
}

/**
 * Google-Docs-style shell: a top app bar (logo + document title + menu bar, then
 * Share + account), with File/View/Help menus over the @casualoffice/pdf viewer.
 * Open/Download/Print and theme live here (host/app concerns); the viewer toolbar
 * owns in-document controls and the view/edit/suggest mode dropdown.
 */
export function App() {
  const [mode, setMode] = useState<Mode>('view');
  const [src, setSrc] = useState(initialSrc);
  const [title, setTitle] = useState('Untitled document');
  const [dark, setDark] = useState(false);
  const [about, setAbout] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : '';
  }, [dark]);
  // Revoke the previous object URL when the source changes / on unmount.
  useEffect(() => () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  const openFromFile = (file: File) => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    setSrc(url);
    setTitle(file.name.replace(/\.pdf$/i, ''));
  };

  const download = async () => {
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = /\.pdf$/i.test(title) ? title : `${title}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.open(src, '_blank');
    }
  };

  const fullscreen = () => document.getElementById('cpdf-root')?.requestFullscreen?.();

  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'Open…', shortcut: '⌘O', onSelect: () => fileRef.current?.click() },
        {
          label: 'Open sample',
          onSelect: () => {
            setSrc(DEFAULT_PDF);
            setTitle('EmbedPDF sample');
          },
        },
        { divider: true },
        { label: 'Download', shortcut: '⌘S', onSelect: download },
        { label: 'Print / open in new tab', shortcut: '⌘P', onSelect: () => window.open(src, '_blank') },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Dark theme', checked: dark, onSelect: () => setDark((v) => !v) },
        { label: 'Full screen', shortcut: 'F11', onSelect: fullscreen },
      ],
    },
    {
      label: 'Help',
      items: [{ label: 'About Casual PDF', onSelect: () => setAbout(true) }],
    },
  ];

  // Keyboard shortcuts for the File actions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'o') {
        e.preventDefault();
        fileRef.current?.click();
      } else if (k === 's') {
        e.preventDefault();
        download();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, title]);

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar__brand">
          <img className="appbar__logo" src="/logo.svg" alt="" width={28} height={28} />
          <div className="appbar__titles">
            <input
              className="appbar__title"
              value={title}
              spellCheck={false}
              aria-label="Document name"
              onChange={(e) => setTitle(e.target.value)}
              onFocus={(e) => e.target.select()}
            />
            <MenuBar menus={menus} />
          </div>
        </div>
        <div className="appbar__actions">
          <button type="button" className="appbar__share" aria-label="Share document">
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="12" r="2.4" />
                <circle cx="17.5" cy="6" r="2.4" />
                <circle cx="17.5" cy="18" r="2.4" />
                <line x1="8.1" y1="10.9" x2="15.4" y2="7.1" />
                <line x1="8.1" y1="13.1" x2="15.4" y2="16.9" />
              </g>
            </svg>
            <span>Share</span>
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
        {/* key={src} remounts the viewer on a new document so the engine reloads. */}
        <CasualPdf key={src} src={src} mode={mode} onModeChange={setMode} className="viewer" />
      </main>

      {about && (
        <div className="dialog__scrim" role="presentation" onClick={() => setAbout(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="About Casual PDF" onClick={(e) => e.stopPropagation()}>
            <img src="/logo.svg" alt="" width={48} height={48} />
            <h2 className="dialog__title">Casual PDF</h2>
            <p className="dialog__body">
              A high-fidelity PDF viewer &amp; editor with real-time co-editing, e-signing, and granular
              rights. One PDFium engine across web and desktop.
            </p>
            <p className="dialog__shortcuts">
              <strong>Shortcuts</strong> — Open ⌘O · Download ⌘S · Find ⌘F (toolbar)
            </p>
            <button type="button" className="dialog__close" onClick={() => setAbout(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
