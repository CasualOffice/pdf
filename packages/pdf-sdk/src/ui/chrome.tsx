/**
 * Viewer chrome: the floating toolbar, search bar, thumbnail rail, and the
 * stateful inner viewer that stitches them to the EmbedPDF page layers.
 *
 * Every control is wired to a verified EmbedPDF plugin hook. All of these
 * components render *inside* the <EmbedPDF> provider (see CasualPdf.tsx), which
 * is what makes the hooks resolve.
 */
import { useEffect, useRef, useState } from 'react';
import { Viewport } from '@embedpdf/plugin-viewport/react';
import { Scroller } from '@embedpdf/plugin-scroll/react';
import { RenderLayer } from '@embedpdf/plugin-render/react';
import { useZoom, ZoomMode } from '@embedpdf/plugin-zoom/react';
import { useScroll } from '@embedpdf/plugin-scroll/react';
import { useRotate } from '@embedpdf/plugin-rotate/react';
import { useSpread, SpreadMode } from '@embedpdf/plugin-spread/react';
import { useFullscreen } from '@embedpdf/plugin-fullscreen/react';
import { usePan } from '@embedpdf/plugin-pan/react';
import { useSearch, SearchLayer } from '@embedpdf/plugin-search/react';
import { SelectionLayer } from '@embedpdf/plugin-selection/react';
import { ThumbnailsPane, ThumbImg } from '@embedpdf/plugin-thumbnail/react';
import { IconButton } from './IconButton';
import './viewer.css';

const ROOT_ID = 'cpdf-root';

/** Floating pill toolbar. */
function Toolbar({
  documentId,
  searchOpen,
  onToggleSearch,
  thumbsOpen,
  onToggleThumbs,
}: {
  documentId: string;
  searchOpen: boolean;
  onToggleSearch: () => void;
  thumbsOpen: boolean;
  onToggleThumbs: () => void;
}) {
  const { state: zoom, provides: zoomApi } = useZoom(documentId);
  const { state: scroll, provides: scrollApi } = useScroll(documentId);
  const { provides: rotateApi } = useRotate(documentId);
  const { spreadMode, provides: spreadApi } = useSpread(documentId);
  const { state: fs, provides: fsApi } = useFullscreen();
  const { isPanning, provides: panApi } = usePan(documentId);
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark',
  );

  const page = scroll?.currentPage ?? 1;
  const total = scroll?.totalPages ?? 0;
  const pct = Math.round((zoom?.currentZoomLevel ?? 1) * 100);

  const goToPage = (n: number) => {
    if (!scrollApi || Number.isNaN(n)) return;
    scrollApi.scrollToPage({ pageNumber: Math.min(Math.max(1, n), total || 1) });
  };
  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? 'dark' : '';
  };

  return (
    <div className="cpdf__toolbar" role="toolbar" aria-label="PDF viewer toolbar">
      <div className="cpdf__group">
        <IconButton icon="thumbnails" label="Page thumbnails" active={thumbsOpen} onClick={onToggleThumbs} />
      </div>
      <span className="cpdf__sep" aria-hidden="true" />
      <div className="cpdf__group">
        <IconButton
          icon="chevron-left"
          label="Previous page"
          disabled={page <= 1}
          onClick={() => scrollApi?.scrollToPreviousPage()}
        />
        <span className="cpdf__pagebox">
          <input
            className="cpdf__pageinput"
            aria-label="Page number"
            inputMode="numeric"
            value={page}
            onChange={(e) => goToPage(parseInt(e.target.value, 10))}
          />
          <span aria-hidden="true">/</span>
          <span aria-label={`of ${total} pages`}>{total}</span>
        </span>
        <IconButton
          icon="chevron-right"
          label="Next page"
          disabled={total > 0 && page >= total}
          onClick={() => scrollApi?.scrollToNextPage()}
        />
      </div>
      <span className="cpdf__sep" aria-hidden="true" />
      <div className="cpdf__group">
        <IconButton icon="zoom-out" label="Zoom out" onClick={() => zoomApi?.zoomOut()} />
        <span className="cpdf__zoomlabel" aria-label={`Zoom ${pct} percent`}>{pct}%</span>
        <IconButton icon="zoom-in" label="Zoom in" onClick={() => zoomApi?.zoomIn()} />
        <IconButton
          icon="fit-width"
          label="Fit width"
          active={zoom?.zoomLevel === ZoomMode.FitWidth}
          onClick={() => zoomApi?.requestZoom(ZoomMode.FitWidth)}
        />
        <IconButton
          icon="fit-page"
          label="Fit page"
          active={zoom?.zoomLevel === ZoomMode.FitPage}
          onClick={() => zoomApi?.requestZoom(ZoomMode.FitPage)}
        />
      </div>
      <span className="cpdf__sep" aria-hidden="true" />
      <div className="cpdf__group">
        <IconButton icon="rotate" label="Rotate clockwise" onClick={() => rotateApi?.rotateForward()} />
        <IconButton
          icon="spread"
          label="Two-page spread"
          active={spreadMode !== SpreadMode.None}
          onClick={() => spreadApi?.setSpreadMode(spreadMode === SpreadMode.None ? SpreadMode.Odd : SpreadMode.None)}
        />
        <IconButton
          icon="hand"
          label="Pan tool"
          active={isPanning}
          onClick={() => panApi?.togglePan()}
        />
      </div>
      <span className="cpdf__sep" aria-hidden="true" />
      <div className="cpdf__group">
        <IconButton icon="search" label="Find in document" active={searchOpen} onClick={onToggleSearch} />
        <IconButton
          icon={fs.isFullscreen ? 'fullscreen-exit' : 'fullscreen-enter'}
          label={fs.isFullscreen ? 'Exit full screen' : 'Full screen'}
          active={fs.isFullscreen}
          onClick={() => fsApi?.toggleFullscreen(ROOT_ID)}
        />
        <IconButton
          icon={dark ? 'sun' : 'moon'}
          label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
        />
      </div>
    </div>
  );
}

