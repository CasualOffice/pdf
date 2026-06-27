/**
 * Viewer chrome — a professional PDF-editor layout (Acrobat/Nutrient-style):
 *   • left tool rail (navigation toggles + annotation tools + undo/redo)
 *   • max document canvas in the center
 *   • right contextual properties panel (color / width / opacity / delete)
 *   • a floating bottom bar for page nav + zoom + fit + view options
 *
 * Mode is owned by the host (app top bar) and passed in; tools + properties show
 * only in Edit/Suggest. Every control is wired to a verified EmbedPDF plugin
 * hook and renders inside the <EmbedPDF> provider (see CasualPdf.tsx).
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
import {
  useAnnotation,
  useAnnotationCapability,
  AnnotationLayer,
  AnnotationRendererProvider,
} from '@embedpdf/plugin-annotation/react';
import { useHistoryCapability } from '@embedpdf/plugin-history/react';
import { useExportCapability } from '@embedpdf/plugin-export/react';
import { IconButton } from './IconButton';
import { Icon, type IconName } from './icons';
import type { Mode, CasualPdfApi } from '../modes';
import './viewer.css';

const ROOT_ID = 'cpdf-root';

type LeftPanel = 'thumbs' | 'outline' | null;

interface Bookmark {
  title: string;
  target?: { type: string; destination?: { pageIndex: number } };
  children?: Bookmark[];
}

/** Annotation tools (EmbedPDF tool ids) + a one-key shortcut. */
const TOOLS: { id: string; icon: IconName; label: string; key: string }[] = [
  { id: 'highlight', icon: 'marker', label: 'Highlight', key: 'h' },
  { id: 'ink', icon: 'ink', label: 'Draw', key: 'd' },
  { id: 'freeText', icon: 'text-tool', label: 'Text box', key: 't' },
  { id: 'textComment', icon: 'note', label: 'Comment', key: 'n' },
  { id: 'square', icon: 'square', label: 'Rectangle', key: 'r' },
  { id: 'circle', icon: 'circle', label: 'Ellipse', key: 'o' },
  { id: 'lineArrow', icon: 'arrow', label: 'Arrow', key: 'a' },
];

const PALETTE = ['#1f2430', '#e8453c', '#f5a623', '#2bb673', '#2d8cff', '#8b5cf6'];
const STROKE_WIDTHS = [1, 2, 4, 6];
const OPACITIES = [1, 0.75, 0.5, 0.25];
const FONT_SIZES = [12, 16, 24, 32];
const STROKE_TOOLS = new Set(['ink', 'inkHighlighter', 'line', 'lineArrow', 'square', 'circle', 'polygon', 'polyline']);
const TEXT_TOOLS = new Set(['freeText', 'freeTextCallout']);
// One-shot tools: revert to Select after placing one (so it's immediately
// selected/adjustable). Ink + text-markup stay active for repeated use.
const REVERT_AFTER_CREATE = new Set(['square', 'circle', 'line', 'lineArrow', 'polygon', 'polyline', 'freeText', 'freeTextCallout', 'textComment', 'stamp']);
const patchFor = (toolId: string | undefined, color: string) =>
  toolId && STROKE_TOOLS.has(toolId)
    ? { strokeColor: color }
    : toolId && TEXT_TOOLS.has(toolId)
      ? { fontColor: color }
      : { color };
const norm = (c?: string) => (c ?? '').toLowerCase();

/* ── Left tool rail ───────────────────────────────────────────────────────── */
/** A labelled rail button — icon + caption so the rail reads as a tool palette. */
function RailBtn({
  icon,
  label,
  title,
  active,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="cpdf__railbtn"
      data-active={active ? 'true' : undefined}
      aria-label={title ?? label}
      aria-pressed={active === undefined ? undefined : !!active}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} filled={!!active} size={22} />
      <span className="cpdf__railbtn-label">{label}</span>
    </button>
  );
}

