import { useState } from 'react';
import { Button } from '@schnsrw/design-system';
import { CasualPdf, type Mode } from '@casualoffice/pdf';
import { isDesktop } from './desk-bridge-bootstrap';

const DEFAULT_PDF = 'https://snippet.embedpdf.com/ebook.pdf';
const MODES: Mode[] = ['view', 'edit', 'suggest'];

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
 * Phase 0 shell: a minimal toolbar over the PDFium-WASM viewer with a
 * View / Edit / Suggest mode switch. The toolbar is intentionally plain — it is
 * replaced by the @schnsrw/design-system toolbar in Phase 1.
 */
export function App() {
  const [mode, setMode] = useState<Mode>('view');
  const [src] = useState(initialSrc);

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">Casual PDF</span>
        <div className="modes" role="tablist" aria-label="Editing mode">
          {MODES.map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mode === m ? 'primary' : 'subtle'}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
            >
              {m}
            </Button>
          ))}
        </div>
        <span className="surface">{isDesktop() ? 'desktop' : 'web'}</span>
      </header>
      <main className="canvas">
        <CasualPdf src={src} mode={mode} className="viewer" />
      </main>
    </div>
  );
}
