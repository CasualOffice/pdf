/**
 * Viewer chrome: a Google-Docs-style toolbar (left-aligned grouped controls with
 * a "Viewing / Suggesting / Editing" mode dropdown at the right), a find bar, a
 * thumbnail rail, and the stateful inner viewer that stitches them to the
 * EmbedPDF page layers.
 *
 * Every control is wired to a verified EmbedPDF plugin hook. All of these
 * components render *inside* the <EmbedPDF> provider (see CasualPdf.tsx), which
 * is what makes the hooks resolve.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react';
import { Viewport } from '@embedpdf/plugin-viewport/react';
import { Scroller } from '@embedpdf/plugin-scroll/react';
import { RenderLayer } from '@embedpdf/plugin-render/react';
import { useZoom, ZoomMode } from '@embedpdf/plugin-zoom/react';
import { useScroll, useScrollCapability, ScrollStrategy } from '@embedpdf/plugin-scroll/react';
import { useRotate } from '@embedpdf/plugin-rotate/react';
import { useSpread, SpreadMode } from '@embedpdf/plugin-spread/react';
import { useFullscreen } from '@embedpdf/plugin-fullscreen/react';
import { usePan } from '@embedpdf/plugin-pan/react';
import { useSearch, SearchLayer } from '@embedpdf/plugin-search/react';
import { SelectionLayer } from '@embedpdf/plugin-selection/react';
import { ThumbnailsPane, ThumbImg } from '@embedpdf/plugin-thumbnail/react';
import { useBookmarkCapability } from '@embedpdf/plugin-bookmark/react';
import { PagePointerProvider } from '@embedpdf/plugin-interaction-manager/react';
import { useAnnotation, AnnotationLayer, AnnotationRendererProvider } from '@embedpdf/plugin-annotation/react';
import { useHistoryCapability } from '@embedpdf/plugin-history/react';
import { useExportCapability } from '@embedpdf/plugin-export/react';
import { IconButton } from './IconButton';
import { Icon, type IconName } from './icons';
import type { Mode, CasualPdfApi } from '../modes';
import './viewer.css';

/** Annotation tools surfaced in Edit/Suggest mode (EmbedPDF tool ids). */
const ANNOTATION_TOOLS: { id: string; icon: IconName; label: string }[] = [
  { id: 'highlight', icon: 'marker', label: 'Highlight' },
  { id: 'ink', icon: 'ink', label: 'Draw' },
  { id: 'freeText', icon: 'text-tool', label: 'Text box' },
  { id: 'textComment', icon: 'note', label: 'Comment' },
  { id: 'square', icon: 'square', label: 'Rectangle' },
  { id: 'circle', icon: 'circle', label: 'Ellipse' },
  { id: 'lineArrow', icon: 'arrow', label: 'Arrow' },
];

const ROOT_ID = 'cpdf-root';

/** Which left-hand panel is open (one at a time, Google-Docs-style). */
type LeftPanel = 'thumbs' | 'outline' | null;

/** A minimal view of @embedpdf/models' PdfBookmarkObject (avoids a type dep). */
interface Bookmark {
  title: string;
  target?: { type: string; destination?: { pageIndex: number } };
  children?: Bookmark[];
}

const MODE_META: Record<Mode, { label: string; icon: IconName; desc: string }> = {
  view: { label: 'Viewing', icon: 'eye', desc: 'Read only' },
  suggest: { label: 'Suggesting', icon: 'suggest', desc: 'Edits become suggestions' },
  edit: { label: 'Editing', icon: 'pencil', desc: 'Edit directly' },
};
const MODE_ORDER: Mode[] = ['edit', 'suggest', 'view'];