function LeftRail({
  documentId,
  mode,
  leftPanel,
  onToggleLeft,
}: {
  documentId: string;
  mode: Mode;
  leftPanel: LeftPanel;
  onToggleLeft: (p: 'thumbs' | 'outline') => void;
}) {
  const { state: anno, provides: annoApi } = useAnnotation(documentId);
  const { provides: history } = useHistoryCapability();
  const activeToolId = anno?.activeToolId ?? null;
  const editing = mode !== 'view';

  return (
    <div className="cpdf__rail" role="toolbar" aria-orientation="vertical" aria-label="Tools">
      <RailBtn icon="thumbnails" label="Pages" title="Page thumbnails" active={leftPanel === 'thumbs'} onClick={() => onToggleLeft('thumbs')} />
      <RailBtn icon="outline" label="Outline" title="Document outline" active={leftPanel === 'outline'} onClick={() => onToggleLeft('outline')} />
      {editing && (
        <>
          <span className="cpdf__rail-sep" aria-hidden="true" />
          <RailBtn icon="cursor" label="Select" title="Select (V)" active={activeToolId === null} onClick={() => annoApi?.setActiveTool(null)} />
          {TOOLS.map((t) => (
            <RailBtn
              key={t.id}
              icon={t.icon}
              label={t.label.replace(' box', '')}
              title={`${t.label} (${t.key.toUpperCase()})`}
              active={activeToolId === t.id}
              onClick={() => annoApi?.setActiveTool(activeToolId === t.id ? null : t.id)}
            />
          ))}
          <span className="cpdf__rail-sep" aria-hidden="true" />
          <RailBtn icon="undo" label="Undo" title="Undo (⌘Z)" onClick={() => history?.undo()} />
          <RailBtn icon="redo" label="Redo" title="Redo (⌘⇧Z)" onClick={() => history?.redo()} />
        </>
      )}
    </div>
  );
}

