import { useState } from 'react';
import { CasualPdf, type Mode } from '@casualoffice/pdf';
import { isDesktop } from './desk-bridge-bootstrap';

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
 * Google-Docs-style shell: a top app bar (logo + document title, then Share +
 * account on the right) over the @casualoffice/pdf viewer. The view/edit/suggest
 * mode control lives in the viewer toolbar (Docs-style dropdown); this app owns
 * mode state and passes it down, mirroring how rights will drive mode later.
 */
export function App() {
  const [mode, setMode] = useState<Mode>('view');
  const [src] = useState(initialSrc);

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar__brand">
          <img className="appbar__logo" src="/logo.svg" alt="" width={28} height={28} />
          <div className="appbar__titles">
            <span className="appbar__title">Untitled document</span>
            <span className="appbar__sub">Casual PDF{isDesktop() ? ' · desktop' : ''}</span>
          </div>
        </div>
        <div className="appbar__actions">
          {/* Share is wired to public links + rights in Phase 3. */}
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
      <main className="canvas">
        <CasualPdf src={src} mode={mode} onModeChange={setMode} className="viewer" />
      </main>
    </div>
  );
}
