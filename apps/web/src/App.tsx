import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CasualPdf, type Mode, type CasualPdfApi } from '@casualoffice/pdf';
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

// Inline SVGs (no icon font / emoji) for the app-shell chrome.
const svg = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const HamburgerIcon = () => svg(<><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></>);
const EyeIcon = () => svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>);
const SuggestIcon = () => svg(<><path d="M13.5 6.2 17.8 10.5 7 21.3H2.7V17z" /><path d="M15 4.7 17 2.7l4.3 4.3-2 2" /></>);
const PencilIcon = () => svg(<><path d="M14.5 5.2 18.8 9.5 8 20.3H3.7V16z" /><path d="M16 3.7 18 1.7l4.3 4.3-2 2" /></>);
const SunIcon = () => svg(<><circle cx="12" cy="12" r="4" /><line x1="12" y1="2.5" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="21.5" /><line x1="2.5" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="21.5" y2="12" /><line x1="5.2" y1="5.2" x2="7" y2="7" /><line x1="17" y1="17" x2="18.8" y2="18.8" /><line x1="5.2" y1="18.8" x2="7" y2="17" /><line x1="17" y1="7" x2="18.8" y2="5.2" /></>);
const MoonIcon = () => svg(<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />);

const MODES: { id: Mode; label: string; Icon: () => ReactNode }[] = [
  { id: 'view', label: 'View', Icon: EyeIcon },
  { id: 'suggest', label: 'Suggest', Icon: SuggestIcon },
  { id: 'edit', label: 'Edit', Icon: PencilIcon },
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

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : '';
  }, [dark]);
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
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.open(src, '_blank');
    }
  };

  const menus: MenuDef[] = [
    {
      label: 'Menu',
      icon: <HamburgerIcon />,
      items: [
        { label: 'Open…', shortcut: '⌘O', onSelect: () => fileRef.current?.click() },
        { label: 'Open sample', onSelect: () => { setSrc(DEFAULT_PDF); setTitle('EmbedPDF sample'); } },
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
            {MODES.map(({ id, label, Icon }) => (
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
                <Icon />
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
            {dark ? <SunIcon /> : <MoonIcon />}
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
              <strong>Shortcuts</strong> — Open ⌘O · Save ⌘S · Undo ⌘Z · Redo ⌘⇧Z · Nudge ←↑↓→ (⇧ = bigger) · Find (top-right) · Tools: V H D T N R O A
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