/* ── Right properties panel ───────────────────────────────────────────────── */
function PropertiesPanel({ documentId }: { documentId: string }) {
  const { provides: cap } = useAnnotationCapability();
  const { state: anno, provides: scope } = useAnnotation(documentId);
  // Tool-default changes live in global plugin state (not the per-document state
  // useAnnotation subscribes to), so bump a tick to re-read them after a change.
  const [, setTick] = useState(0);
  const activeToolId = anno?.activeToolId ?? null;
  const selected = scope?.getSelectedAnnotations() ?? [];
  const hasContext = activeToolId !== null || selected.length > 0;
  // Contextual: no empty box — the panel only exists when there's something to style.
  if (!hasContext) return null;

  const firstObj = selected[0]?.object as
    | { color?: string; strokeColor?: string; fontColor?: string; opacity?: number; fontSize?: number }
    | undefined;
  const toolDefaults = activeToolId ? (cap?.getTool(activeToolId)?.defaults as Record<string, unknown> | undefined) : undefined;
  const currentColor = norm(
    firstObj?.fontColor ?? firstObj?.strokeColor ?? firstObj?.color ??
      (toolDefaults?.fontColor as string) ?? (toolDefaults?.strokeColor as string) ?? (toolDefaults?.color as string),
  );
  const currentOpacity = firstObj?.opacity ?? (toolDefaults?.opacity as number) ?? 1;
  const currentFontSize = firstObj?.fontSize ?? (toolDefaults?.fontSize as number) ?? 16;
  const relevant = (set: Set<string>) =>
    (activeToolId !== null && set.has(activeToolId)) ||
    selected.some((a) => set.has(scope?.findToolForAnnotation(a.object)?.id ?? ''));
  const widthRelevant = relevant(STROKE_TOOLS);
  const fontRelevant = relevant(TEXT_TOOLS);

  const apply = (patch: Record<string, unknown>, colorMode = false) => {
    if (selected.length && scope) {
      scope.updateAnnotations(
        selected.map((a) => ({
          pageIndex: a.object.pageIndex,
          id: a.object.id,
          patch: colorMode ? patchFor(scope.findToolForAnnotation(a.object)?.id, patch.color as string) : patch,
        })),
      );
    } else if (activeToolId && cap) {
      cap.setToolDefaults(activeToolId, colorMode ? patchFor(activeToolId, patch.color as string) : patch);
      setTick((t) => t + 1);
    }
  };
  const deleteSelected = () => {
    if (selected.length && scope) scope.deleteAnnotations(selected.map((a) => ({ pageIndex: a.object.pageIndex, id: a.object.id })));
  };

  return (
    <aside className="cpdf__props" aria-label="Properties">
      <div className="cpdf__props-head">{selected.length > 0 ? 'Selection' : 'Tool style'}</div>
      <div className="cpdf__props-body">
          <div className="cpdf__field">
            <span className="cpdf__field-label">Color</span>
            <div className="cpdf__swatches">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="cpdf__swatch"
                  data-active={norm(c) === currentColor ? 'true' : undefined}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                  aria-pressed={norm(c) === currentColor}
                  onClick={() => apply({ color: c }, true)}
                />
              ))}
            </div>
          </div>
          {widthRelevant && (
            <div className="cpdf__field">
              <span className="cpdf__field-label">Stroke width</span>
              <div className="cpdf__widths">
                {STROKE_WIDTHS.map((w) => (
                  <button key={w} type="button" className="cpdf__wbtn" aria-label={`Stroke width ${w}`} onClick={() => apply({ strokeWidth: w })}>
                    <span style={{ height: w }} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {fontRelevant && (
            <div className="cpdf__field">
              <span className="cpdf__field-label">Font size</span>
              <div className="cpdf__widths">
                {FONT_SIZES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="cpdf__opbtn"
                    data-active={currentFontSize === s ? 'true' : undefined}
                    aria-pressed={currentFontSize === s}
                    onClick={() => apply({ fontSize: s })}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="cpdf__field">
            <span className="cpdf__field-label">Opacity</span>
            <div className="cpdf__widths">
              {OPACITIES.map((o) => (
                <button
                  key={o}
                  type="button"
                  className="cpdf__opbtn"
                  data-active={Math.abs(currentOpacity - o) < 0.01 ? 'true' : undefined}
                  aria-pressed={Math.abs(currentOpacity - o) < 0.01}
                  onClick={() => apply({ opacity: o })}
                >
                  {Math.round(o * 100)}%
                </button>
              ))}
            </div>
          </div>
          {selected.length > 0 && (
            <button type="button" className="cpdf__delete" onClick={deleteSelected}>
              <Icon name="trash" size={16} />
              Delete{selected.length > 1 ? ` (${selected.length})` : ''}
            </button>
          )}
        </div>
    </aside>
  );
}

/* ── Floating bottom view bar ─────────────────────────────────────────────── */
function BottomBar({
  documentId,
  searchOpen,
  onToggleSearch,
}: {
  documentId: string;
  searchOpen: boolean;
  onToggleSearch: () => void;
}) {
  const { state: zoom, provides: zoomApi } = useZoom(documentId);
  const { state: scroll, provides: scrollApi } = useScroll(documentId);
  const { provides: scrollCap } = useScrollCapability();
  const { provides: rotateApi } = useRotate(documentId);
  const { spreadMode, provides: spreadApi } = useSpread(documentId);
  const { state: fs, provides: fsApi } = useFullscreen();
  const { isPanning, provides: panApi } = usePan(documentId);
  const [horizontal, setHorizontal] = useState(false);

  const page = scroll?.currentPage ?? 1;
  const total = scroll?.totalPages ?? 0;
  const pct = Math.round((zoom?.currentZoomLevel ?? 1) * 100);

  return (
    <div className="cpdf__bottom" role="toolbar" aria-label="View controls">
      <div className="cpdf__group">
        <IconButton icon="search" label="Find in document" active={searchOpen} onClick={onToggleSearch} />
      </div>
      <span className="cpdf__sep" aria-hidden="true" />
      <div className="cpdf__group">
        <IconButton icon="chevron-left" label="Previous page" disabled={page <= 1} onClick={() => scrollApi?.scrollToPreviousPage()} />
        <span className="cpdf__pagebox">
          <input
            className="cpdf__pageinput"
            aria-label="Page number"
            inputMode="numeric"
            value={page}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (scrollApi && !Number.isNaN(n)) scrollApi.scrollToPage({ pageNumber: Math.min(Math.max(1, n), total || 1) });
            }}
          />
          <span className="cpdf__pagetotal">/ {total}</span>
        </span>
        <IconButton icon="chevron-right" label="Next page" disabled={total > 0 && page >= total} onClick={() => scrollApi?.scrollToNextPage()} />
      </div>
      <span className="cpdf__sep" aria-hidden="true" />
      <div className="cpdf__group">
        <IconButton icon="zoom-out" label="Zoom out" onClick={() => zoomApi?.zoomOut()} />
        <span className="cpdf__zoomlabel">{pct}%</span>
        <IconButton icon="zoom-in" label="Zoom in" onClick={() => zoomApi?.zoomIn()} />
        <IconButton icon="fit-width" label="Fit width" active={zoom?.zoomLevel === ZoomMode.FitWidth} onClick={() => zoomApi?.requestZoom(ZoomMode.FitWidth)} />
        <IconButton icon="fit-page" label="Fit page" active={zoom?.zoomLevel === ZoomMode.FitPage} onClick={() => zoomApi?.requestZoom(ZoomMode.FitPage)} />
      </div>
      <span className="cpdf__sep" aria-hidden="true" />
      <div className="cpdf__group">
        <IconButton icon="rotate" label="Rotate" onClick={() => rotateApi?.rotateForward()} />
        <IconButton icon="spread" label="Two-page spread" active={spreadMode !== SpreadMode.None} onClick={() => spreadApi?.setSpreadMode(spreadMode === SpreadMode.None ? SpreadMode.Odd : SpreadMode.None)} />
        <IconButton
          icon="scroll-h"
          label={horizontal ? 'Vertical scrolling' : 'Horizontal scrolling'}
          active={horizontal}
          onClick={() => {
            const next = !horizontal;
            setHorizontal(next);
            scrollCap?.setScrollStrategy(next ? ScrollStrategy.Horizontal : ScrollStrategy.Vertical, documentId);
          }}
        />
        <IconButton icon="hand" label="Pan" active={isPanning} onClick={() => panApi?.togglePan()} />
        <IconButton icon={fs.isFullscreen ? 'fullscreen-exit' : 'fullscreen-enter'} label={fs.isFullscreen ? 'Exit full screen' : 'Full screen'} active={fs.isFullscreen} onClick={() => fsApi?.toggleFullscreen(ROOT_ID)} />
      </div>
    </div>
  );
}

/* ── Find bar (floats top-right of the canvas) ────────────────────────────── */
function SearchPanel({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { state, provides } = useSearch(documentId);
  const { provides: scrollApi } = useScroll(documentId);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef(state?.results);
  resultsRef.current = state?.results;
  useEffect(() => inputRef.current?.focus(), []);
  // Search as you type (debounced) so results appear without pressing Enter.
  useEffect(() => {
    if (!provides) return;
    const term = q.trim();
    const id = setTimeout(() => {
      if (term) provides.searchAllPages(term);
      else provides.stopSearch();
    }, 250);
    return () => clearTimeout(id);
  }, [q, provides]);
  // Scroll the page to the active match whenever it changes (first/next/prev).
  useEffect(() => {
    if (!provides) return;
    return provides.onActiveResultChange((ev: number | { index: number }) => {
      const idx = typeof ev === 'number' ? ev : ev.index;
      const r = resultsRef.current?.[idx];
      const rect = r?.rects?.[0];
      if (r && rect && scrollApi) {
        scrollApi.scrollToPage({
          pageNumber: r.pageIndex + 1,
          pageCoordinates: { x: rect.origin.x, y: rect.origin.y },
        });
      }
    });
  }, [provides, scrollApi]);
  const total = state?.total ?? 0;
  const active = total > 0 ? (state?.activeResultIndex ?? 0) + 1 : 0;
  return (
    <div className="cpdf__search" role="search">
      <Icon name="search" size={16} />
      <input
        ref={inputRef}
        type="text"
        aria-label="Find in document"
        placeholder="Find in document…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.shiftKey ? provides?.previousResult() : provides?.nextResult();
          if (e.key === 'Escape') onClose();
        }}
      />
      <span className="cpdf__search-count">{state?.loading ? '…' : `${active}/${total}`}</span>
      <IconButton icon="chevron-left" label="Previous match" disabled={total === 0} onClick={() => provides?.previousResult()} />
      <IconButton icon="chevron-right" label="Next match" disabled={total === 0} onClick={() => provides?.nextResult()} />
      <IconButton icon="close" label="Close find" onClick={onClose} />
    </div>
  );
}

/* ── Left drawer: thumbnails / outline ────────────────────────────────────── */
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
    if (t?.type === 'destination' && t.destination) scrollApi?.scrollToPage({ pageNumber: t.destination.pageIndex + 1 });
  };
  const tree = (nodes: Bookmark[], depth = 0): ReactNode =>
    nodes.map((bm, i) => (
      <Fragment key={`${depth}-${i}-${bm.title}`}>
        <button type="button" className="cpdf__outline-item" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => go(bm)}>
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
        {!loaded ? <div className="cpdf__panel-empty">Loading…</div> : items.length ? tree(items) : <div className="cpdf__panel-empty">This document has no outline.</div>}
      </div>
    </aside>
  );
}

/* ── The viewer ───────────────────────────────────────────────────────────── */
export function Viewer({
  documentId,
  mode,
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

  const { state: anno, provides: annoApi } = useAnnotation(documentId);
  const { provides: history } = useHistoryCapability();
  const { provides: exportCap } = useExportCapability();
  const { state: fs } = useFullscreen();
  const activeToolId = anno?.activeToolId ?? null;
  // Presentation mode: full screen is a clean reading view — hide editing chrome.
  const presenting = fs.isFullscreen;
  const editing = mode !== 'view' && !presenting;

  // Imperative API for host menus.
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      download: () => exportCap?.download(),
      undo: () => history?.undo(),
      redo: () => history?.redo(),
      deleteSelection: () => {
        const sel = annoApi?.getSelectedAnnotations() ?? [];
        if (annoApi && sel.length) annoApi.deleteAnnotations(sel.map((a) => ({ pageIndex: a.object.pageIndex, id: a.object.id })));
      },
      setTool: (id) => annoApi?.setActiveTool(id),
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, annoApi, history, exportCap]);

  // Entering presentation (full screen) drops any active tool — it's read-only.
  useEffect(() => {
    if (presenting) annoApi?.setActiveTool(null);
  }, [presenting, annoApi]);

  // After placing a one-shot annotation, revert to Select so it's immediately
  // adjustable (EmbedPDF auto-selects it). Ink/markup tools stay active.
  useEffect(() => {
    if (!annoApi) return;
    return annoApi.onAnnotationEvent((ev) => {
      if (ev.type === 'create' && REVERT_AFTER_CREATE.has(annoApi.getActiveTool()?.id ?? '')) {
        annoApi.setActiveTool(null);
      }
    });
  }, [annoApi]);

  // Keyboard: editing shortcuts (ignored while typing in a field).
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      // Duplicate selection (⌘/Ctrl+D) — imported copies are re-id'd by the plugin.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        const sel = annoApi?.getSelectedAnnotations() ?? [];
        if (annoApi && sel.length) {
          e.preventDefault();
          annoApi.importAnnotations(sel.map((a) => ({ annotation: a.object })));
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        annoApi?.setActiveTool(null);
        annoApi?.deselectAnnotation();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const sel = annoApi?.getSelectedAnnotations() ?? [];
        if (annoApi && sel.length) {
          e.preventDefault();
          annoApi.deleteAnnotations(sel.map((a) => ({ pageIndex: a.object.pageIndex, id: a.object.id })));
        }
      } else if (e.key.toLowerCase() === 'v') {
        annoApi?.setActiveTool(null);
      } else {
        const tool = TOOLS.find((t) => t.key === e.key.toLowerCase());
        if (tool) annoApi?.setActiveTool(tool.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, annoApi]);

  return (
    <AnnotationRendererProvider>
      <div className="cpdf" id={ROOT_ID} data-tool={activeToolId ?? undefined}>
        <div className="cpdf__main">
          {!presenting && <LeftRail documentId={documentId} mode={mode} leftPanel={leftPanel} onToggleLeft={toggleLeft} />}
          {!presenting && leftPanel === 'thumbs' && <ThumbnailSidebar documentId={documentId} onClose={() => setLeftPanel(null)} />}
          {!presenting && leftPanel === 'outline' && <OutlineSidebar documentId={documentId} onClose={() => setLeftPanel(null)} />}
          <Viewport documentId={documentId} className="cpdf__viewport">
            <Scroller
              documentId={documentId}
              renderPage={({ width, height, pageIndex }) => (
                <PagePointerProvider documentId={documentId} pageIndex={pageIndex} className="cpdf__page" style={{ width, height, position: 'relative' }}>
                  <RenderLayer documentId={documentId} pageIndex={pageIndex} />
                  <SearchLayer documentId={documentId} pageIndex={pageIndex} />
                  {/* Text selection/copy in every mode; the interaction-manager
                      yields the pointer to an annotation tool when one is active. */}
                  <SelectionLayer documentId={documentId} pageIndex={pageIndex} />
                  <AnnotationLayer documentId={documentId} pageIndex={pageIndex} style={{ position: 'absolute', inset: 0 }} />
                </PagePointerProvider>
              )}
            />
          </Viewport>
          {editing && <PropertiesPanel documentId={documentId} />}
        </div>
        <BottomBar documentId={documentId} searchOpen={searchOpen} onToggleSearch={() => setSearchOpen((v) => !v)} />
        {searchOpen && <SearchPanel documentId={documentId} onClose={() => setSearchOpen(false)} />}
      </div>
    </AnnotationRendererProvider>
  );
}