/** Google-Docs-style mode dropdown. Read-only indicator when no onModeChange. */
function ModeMenu({ mode, onModeChange }: { mode: Mode; onModeChange?: (m: Mode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const readOnly = !onModeChange;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const cur = MODE_META[mode];
  return (
    <div className="cpdf__mode" ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        className="cpdf__mode-btn"
        data-mode={mode}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Mode: ${cur.label}`}
        disabled={readOnly}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={cur.icon} filled size={18} />
        <span className="cpdf__mode-label">{cur.label}</span>
        {!readOnly && <Icon name="chevron-down" size={16} />}
      </button>
      {open && (
        <div className="cpdf__menu" role="menu" aria-label="Editing mode">
          {MODE_ORDER.map((m) => {
            const meta = MODE_META[m];
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={mode === m}
                className="cpdf__menu-item"
                data-active={mode === m ? 'true' : undefined}
                onClick={() => {
                  onModeChange?.(m);
                  setOpen(false);
                }}
              >
                <Icon name={meta.icon} filled={mode === m} size={18} />
                <span className="cpdf__menu-text">
                  <span className="cpdf__menu-title">{meta.label}</span>
                  <span className="cpdf__menu-desc">{meta.desc}</span>
                </span>
                <span className="cpdf__menu-check">{mode === m && <Icon name="check" size={16} />}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Left-aligned toolbar bar. */
function Toolbar({
  documentId,
  mode,
  onModeChange,
  searchOpen,
  onToggleSearch,
  leftPanel,
  onToggleLeft,
}: {
  documentId: string;
  mode: Mode;
  onModeChange?: (m: Mode) => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  leftPanel: LeftPanel;
  onToggleLeft: (p: 'thumbs' | 'outline') => void;
}) {
  const { state: zoom, provides: zoomApi } = useZoom(documentId);
  const { state: scroll, provides: scrollApi } = useScroll(documentId);
  const { provides: scrollCap } = useScrollCapability();
  const { provides: rotateApi } = useRotate(documentId);
  const { spreadMode, provides: spreadApi } = useSpread(documentId);
  const { state: fs, provides: fsApi } = useFullscreen();
  const { isPanning, provides: panApi } = usePan(documentId);
  const { state: anno, provides: annoApi } = useAnnotation(documentId);
  const { provides: history } = useHistoryCapability();
  const [horizontal, setHorizontal] = useState(false);

  const editing = mode !== 'view';
  const activeToolId = anno?.activeToolId ?? null;
  const page = scroll?.currentPage ?? 1;
  const total = scroll?.totalPages ?? 0;
  const pct = Math.round((zoom?.currentZoomLevel ?? 1) * 100);

  const goToPage = (n: number) => {
    if (!scrollApi || Number.isNaN(n)) return;
    scrollApi.scrollToPage({ pageNumber: Math.min(Math.max(1, n), total || 1) });
  };
  const toggleScrollDir = () => {
    const next = !horizontal;
    setHorizontal(next);
    scrollCap?.setScrollStrategy(next ? ScrollStrategy.Horizontal : ScrollStrategy.Vertical, documentId);
  };
  // Theme is owned by the app shell's View menu; the toolbar no longer toggles it.

  return (
    <div className="cpdf__toolbar" role="toolbar" aria-label="PDF viewer toolbar">
      <div className="cpdf__toolbar-scroll">
      <div className="cpdf__group">
        <IconButton
          icon="thumbnails"
          label="Page thumbnails"
          active={leftPanel === 'thumbs'}
          onClick={() => onToggleLeft('thumbs')}
        />
        <IconButton
          icon="outline"
          label="Document outline"
          active={leftPanel === 'outline'}
          onClick={() => onToggleLeft('outline')}
        />
      </div>
      {editing && (
        <>
          <span className="cpdf__sep" aria-hidden="true" />
          <div className="cpdf__group">
            <IconButton
              icon="cursor"
              label="Select"
              active={activeToolId === null}
              onClick={() => annoApi?.setActiveTool(null)}
            />
            {ANNOTATION_TOOLS.map((t) => (
              <IconButton
                key={t.id}
                icon={t.icon}
                label={t.label}
                active={activeToolId === t.id}
                onClick={() => annoApi?.setActiveTool(activeToolId === t.id ? null : t.id)}
              />
            ))}
          </div>
          <span className="cpdf__sep" aria-hidden="true" />
          <div className="cpdf__group">
            <IconButton icon="undo" label="Undo" onClick={() => history?.undo()} />
            <IconButton icon="redo" label="Redo" onClick={() => history?.redo()} />
          </div>
        </>
      )}
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
        <IconButton icon="hand" label="Pan tool" active={isPanning} onClick={() => panApi?.togglePan()} />
        <IconButton
          icon="scroll-h"
          label={horizontal ? 'Vertical scrolling' : 'Horizontal scrolling'}
          active={horizontal}
          onClick={toggleScrollDir}
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
      </div>
      </div>
      <ModeMenu mode={mode} onModeChange={onModeChange} />
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
          if (e.key === 'Enter') e.shiftKey ? provides?.previousResult() : run();
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

/** Document outline / bookmarks. Fetched async via the bookmark plugin. */
function OutlineSidebar({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { provides } = useBookmarkCapability();
  const { provides: scrollApi } = useScroll(documentId);
  const [items, setItems] = useState<Bookmark[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const scope = provides?.forDocument(documentId);
    if (!scope) return;
    scope
      .getBookmarks()
      .toPromise()
      .then((res) => {
        if (!cancelled) {
          setItems((res?.bookmarks ?? []) as Bookmark[]);
          setLoaded(true);
        }
      })
      .catch(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [provides, documentId]);

  const go = (bm: Bookmark) => {
    const t = bm.target;
    if (t?.type === 'destination' && t.destination) {
      scrollApi?.scrollToPage({ pageNumber: t.destination.pageIndex + 1 });
    }
  };

  const tree = (nodes: Bookmark[], depth = 0): ReactNode =>
    nodes.map((bm, i) => (
      <Fragment key={`${depth}-${i}-${bm.title}`}>
        <button
          type="button"
          className="cpdf__outline-item"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => go(bm)}
        >
          {bm.title}
        </button>
        {bm.children?.length ? tree(bm.children, depth + 1) : null}
      </Fragment>
    ));

  return (
    <aside className="cpdf__panel" aria-label="Document outline">
      <div className="cpdf__panel-head">
        <span>Outline</span>
        <IconButton icon="close" label="Close outline" onClick={onClose} />
      </div>
      <div className="cpdf__panel-body">
        {!loaded ? (
          <div className="cpdf__panel-empty">Loading…</div>
        ) : items.length ? (
          tree(items)
        ) : (
          <div className="cpdf__panel-empty">This document has no outline.</div>
        )}
      </div>
    </aside>
  );
}

/** The stateful viewer: chrome + page layers. Rendered once the doc is loaded. */
export function Viewer({
  documentId,
  mode,
  onModeChange,
  apiRef,
}: {
  documentId: string;
  mode: Mode;
  onModeChange?: (m: Mode) => void;
  apiRef?: MutableRefObject<CasualPdfApi | null>;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [leftPanel, setLeftPanel] = useState<LeftPanel>(null);
  const toggleLeft = (p: 'thumbs' | 'outline') => setLeftPanel((cur) => (cur === p ? null : p));

  // Expose an imperative API to the host (app menus call these).
  const { provides: annoApi } = useAnnotation(documentId);
  const { provides: history } = useHistoryCapability();
  const { provides: exportCap } = useExportCapability();
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      download: () => exportCap?.download(),
      undo: () => history?.undo(),
      redo: () => history?.redo(),
      deleteSelection: () => {
        const sel = annoApi?.getSelectedAnnotations() ?? [];
        if (annoApi && sel.length) {
          annoApi.deleteAnnotations(sel.map((a) => ({ pageIndex: a.object.pageIndex, id: a.object.id })));
        }
      },
      setTool: (id) => annoApi?.setActiveTool(id),
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, annoApi, history, exportCap]);

  return (
    <AnnotationRendererProvider>
    <div className="cpdf" id={ROOT_ID}>
      <Toolbar
        documentId={documentId}
        mode={mode}
        onModeChange={onModeChange}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen((v) => !v)}
        leftPanel={leftPanel}
        onToggleLeft={toggleLeft}
      />
      <div className="cpdf__body">
        {leftPanel === 'thumbs' && (
          <ThumbnailSidebar documentId={documentId} onClose={() => setLeftPanel(null)} />
        )}
        {leftPanel === 'outline' && (
          <OutlineSidebar documentId={documentId} onClose={() => setLeftPanel(null)} />
        )}
        <Viewport documentId={documentId} className="cpdf__viewport">
          <Scroller
            documentId={documentId}
            renderPage={({ width, height, pageIndex }) => (
              <PagePointerProvider
                documentId={documentId}
                pageIndex={pageIndex}
                className="cpdf__page"
                style={{ width, height, position: 'relative' }}
              >
                <RenderLayer documentId={documentId} pageIndex={pageIndex} />
                <SearchLayer documentId={documentId} pageIndex={pageIndex} />
                {/* Text selection in view mode; in edit/suggest the annotation
                    tools own the pointer surface. */}
                {mode === 'view' && <SelectionLayer documentId={documentId} pageIndex={pageIndex} />}
                <AnnotationLayer
                  documentId={documentId}
                  pageIndex={pageIndex}
                  style={{ position: 'absolute', inset: 0 }}
                />
              </PagePointerProvider>
            )}
          />
        </Viewport>
      </div>
      {searchOpen && <SearchPanel documentId={documentId} onClose={() => setSearchOpen(false)} />}
    </div>
    </AnnotationRendererProvider>
  );
}