/** Floating find bar. */
function SearchPanel({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { state, provides } = useSearch(documentId);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const run = () => {
    if (provides && q.trim()) provides.searchAllPages(q.trim());
  };
  const total = state?.total ?? 0;
  const active = total > 0 ? (state?.activeResultIndex ?? 0) + 1 : 0;

  return (
    <div className="cpdf__search" role="search">
      <input
        ref={inputRef}
        type="text"
        aria-label="Find in document"
        placeholder="Find in document…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.shiftKey ? provides?.previousResult() : run());
          if (e.key === 'Escape') onClose();
        }}
      />
      <span className="cpdf__search-count" aria-live="polite">
        {state?.loading ? '…' : `${active}/${total}`}
      </span>
      <IconButton icon="chevron-left" label="Previous match" disabled={total === 0} onClick={() => provides?.previousResult()} />
      <IconButton icon="chevron-right" label="Next match" disabled={total === 0} onClick={() => provides?.nextResult()} />
      <IconButton icon="close" label="Close find" onClick={onClose} />
    </div>
  );
}

/** Floating thumbnail rail. ThumbnailsPane owns its own scroll + windowing. */
function ThumbnailSidebar({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { state, provides } = useScroll(documentId);
  const current = state?.currentPage ?? 1;
  return (
    <aside className="cpdf__panel" aria-label="Page thumbnails">
      <div className="cpdf__panel-head">
        <span>Pages</span>
        <IconButton icon="close" label="Close thumbnails" onClick={onClose} />
      </div>
      <div className="cpdf__panel-body" style={{ padding: 0 }}>
        <ThumbnailsPane documentId={documentId} style={{ height: '100%', overflow: 'auto' }}>
          {(m) => (
            <button
              key={m.pageIndex}
              type="button"
              className="cpdf__thumb"
              data-current={current === m.pageIndex + 1 ? 'true' : undefined}
              aria-label={`Go to page ${m.pageIndex + 1}`}
              aria-current={current === m.pageIndex + 1 ? 'page' : undefined}
              style={{ position: 'absolute', top: m.top, left: 0, right: 0 }}
              onClick={() => provides?.scrollToPage({ pageNumber: m.pageIndex + 1 })}
            >
              <ThumbImg documentId={documentId} meta={m} />
              <span className="cpdf__thumb-n">{m.pageIndex + 1}</span>
            </button>
          )}
        </ThumbnailsPane>
      </div>
    </aside>
  );
}

/** The stateful viewer: chrome + page layers. Rendered once the doc is loaded. */
export function Viewer({ documentId }: { documentId: string }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [thumbsOpen, setThumbsOpen] = useState(false);

  return (
    <div className="cpdf" id={ROOT_ID}>
      <Toolbar
        documentId={documentId}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen((v) => !v)}
        thumbsOpen={thumbsOpen}
        onToggleThumbs={() => setThumbsOpen((v) => !v)}
      />
      <div className="cpdf__body">
        {thumbsOpen && <ThumbnailSidebar documentId={documentId} onClose={() => setThumbsOpen(false)} />}
        <Viewport documentId={documentId} className="cpdf__viewport">
          <Scroller
            documentId={documentId}
            renderPage={({ width, height, pageIndex }) => (
              <div style={{ width, height, position: 'relative' }}>
                <RenderLayer documentId={documentId} pageIndex={pageIndex} />
                <SearchLayer documentId={documentId} pageIndex={pageIndex} />
                <SelectionLayer documentId={documentId} pageIndex={pageIndex} />
              </div>
            )}
          />
        </Viewport>
      </div>
      {searchOpen && <SearchPanel documentId={documentId} onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
