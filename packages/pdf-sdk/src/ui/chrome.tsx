// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

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
import { createPortal } from 'react-dom';
import { Viewport } from '@embedpdf/plugin-viewport/react';
import { Scroller } from '@embedpdf/plugin-scroll/react';
import { RenderLayer } from '@embedpdf/plugin-render/react';
import { useZoom, ZoomMode, ZoomGestureWrapper } from '@embedpdf/plugin-zoom/react';
import { useScroll, useScrollCapability, ScrollStrategy } from '@embedpdf/plugin-scroll/react';
import { useRotate } from '@embedpdf/plugin-rotate/react';
import { useSpread, SpreadMode } from '@embedpdf/plugin-spread/react';
import { useFullscreen } from '@embedpdf/plugin-fullscreen/react';
import { usePan } from '@embedpdf/plugin-pan/react';
import { useSearch, SearchLayer } from '@embedpdf/plugin-search/react';
import { SelectionLayer, useSelectionCapability } from '@embedpdf/plugin-selection/react';
import { ThumbnailsPane, ThumbImg } from '@embedpdf/plugin-thumbnail/react';
import { useBookmarkCapability } from '@embedpdf/plugin-bookmark/react';
import { useDocumentManagerCapability } from '@embedpdf/plugin-document-manager/react';
import { PagePointerProvider, usePointerHandlers } from '@embedpdf/plugin-interaction-manager/react';
import {
  useAnnotation,
  useAnnotationCapability,
  AnnotationLayer,
  AnnotationRendererProvider,
} from '@embedpdf/plugin-annotation/react';
import { LockModeType } from '@embedpdf/plugin-annotation';
import { Rotation } from '@embedpdf/models';
import { FormRendererRegistration, formRenderers } from '@embedpdf/plugin-form/react';
import {
  SignatureDrawPad,
  SignatureTypePad,
  useSignatureCapability,
  useActivePlacement,
  type SignatureDrawPadHandle,
  type SignatureTypePadHandle,
  type SignatureInkFieldDefinition,
  type SignatureStampFieldDefinition,
} from '@embedpdf/plugin-signature/react';
import { useHistoryCapability } from '@embedpdf/plugin-history/react';
import { useExportCapability } from '@embedpdf/plugin-export/react';
import { useRenderCapability } from '@embedpdf/plugin-render/react';
import { IconButton } from './IconButton';
import { Icon, type IconName } from './icons';
import type { Mode, CasualPdfApi } from '../modes';
import type { PdfTextRun } from '../textedit-pdfium';
import './viewer.css';

const ROOT_ID = 'cpdf-root';

type LeftPanel = 'thumbs' | 'outline' | 'comments' | null;

interface Bookmark {
  title: string;
  target?: { type: string; destination?: { pageIndex: number } };
  children?: Bookmark[];
}

/** Annotation tools (EmbedPDF tool ids) + a one-key shortcut. */
const TOOLS: { id: string; icon: IconName; label: string; key: string }[] = [
  { id: 'highlight', icon: 'marker', label: 'Highlight', key: 'h' },
  { id: 'underline', icon: 'underline', label: 'Underline', key: 'u' },
  { id: 'strikeout', icon: 'strikeout', label: 'Strikethrough', key: 'k' },
  { id: 'squiggly', icon: 'squiggly', label: 'Squiggly', key: 'g' },
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
// PdfStandardFont enum values: Helvetica=4, Times_Roman=8, Courier=0.
const FONT_FAMILIES: { label: string; value: number }[] = [
  { label: 'Sans', value: 4 },
  { label: 'Serif', value: 8 },
  { label: 'Mono', value: 0 },
];
// PdfTextAlignment: Left=0, Center=1, Right=2.
const TEXT_ALIGNS: { icon: IconName; value: number; label: string }[] = [
  { icon: 'align-left', value: 0, label: 'Align left' },
  { icon: 'align-center', value: 1, label: 'Align center' },
  { icon: 'align-right', value: 2, label: 'Align right' },
];
const STROKE_TOOLS = new Set(['ink', 'inkHighlighter', 'line', 'lineArrow', 'square', 'circle', 'polygon', 'polyline']);
const TEXT_TOOLS = new Set(['freeText', 'freeTextCallout']);
// Text-markup annotations render their color from `strokeColor`, not `color`.
const MARKUP_TOOLS = new Set(['highlight', 'underline', 'strikeout', 'squiggly']);
// One-shot tools: revert to Select after placing one (so it's immediately
// selected/adjustable). Ink + text-markup stay active for repeated use.
const REVERT_AFTER_CREATE = new Set(['square', 'circle', 'line', 'lineArrow', 'polygon', 'polyline', 'freeText', 'freeTextCallout', 'textComment', 'stamp']);
const patchFor = (toolId: string | undefined, color: string) =>
  toolId && (STROKE_TOOLS.has(toolId) || MARKUP_TOOLS.has(toolId))
    ? { strokeColor: color }
    : toolId && TEXT_TOOLS.has(toolId)
      ? { fontColor: color }
      : { color };
const norm = (c?: string) => (c ?? '').toLowerCase();
const genId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `cpdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// PdfAnnotationSubtype values for text markups (HIGHLIGHT=9, UNDERLINE=10, SQUIGGLY=11, STRIKEOUT=12).
const MARKUP_SUBTYPE: Record<string, number> = { highlight: 9, underline: 10, squiggly: 11, strikeout: 12 };

type AnnoRect = { origin: { x: number; y: number }; size: { width: number; height: number } };
const ptInRect = (p: { x: number; y: number }, r?: AnnoRect) =>
  !!r && p.x >= r.origin.x && p.x <= r.origin.x + r.size.width && p.y >= r.origin.y && p.y <= r.origin.y + r.size.height;
const boxFromPts = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
  x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
});
const boxHitsRect = (r: { x: number; y: number; w: number; h: number }, o?: AnnoRect) =>
  !!o && r.x < o.origin.x + o.size.width && r.x + r.w > o.origin.x && r.y < o.origin.y + o.size.height && r.y + r.h > o.origin.y;

/** Select-tool pointer behaviour on a page:
 *   • click empty space → deselect (EmbedPDF selects on click but never
 *     deselects on a background click);
 *   • drag empty space → rubber-band marquee: select every annotation the box
 *     touches (feeds the existing multi-select / bulk-style/-delete machinery).
 *
 *  A drag that begins on a glyph is a *text* selection, not a marquee — we watch
 *  for a text selection forming (getFormattedSelection becomes non-empty) and
 *  bow out, so marquee and the select-text→highlight/copy/redact flow coexist.
 *  Registered on the default 'pointerMode' (Select tool); drawing tools are
 *  unaffected. */
function MarqueeSelect({ documentId, pageIndex }: { documentId: string; pageIndex: number }) {
  const { provides: annoApi } = useAnnotation(documentId);
  const { provides: selectionCap } = useSelectionCapability();
  const { provides: docCap } = useDocumentManagerCapability();
  const { register } = usePointerHandlers({ modeId: 'pointerMode', pageIndex, documentId });
  const start = useRef<{ x: number; y: number } | null>(null);
  const textDrag = useRef(false);
  const moved = useRef(false);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const annsHere = () => (annoApi?.getAnnotations() ?? []).filter((a) => a.object.pageIndex === pageIndex);

  useEffect(() => {
    return register({
      onPointerDown: (pos) => {
        if (!annoApi) return;
        // Press on an existing annotation → let the plugin move/select it.
        if (annsHere().some((a) => ptInRect(pos, a.object.rect))) {
          start.current = null;
          return;
        }
        annoApi.deselectAnnotation();
        start.current = { x: pos.x, y: pos.y };
        textDrag.current = false;
        moved.current = false;
        setDraft(null);
      },
      onPointerMove: (pos) => {
        if (!start.current || textDrag.current) return;
        // A text selection forming means the drag began on glyphs — yield to it.
        if ((selectionCap?.getFormattedSelection(documentId)?.length ?? 0) > 0) {
          textDrag.current = true;
          setDraft(null);
          return;
        }
        const r = boxFromPts(start.current, pos);
        if (r.w > 1 || r.h > 1) moved.current = true;
        setDraft(r);
      },
      onPointerUp: (pos) => {
        if (start.current && moved.current && !textDrag.current && annoApi) {
          const r = boxFromPts(start.current, pos);
          const ids = annsHere().filter((a) => boxHitsRect(r, a.object.rect)).map((a) => a.object.id);
          if (ids.length) annoApi.setSelection(ids);
        }
        start.current = null;
        moved.current = false;
        textDrag.current = false;
        setDraft(null);
      },
    });
  }, [register, annoApi, selectionCap, documentId, pageIndex]);

  const size = docCap?.getDocument(documentId)?.pages?.[pageIndex]?.size as { width: number; height: number } | undefined;
  if (!draft || !size) return null;
  return (
    <div
      className="cpdf__marquee"
      style={{
        left: `${(draft.x / size.width) * 100}%`,
        top: `${(draft.y / size.height) * 100}%`,
        width: `${(draft.w / size.width) * 100}%`,
        height: `${(draft.h / size.height) * 100}%`,
      }}
    />
  );
}

/** A picked image awaiting placement: raw bytes + mime + natural aspect. */
interface PendingImage {
  data: ArrayBuffer;
  mimeType: 'image/png' | 'image/jpeg';
  w: number;
  h: number;
}

/** While an image is pending, the next click on a page drops it as a STAMP
 *  annotation (image baked into the appearance stream → persists on Download).
 *  Registered on the default Select mode so a plain click places it. */
function ImagePlacer({
  documentId,
  pageIndex,
  image,
  onPlaced,
}: {
  documentId: string;
  pageIndex: number;
  image: PendingImage;
  onPlaced: () => void;
}) {
  const { provides: annoApi } = useAnnotation(documentId);
  const { register } = usePointerHandlers({ modeId: 'pointerMode', pageIndex, documentId });
  useEffect(() => {
    return register({
      onPointerDown: (pos) => {
        if (!annoApi) return;
        // Default display width ~220pt, height by the image's natural aspect.
        const width = 220;
        const height = Math.max(24, Math.round(width * (image.h / image.w)));
        const stamp = {
          type: 13, // PdfAnnotationSubtype.STAMP
          id: genId(),
          pageIndex,
          rect: { origin: { x: pos.x, y: pos.y }, size: { width, height } },
        };
        // The stamp ctx ({ data, mimeType }) resolves to `undefined` on the base
        // annotation union (the plugin's own type carries it only on the stamp
        // member), so call through a loosened signature — same pattern the SDK
        // uses elsewhere for these union-typed plugin calls.
        (annoApi.createAnnotation as unknown as (p: number, a: unknown, c: unknown) => void)(
          pageIndex,
          stamp,
          { data: image.data, mimeType: image.mimeType },
        );
        onPlaced();
      },
    });
  }, [register, annoApi, pageIndex, image, onPlaced]);
  return null;
}

/** A marked redaction region in fractional page coordinates (0..1, top-left
 *  origin) — zoom-independent, so the same mark maps cleanly to the rendered
 *  image at any scale. */
interface RedactRect {
  id: number;
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const pctStyle = (r: { x: number; y: number; w: number; h: number }) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`,
});

/** Drag-to-mark redaction regions on a page. Captures fractional rects from its
 *  own bounding box (independent of EmbedPDF's pointer/coord system) and draws
 *  the committed + in-progress marks as red boxes. Each mark has an ✕ button
 *  (visible on hover) to remove it individually. Applying the marks rasterizes
 *  + flattens the page (see redact.ts). */
function RedactionLayer({
  pageIndex,
  redactions,
  onAdd,
  onRemove,
}: {
  pageIndex: number;
  redactions: RedactRect[];
  onAdd: (r: Omit<RedactRect, 'id'>) => void;
  onRemove: (mark: RedactRect) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const frac = (clientX: number, clientY: number) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: clamp01((clientX - b.left) / b.width), y: clamp01((clientY - b.top) / b.height) };
  };
  const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  });
  const mine = redactions.filter((r) => r.pageIndex === pageIndex);
  return (
    <div
      ref={ref}
      className="cpdf__redactlayer"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = frac(e.clientX, e.clientY);
        setDraft({ ...start.current, w: 0, h: 0 });
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        setDraft(rectFrom(start.current, frac(e.clientX, e.clientY)));
      }}
      onPointerUp={(e) => {
        if (start.current) {
          const r = rectFrom(start.current, frac(e.clientX, e.clientY));
          // Ignore stray clicks (require a minimum marked area).
          if (r.w > 0.005 && r.h > 0.005) onAdd({ pageIndex, ...r });
        }
        start.current = null;
        setDraft(null);
      }}
    >
      {mine.map((r) => (
        <div key={r.id} className="cpdf__redactrect" style={pctStyle(r)}>
          <button
            type="button"
            className="cpdf__redactrect-remove"
            aria-label="Remove redaction mark"
            title="Remove this mark"
            // Stop the pointer from starting a new drag on the parent layer.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onRemove(r); }}
          >✕</button>
        </div>
      ))}
      {draft && <div className="cpdf__redactrect cpdf__redactrect--draft" style={pctStyle(draft)} />}
    </div>
  );
}

/** Render a page Blob to a canvas, paint opaque black over the fractional
 *  redaction rects (top-left fractional coords map directly to canvas pixels),
 *  and return PNG bytes. The output page geometry is taken from the source page
 *  (buildRedactedPdf), not the image, so a `/Rotate`d or offset page isn't
 *  distorted. Throws if the bitmap can't be decoded or the canvas can't encode —
 *  callers must treat that as a hard failure (never silently skip a page). */
async function flattenPage(blob: Blob, rects: { x: number; y: number; w: number; h: number }[]): Promise<Uint8Array> {
  const img = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    img.close();
    throw new Error('redaction: no 2D canvas context');
  }
  ctx.drawImage(img, 0, 0);
  img.close();
  ctx.fillStyle = '#000';
  for (const r of rects) {
    ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
  }
  const out: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), 'image/png'));
  if (!out) throw new Error('redaction: canvas encode failed (page too large?)');
  return new Uint8Array(await out.arrayBuffer());
}

/** Tier-2 text editing overlay (one per page). Lists the page's text runs from
 *  the current document bytes (PDFium), draws a clickable box over each, and on
 *  click opens an inline input that auto-commits on blur (click-outside = save).
 *  Run bounds are PDFium user space (bottom-left origin), mapped to the page
 *  overlay with a y-flip. Font-size is computed from the run's height in CSS px. */
function TextEditLayer({
  documentId,
  pageIndex,
  bytes,
  onCommit,
  onReady,
  editBusy,
}: {
  documentId: string;
  pageIndex: number;
  bytes: Uint8Array;
  onCommit: (pageIndex: number, objectIndex: number, objectIndices: number[], newText: string) => void;
  onReady?: () => void;
  editBusy?: boolean;
}) {
  const { provides: docCap } = useDocumentManagerCapability();
  // Keep previous runs while re-fetching so there's no loading flash on each commit.
  const [runs, setRuns] = useState<PdfTextRun[] | null>(null);
  const [active, setActive] = useState<{ index: number; indices: number[]; text: string } | null>(null);
  const size = docCap?.getDocument(documentId)?.pages?.[pageIndex]?.size as { width: number; height: number } | undefined;
  const layerRef = useRef<HTMLDivElement>(null);
  const [pagePxH, setPagePxH] = useState(0);
  // Fire onReady only once per tool activation (not after every commit re-fetch).
  const firstRunsDoneRef = useRef(false);
  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const update = () => setPagePxH(el.offsetHeight);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);
  // Guard against onBlur firing after Enter/Escape already handled the action.
  const suppressBlurRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Do NOT reset runs to null — keep previous runs visible while re-fetching
    // so there's no "Analyzing text…" spinner after each commit.
    import('../textedit-pdfium')
      .then(({ listTextRuns }) => listTextRuns(bytes, pageIndex))
      .then((r) => {
        if (!cancelled) {
          setRuns(r);
          if (!firstRunsDoneRef.current) {
            firstRunsDoneRef.current = true;
            onReady?.();
          }
        }
      })
      .catch(() => !cancelled && setRuns([]));
    return () => { cancelled = true; };
  }, [bytes, pageIndex]);

  if (!size) return null;
  // Show a minimal loading layer only on the very first load (runs === null).
  if (!runs) {
    return (
      <div ref={layerRef} className="cpdf__textedit" aria-live="polite" aria-label="Analyzing text…">
        <div className="cpdf__textedit-loading">Analyzing text…</div>
      </div>
    );
  }

  const boxStyle = (r: PdfTextRun): React.CSSProperties => ({
    left: `${(r.left / size.width) * 100}%`,
    top: `${((size.height - r.top) / size.height) * 100}%`,
    width: `${((r.right - r.left) / size.width) * 100}%`,
    height: `${((r.top - r.bottom) / size.height) * 100}%`,
  });

  // Build the full style for the active input: position from PDF bounds,
  // font properties extracted from PDFium so the input visually matches.
  // fontSizePt = rendered size in PDF user space (design × text-matrix scale).
  // × page_scale → CSS px; × 0.82 corrects for CSS em-square > visual glyph height.
  const inputStyle = (r: PdfTextRun): React.CSSProperties => {
    const scale = pagePxH && size?.height ? pagePxH / size.height : 0;
    const fsPx = scale > 0 ? Math.round(r.fontSizePt * scale * 0.82) : undefined;
    const isDark = document.documentElement.dataset.theme === 'dark';
    return {
      ...boxStyle(r),
      fontFamily: r.fontFamily,
      fontWeight: r.fontWeight,
      fontStyle: r.fontItalic ? 'italic' : 'normal',
      color: isDark ? '#f0f0f0' : r.color,
      ...(fsPx && fsPx > 4 ? { fontSize: `${fsPx}px` } : {}),
    };
  };

  // Tab-order: top-to-bottom, then left-to-right (reading order).
  const sortedRuns = [...runs].sort((a, b) => {
    const dy = Math.round((b.top - a.top) * 10);
    return dy !== 0 ? dy : a.left - b.left;
  });

  // Commit current text and optionally activate the next run (Tab navigation).
  const commitAndMove = (
    index: number, indices: number[], text: string, original: string,
    nextRun: PdfTextRun | null,
  ) => {
    suppressBlurRef.current = true;
    if (text.trim() && text !== original) onCommit(pageIndex, index, indices, text);
    setActive(nextRun ? { index: nextRun.index, indices: nextRun.indices, text: nextRun.text } : null);
  };

  // Cancel — revert to original without saving.
  const cancel = () => {
    suppressBlurRef.current = true;
    setActive(null);
  };

  return (
    <div ref={layerRef} className="cpdf__textedit">
      {runs.map((r) =>
        active?.index === r.index ? (
          <input
            key={r.index}
            className="cpdf__textedit-input"
            style={inputStyle(r)}
            autoFocus
            value={active.text}
            aria-label="Edit text"
            onFocus={(e) => {
              suppressBlurRef.current = false;
              e.currentTarget.select();
            }}
            onChange={(e) => setActive({ index: r.index, indices: r.indices, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitAndMove(r.index, r.indices, active.text, r.text, null);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              } else if (e.key === 'Tab') {
                e.preventDefault();
                const ci = sortedRuns.findIndex((x) => x.index === r.index);
                const next = e.shiftKey
                  ? (ci > 0 ? sortedRuns[ci - 1] : null)
                  : (ci < sortedRuns.length - 1 ? sortedRuns[ci + 1] : null);
                commitAndMove(r.index, r.indices, active.text, r.text, next);
              }
            }}
            onBlur={(e) => {
              // Don't commit while a previous commit is in-flight — the bytes
              // snapshot is still updating and a double-commit would corrupt the run.
              if (editBusy) return;
              if (suppressBlurRef.current) { suppressBlurRef.current = false; return; }
              const rel = e.relatedTarget as HTMLElement | null;
              const clickingOtherRun = !!rel?.classList.contains('cpdf__textedit-run');
              // Always commit on blur (whether moving to another run or clicking outside).
              // When clicking another run, onBlur fires first; that button's onClick will
              // activate it — so we just need to commit and NOT call setActive(null).
              if (active.text.trim() && active.text !== r.text) {
                onCommit(pageIndex, r.index, r.indices, active.text);
              }
              if (!clickingOtherRun) setActive(null);
              // If clicking another run: keep active momentarily; that run's onClick fires
              // immediately after and sets the new active. No setActive(null) = no flicker.
            }}
          />
        ) : (
          <button
            key={r.index}
            type="button"
            className="cpdf__textedit-run"
            style={boxStyle(r)}
            title={r.fontSubsetted ? `${r.text}\n(Font is subsetted — editing may change the typeface)` : r.text}
            aria-label={`Edit text: ${r.text}`}
            disabled={editBusy}
            onClick={() => {
              // onBlur on the previously active input already committed it.
              // Just activate this run.
              setActive({ index: r.index, indices: r.indices, text: r.text });
            }}
          />
        ),
      )}
    </div>
  );
}

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
    </button>
  );
}

function LeftRail({
  documentId,
  mode,
  leftPanel,
  onToggleLeft,
  onOrganize,
  onSign,
  onInsertImage,
  redacting,
  onToggleRedact,
  textEditing,
  onToggleTextEdit,
  onUndo,
  onRedo,
}: {
  documentId: string;
  mode: Mode;
  leftPanel: LeftPanel;
  onToggleLeft: (p: 'thumbs' | 'outline' | 'comments') => void;
  onOrganize: () => void;
  onSign: () => void;
  onInsertImage: () => void;
  redacting: boolean;
  onToggleRedact: () => void;
  textEditing: boolean;
  onToggleTextEdit: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  const { state: anno, provides: annoApi } = useAnnotation(documentId);
  const { provides: history } = useHistoryCapability();
  const activeToolId = anno?.activeToolId ?? null;
  const editing = mode !== 'view';

  // Track annotation-history availability so undo/redo buttons reflect real state.
  const [annoCanUndo, setAnnoCanUndo] = useState(false);
  const [annoCanRedo, setAnnoCanRedo] = useState(false);
  useEffect(() => {
    if (!history) return;
    const update = () => {
      setAnnoCanUndo(history.canUndo());
      setAnnoCanRedo(history.canRedo());
    };
    update();
    return history.onHistoryChange(update);
  }, [history]);

  return (
    <div className="cpdf__rail" role="toolbar" aria-orientation="vertical" aria-label="Tools">
      <RailBtn icon="thumbnails" label="Pages" title="Page thumbnails" active={leftPanel === 'thumbs'} onClick={() => onToggleLeft('thumbs')} />
      <RailBtn icon="outline" label="Outline" title="Document outline" active={leftPanel === 'outline'} onClick={() => onToggleLeft('outline')} />
      <RailBtn icon="comments" label="Comments" title="Comments & annotations" active={leftPanel === 'comments'} onClick={() => onToggleLeft('comments')} />
      {editing && (
        <>
          <span className="cpdf__rail-sep" aria-hidden="true" />
          <RailBtn icon="text-tool" label="Edit text" title="Edit existing text" active={textEditing} onClick={onToggleTextEdit} />
          <RailBtn icon="image" label="Image" title="Insert an image" onClick={onInsertImage} />
          <RailBtn icon="redact" label="Redact" title="Redact (permanently remove regions)" active={redacting} onClick={onToggleRedact} />
          <RailBtn icon="sign" label="Sign" title="Add a signature" onClick={onSign} />
          <RailBtn icon="organize" label="Organize" title="Organize pages (reorder / delete)" onClick={onOrganize} />
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
          <RailBtn icon="undo" label="Undo" title="Undo (⌘Z)" disabled={!annoCanUndo && !onUndo} onClick={() => onUndo ? onUndo() : history?.undo()} />
          <RailBtn icon="redo" label="Redo" title="Redo (⌘⇧Z)" disabled={!annoCanRedo && !onRedo} onClick={() => onRedo ? onRedo() : history?.redo()} />
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
    | { color?: string; strokeColor?: string; fontColor?: string; opacity?: number; fontSize?: number; strokeWidth?: number; fontFamily?: number; textAlign?: number }
    | undefined;
  const toolDefaults = activeToolId ? (cap?.getTool(activeToolId)?.defaults as Record<string, unknown> | undefined) : undefined;
  const currentColor = norm(
    firstObj?.fontColor ?? firstObj?.strokeColor ?? firstObj?.color ??
      (toolDefaults?.fontColor as string) ?? (toolDefaults?.strokeColor as string) ?? (toolDefaults?.color as string),
  );
  const currentOpacity = firstObj?.opacity ?? (toolDefaults?.opacity as number) ?? 1;
  const currentFontSize = firstObj?.fontSize ?? (toolDefaults?.fontSize as number) ?? 16;
  const currentStrokeWidth = firstObj?.strokeWidth ?? (toolDefaults?.strokeWidth as number) ?? 2;
  const currentFontFamily = firstObj?.fontFamily ?? (toolDefaults?.fontFamily as number) ?? 4; // Helvetica
  const currentAlign = firstObj?.textAlign ?? (toolDefaults?.textAlign as number) ?? 0; // Left
  const relevant = (set: Set<string>) =>
    (activeToolId !== null && set.has(activeToolId)) ||
    selected.some((a) => set.has(scope?.findToolForAnnotation(a.object)?.id ?? ''));
  const widthRelevant = relevant(STROKE_TOOLS);
  const fontRelevant = relevant(TEXT_TOOLS);
  // A single selected comment note: its text lives in `contents` (edited here).
  const note =
    selected.length === 1 && scope && scope.findToolForAnnotation(selected[0].object)?.id === 'textComment'
      ? (selected[0].object as { id: string; pageIndex: number; contents?: string })
      : null;

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
      <div className="cpdf__props-head">{note ? 'Comment' : selected.length > 0 ? 'Selection' : 'Tool style'}</div>
      <div className="cpdf__props-body">
          {note && (
            <div className="cpdf__field">
              <span className="cpdf__field-label">Comment</span>
              <textarea
                key={note.id}
                className="cpdf__comment-input"
                defaultValue={note.contents ?? ''}
                placeholder="Type your comment…"
                rows={4}
                autoFocus
                onChange={(e) =>
                  scope?.updateAnnotations([{ pageIndex: note.pageIndex, id: note.id, patch: { contents: e.target.value } }])
                }
              />
            </div>
          )}
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
              {/* Custom color — a rainbow chip that opens the native picker for
                  any color beyond the presets. Shows the picked color when the
                  current color isn't one of the swatches. */}
              {(() => {
                const isCustom = !!currentColor && !PALETTE.some((c) => norm(c) === currentColor);
                const hex = /^#[0-9a-f]{6}$/.test(currentColor) ? currentColor : PALETTE[0];
                return (
                  <label
                    className="cpdf__swatch cpdf__swatch--custom"
                    data-active={isCustom ? 'true' : undefined}
                    title="Custom color"
                    style={isCustom ? { background: currentColor } : undefined}
                  >
                    <input
                      type="color"
                      aria-label="Custom color"
                      value={hex}
                      onChange={(e) => apply({ color: e.target.value }, true)}
                    />
                  </label>
                );
              })()}
            </div>
          </div>
          {widthRelevant && (
            <div className="cpdf__field">
              <span className="cpdf__field-label">Stroke width</span>
              <div className="cpdf__widths">
                {STROKE_WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className="cpdf__wbtn"
                    data-active={currentStrokeWidth === w ? 'true' : undefined}
                    aria-label={`Stroke width ${w}`}
                    aria-pressed={currentStrokeWidth === w}
                    onClick={() => apply({ strokeWidth: w })}
                  >
                    <span style={{ height: w }} />
                  </button>
                ))}
                <input
                  type="number"
                  className="cpdf__numinput"
                  min={1}
                  max={72}
                  step={1}
                  value={currentStrokeWidth}
                  aria-label="Custom stroke width"
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (!Number.isNaN(n)) apply({ strokeWidth: Math.min(72, Math.max(1, n)) });
                  }}
                />
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
                <input
                  type="number"
                  className="cpdf__numinput"
                  min={6}
                  max={144}
                  step={1}
                  value={currentFontSize}
                  aria-label="Custom font size"
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (!Number.isNaN(n)) apply({ fontSize: Math.min(144, Math.max(6, n)) });
                  }}
                />
              </div>
            </div>
          )}
          {fontRelevant && (
            <div className="cpdf__field">
              <span className="cpdf__field-label">Font</span>
              <div className="cpdf__widths">
                {FONT_FAMILIES.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    className="cpdf__opbtn"
                    data-active={currentFontFamily === f.value ? 'true' : undefined}
                    aria-pressed={currentFontFamily === f.value}
                    onClick={() => apply({ fontFamily: f.value })}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {fontRelevant && (
            <div className="cpdf__field">
              <span className="cpdf__field-label">Alignment</span>
              <div className="cpdf__widths">
                {TEXT_ALIGNS.map((al) => (
                  <button
                    key={al.value}
                    type="button"
                    className="cpdf__wbtn"
                    data-active={currentAlign === al.value ? 'true' : undefined}
                    aria-label={al.label}
                    aria-pressed={currentAlign === al.value}
                    onClick={() => apply({ textAlign: al.value })}
                  >
                    <Icon name={al.icon} size={18} />
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
              <input
                type="number"
                className="cpdf__numinput"
                min={5}
                max={100}
                step={5}
                value={Math.round(currentOpacity * 100)}
                aria-label="Custom opacity percent"
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (!Number.isNaN(n)) apply({ opacity: Math.min(1, Math.max(0.05, n / 100)) });
                }}
              />
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

/* ── Zoom-level preset menu (the % in the view bar) ───────────────────────── */
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 4];
function ZoomMenu({ pct, zoomApi }: { pct: number; zoomApi: ReturnType<typeof useZoom>['provides'] }) {
  const [open, setOpen] = useState(false);
  // Anchor rect captured at open time. The popover is portaled to <body> so it
  // escapes the view bar's `overflow-x:auto` clip + `transform` containing block.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  const toggle = () => {
    if (!open && btnRef.current) setAnchor(btnRef.current.getBoundingClientRect());
    setOpen((v) => !v);
  };
  const pick = (level: number) => {
    zoomApi?.requestZoom(level);
    setOpen(false);
  };
  return (
    <div className="cpdf__zoommenu">
      <button
        ref={btnRef}
        type="button"
        className="cpdf__zoomlabel"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Zoom level"
        onClick={toggle}
      >
        {pct}%
      </button>
      {open && anchor &&
        createPortal(
          <div
            ref={popRef}
            className="cpdf__zoompop"
            role="menu"
            aria-label="Zoom level"
            style={{ left: anchor.left + anchor.width / 2, bottom: window.innerHeight - anchor.top + 8 }}
          >
            {ZOOM_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitemradio"
                aria-checked={Math.round(p * 100) === pct}
                data-active={Math.round(p * 100) === pct ? 'true' : undefined}
                className="cpdf__zoomopt"
                onClick={() => pick(p)}
              >
                {Math.round(p * 100)}%
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
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
  // A document swap (organize / redaction rebuild → new id) resets scrolling to
  // the default vertical strategy; keep the toggle's state in sync.
  useEffect(() => setHorizontal(false), [documentId]);
  // Page-number field: a draft while the user types (null = show current page).
  const [pageDraft, setPageDraft] = useState<string | null>(null);

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
            value={pageDraft ?? String(page)}
            onChange={(e) => setPageDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              else if (e.key === 'Escape') {
                setPageDraft(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
            onBlur={() => {
              if (pageDraft != null && pageDraft !== '') {
                const n = parseInt(pageDraft, 10);
                if (scrollApi && !Number.isNaN(n)) scrollApi.scrollToPage({ pageNumber: Math.min(Math.max(1, n), total || 1) });
              }
              setPageDraft(null);
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
          <span className="cpdf__pagetotal">/ {total}</span>
        </span>
        <IconButton icon="chevron-right" label="Next page" disabled={total > 0 && page >= total} onClick={() => scrollApi?.scrollToNextPage()} />
      </div>
      <span className="cpdf__sep" aria-hidden="true" />
      <div className="cpdf__group">
        <IconButton icon="zoom-out" label="Zoom out" onClick={() => zoomApi?.zoomOut()} />
        <ZoomMenu pct={pct} zoomApi={zoomApi} />
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
function SearchPanel({
  documentId,
  onClose,
  canRedact,
  onRedactMatches,
}: {
  documentId: string;
  onClose: () => void;
  canRedact?: boolean;
  onRedactMatches?: (results: { pageIndex: number; rects: { origin: { x: number; y: number }; size: { width: number; height: number } }[] }[]) => void;
}) {
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
      {canRedact && onRedactMatches && (
        <>
          <span className="cpdf__sep" aria-hidden="true" />
          <IconButton
            icon="redact"
            label={`Redact all ${total} match${total === 1 ? '' : 'es'}`}
            disabled={total === 0}
            onClick={() => onRedactMatches(state?.results ?? [])}
          />
        </>
      )}
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
              style={{ position: 'absolute', top: m.top, left: 0, right: 0, height: m.wrapperHeight }}
              onClick={() => provides?.scrollToPage({ pageNumber: m.pageIndex + 1 })}
            >
              <ThumbImg documentId={documentId} meta={m} style={{ width: m.width, height: m.height }} />
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
    if (!scope) {
      // No bookmark capability yet — don't spin forever; show the empty state.
      setLoaded(true);
      return;
    }
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
        {!loaded ? (
          <div className="cpdf__empty">
            <span className="cpdf__spinner" aria-hidden="true" />
            <span className="cpdf__empty-title">Loading outline…</span>
          </div>
        ) : items.length ? (
          tree(items)
        ) : (
          <div className="cpdf__empty">
            <span className="cpdf__empty-icon">
              <Icon name="outline" size={28} />
            </span>
            <span className="cpdf__empty-title">No outline</span>
            <span className="cpdf__empty-hint">This document has no bookmarks or table of contents.</span>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ── Comments / annotations review panel: every annotation in the document,
   click to scroll to + select it. ─────────────────────────────────────────── */
function CommentsSidebar({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { state: anno, provides: scope } = useAnnotation(documentId);
  const { provides: scrollApi } = useScroll(documentId);
  // Re-read on any annotation state change (anno) so the list stays live.
  void anno;
  const items = (scope?.getAnnotations() ?? [])
    .slice()
    .sort(
      (a, b) =>
        a.object.pageIndex - b.object.pageIndex ||
        (a.object.rect?.origin.y ?? 0) - (b.object.rect?.origin.y ?? 0),
    );
  const meta = (obj: { contents?: string }, toolId?: string): { icon: IconName; label: string } => {
    if (toolId === 'textComment') {
      const text = (obj.contents ?? '').trim();
      return { icon: 'note', label: text || 'Empty comment' };
    }
    const t = TOOLS.find((x) => x.id === toolId);
    const note = (obj.contents ?? '').trim();
    return { icon: t?.icon ?? 'note', label: note || t?.label?.replace(' box', '') || 'Annotation' };
  };
  const go = (pageIndex: number, id: string) => {
    scrollApi?.scrollToPage({ pageNumber: pageIndex + 1 });
    scope?.selectAnnotation(pageIndex, id);
  };
  return (
    <aside className="cpdf__panel" aria-label="Comments">
      <div className="cpdf__panel-head">
        <span>Comments</span>
        <IconButton icon="close" label="Close comments" onClick={onClose} />
      </div>
      <div className="cpdf__panel-body">
        {items.length ? (
          items.map((a) => {
            const m = meta(a.object, scope?.findToolForAnnotation(a.object)?.id);
            return (
              <button
                key={a.object.id}
                type="button"
                className="cpdf__comment-row"
                onClick={() => go(a.object.pageIndex, a.object.id)}
              >
                <span className="cpdf__comment-row-icon">
                  <Icon name={m.icon} size={16} />
                </span>
                <span className="cpdf__comment-row-text">{m.label}</span>
                <span className="cpdf__comment-row-page">p.{a.object.pageIndex + 1}</span>
              </button>
            );
          })
        ) : (
          <div className="cpdf__empty">
            <span className="cpdf__empty-icon">
              <Icon name="comments" size={28} />
            </span>
            <span className="cpdf__empty-title">No comments yet</span>
            <span className="cpdf__empty-hint">Annotations and comments you add will appear here.</span>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ── Read-only sticky-note popup shown on the page when a comment is selected
   (used in View mode for reading). Editing happens in the properties panel —
   EmbedPDF's selection-menu container can't host a focusable textarea. ────── */
type NoteObj = { id: string; pageIndex: number; contents?: string };
function StickyComment({ note }: { note: NoteObj }) {
  const text = (note.contents ?? '').trim();
  return (
    <div className="cpdf__sticky" onPointerDown={(e) => e.stopPropagation()}>
      <div className="cpdf__sticky-head">
        <Icon name="note" size={14} />
        Comment
      </div>
      <div className="cpdf__sticky-body" data-empty={text ? undefined : 'true'}>
        {text || 'No comment yet'}
      </div>
    </div>
  );
}

/* ── Organize Pages: reorder/delete pages, then rebuild the doc (engine
   mergePages) and reload it (openDocumentBuffer). ─────────────────────────── */
type MergeEngine = {
  mergePages: (configs: { docId: string; pageIndices: number[] }[]) => { toPromise: () => Promise<{ content: ArrayBuffer }> };
} | null | undefined;
function OrganizeOverlay({
  documentId,
  engine,
  totalPages,
  onClose,
  onApplied,
  onDocumentReplaced,
}: {
  documentId: string;
  engine: MergeEngine;
  totalPages: number;
  onClose: () => void;
  onApplied?: () => void;
  onDocumentReplaced?: (bytes: Uint8Array) => void;
}) {
  const { provides: docCap } = useDocumentManagerCapability();
  const [order, setOrder] = useState<number[]>(() => Array.from({ length: totalPages }, (_, i) => i));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escape closes the overlay (unless mid-apply).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  const move = (i: number, dir: -1 | 1) =>
    setOrder((o) => {
      const j = i + dir;
      if (j < 0 || j >= o.length) return o;
      const n = [...o];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  const del = (i: number) => setOrder((o) => (o.length > 1 ? o.filter((_, k) => k !== i) : o));
  const apply = async () => {
    if (!engine || !docCap || !order.length) return;
    setBusy(true);
    setError(null);
    try {
      const file = await engine.mergePages([{ docId: documentId, pageIndices: order }]).toPromise();
      if (onDocumentReplaced) {
        onDocumentReplaced(new Uint8Array(file.content));
      } else {
        await docCap.openDocumentBuffer({ buffer: file.content, name: 'organized.pdf', autoActivate: true }).toPromise();
      }
      onApplied?.();
      onClose();
    } catch {
      setError("Couldn't apply the page changes. Try again.");
      setBusy(false);
    }
  };
  return (
    <div className="cpdf__organize" role="dialog" aria-modal="true" aria-label="Organize pages">
      <div className="cpdf__organize-bar">
        <span className="cpdf__organize-title">Organize pages</span>
        <span className="cpdf__organize-hint">{error ? error : `${order.length} page${order.length === 1 ? '' : 's'}`}</span>
        <div className="cpdf__organize-acts">
          <button type="button" className="cpdf__btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="cpdf__btn cpdf__btn--primary" onClick={apply} disabled={busy || !order.length}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
      <div className="cpdf__organize-grid">
        {order.map((pageIndex, i) => (
          <div key={pageIndex} className="cpdf__organize-cell">
            <div className="cpdf__organize-thumb">
              <RenderLayer documentId={documentId} pageIndex={pageIndex} scale={0.22} aria-label={`Page ${pageIndex + 1}`} />
            </div>
            <div className="cpdf__organize-cellbar">
              <button type="button" className="cpdf-iconbtn" title="Move left" aria-label="Move left" disabled={i === 0} onClick={() => move(i, -1)}>
                <Icon name="chevron-left" size={16} />
              </button>
              <span className="cpdf__organize-num">{i + 1}</span>
              <button type="button" className="cpdf-iconbtn" title="Move right" aria-label="Move right" disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                <Icon name="chevron-right" size={16} />
              </button>
              <button type="button" className="cpdf-iconbtn" title="Delete page" aria-label="Delete page" onClick={() => del(i)}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── E-signature: draw or type a signature, then place it on the page ─────────
   The pads emit a field definition (ink for draw, image-stamp for type) via
   onResult; "Add signature" stores it (addEntry) and activates placement — the
   signature plugin turns that into the signatureStamp/signatureInk annotation
   tool, so the next click/drag on a page drops a real annotation that renders
   through the AnnotationLayer (and bakes into the PDF on Download/export). */
const SIG_INK_COLORS = ['#1a3b8c', '#1f2430', '#0a6b3b'];
const SIG_FONTS = [
  { label: 'Signature', family: '"Brush Script MT","Segoe Script",cursive' },
  { label: 'Formal', family: 'Georgia,"Times New Roman",serif' },
  { label: 'Print', family: '"Helvetica Neue",Arial,sans-serif' },
];
function SignatureModal({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { provides: cap } = useSignatureCapability();
  const [tab, setTab] = useState<'draw' | 'type'>('draw');
  const [draw, setDraw] = useState<SignatureInkFieldDefinition | null>(null);
  const [typed, setTyped] = useState<SignatureStampFieldDefinition | null>(null);
  const [color, setColor] = useState(SIG_INK_COLORS[0]);
  const [font, setFont] = useState(SIG_FONTS[0].family);
  const drawPadRef = useRef<SignatureDrawPadHandle | null>(null);
  const typePadRef = useRef<SignatureTypePadHandle | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const result = tab === 'draw' ? draw : typed;

  // Modal a11y: focus in, Escape to close, trap Tab within the dialog, restore
  // focus to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement;
        if (!dialogRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected && opener !== document.body) opener.focus();
    };
  }, [onClose]);

  const clear = () => {
    if (tab === 'draw') {
      drawPadRef.current?.clear();
      setDraw(null);
    } else {
      typePadRef.current?.clear();
      setTyped(null);
    }
  };
  const place = () => {
    if (!cap || !result) return;
    const entryId = cap.addEntry({ signature: result });
    cap.forDocument(documentId).activateSignaturePlacement(entryId);
    onClose();
  };

  return (
    <div className="cpdf__scrim" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="cpdf__sigmodal"
        role="dialog"
        aria-modal="true"
        aria-label="Add a signature"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cpdf__sigmodal-head">
          <span className="cpdf__sigmodal-title">Add your signature</span>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="cpdf__sigtabs" role="tablist" aria-label="Signature type">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'draw'}
            className="cpdf__sigtab"
            data-active={tab === 'draw' ? 'true' : undefined}
            onClick={() => setTab('draw')}
          >
            <Icon name="draw" size={18} />
            Draw
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'type'}
            className="cpdf__sigtab"
            data-active={tab === 'type' ? 'true' : undefined}
            onClick={() => setTab('type')}
          >
            <Icon name="keyboard" size={18} />
            Type
          </button>
        </div>

        <div className="cpdf__sigbody">
          {tab === 'draw' ? (
            <SignatureDrawPad
              padRef={(h) => (drawPadRef.current = h)}
              onResult={setDraw}
              strokeColor={color}
              strokeWidth={3}
              className="cpdf__sigpad"
            />
          ) : (
            <SignatureTypePad
              padRef={(h) => (typePadRef.current = h)}
              onResult={setTyped}
              fontFamily={font}
              fontSize={48}
              color={color}
              placeholder="Type your name"
              className="cpdf__sigpad"
            />
          )}
        </div>

        <div className="cpdf__sigopts">
          <div className="cpdf__field">
            <span className="cpdf__field-label">Color</span>
            <div className="cpdf__swatches">
              {SIG_INK_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="cpdf__swatch"
                  data-active={c === color ? 'true' : undefined}
                  style={{ background: c }}
                  aria-label={`Ink color ${c}`}
                  aria-pressed={c === color}
                  onClick={() => setColor(c)}
                />
              ))}
              {(() => {
                const isCustom = !SIG_INK_COLORS.includes(color);
                return (
                  <label
                    className="cpdf__swatch cpdf__swatch--custom"
                    data-active={isCustom ? 'true' : undefined}
                    title="Custom ink color"
                    style={isCustom ? { background: color } : undefined}
                  >
                    <input
                      type="color"
                      aria-label="Custom ink color"
                      value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : SIG_INK_COLORS[0]}
                      onChange={(e) => setColor(e.target.value)}
                    />
                  </label>
                );
              })()}
            </div>
          </div>
          {tab === 'type' && (
            <div className="cpdf__field">
              <span className="cpdf__field-label">Style</span>
              <div className="cpdf__widths">
                {SIG_FONTS.map((f) => (
                  <button
                    key={f.label}
                    type="button"
                    className="cpdf__opbtn"
                    data-active={f.family === font ? 'true' : undefined}
                    aria-pressed={f.family === font}
                    style={{ fontFamily: f.family }}
                    onClick={() => setFont(f.family)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="cpdf__sigfoot">
          <button type="button" className="cpdf__btn" onClick={clear}>
            <Icon name="refresh" size={16} />
            Clear
          </button>
          <span style={{ flex: 1 }} />
          <button ref={closeRef} type="button" className="cpdf__btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cpdf__btn cpdf__btn--primary" disabled={!result} onClick={place}>
            Add signature
          </button>
        </div>
      </div>
    </div>
  );
}

/** When a signature placement is armed, a banner tells the user to click a page
 *  to drop it (and offers a cancel). Driven by the signature plugin's active
 *  placement for this document. */
function PlacementBanner({ documentId }: { documentId: string }) {
  const placement = useActivePlacement(documentId);
  const { provides: cap } = useSignatureCapability();
  if (!placement) return null;
  return (
    <div className="cpdf__placebanner" role="status">
      <Icon name="sign" size={18} />
      <span>Click on a page to place your signature</span>
      <button type="button" className="cpdf__btn" onClick={() => cap?.forDocument(documentId).deactivatePlacement()}>
        Cancel
      </button>
    </div>
  );
}

/* ── The viewer ───────────────────────────────────────────────────────────── */
export function Viewer({
  documentId,
  mode,
  apiRef,
  onEdited,
  onDocumentReplaced,
  onUndo,
  onRedo,
  engine,
}: {
  documentId: string;
  mode: Mode;
  onModeChange?: (m: Mode) => void;
  apiRef?: MutableRefObject<CasualPdfApi | null>;
  onEdited?: () => void;
  onDocumentReplaced?: (bytes: Uint8Array) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  engine?: MergeEngine;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [leftPanel, setLeftPanel] = useState<LeftPanel>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [signing, setSigning] = useState(false);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [redacting, setRedacting] = useState(false);
  const [redactions, setRedactions] = useState<RedactRect[]>([]);
  // Tier-2 text editing: `editBytes` is the current document bytes the PDFium
  // edit core operates on; set when the tool activates and after each commit.
  const [textEditing, setTextEditing] = useState(false);
  const [editBytes, setEditBytes] = useState<Uint8Array | null>(null);
  // True once at least one text-edit commit has been made; triggers an
  // onDocumentReplaced call on exit so the text layer re-indexes.
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editNote, setEditNote] = useState<string | null>(null);
  const [textRunsReady, setTextRunsReady] = useState(false);
  // Refs for editBytes/editDirty so the mode→view teardown effect can read
  // current values without listing them as deps (which would re-run the effect
  // on every commit and wipe in-progress edits).
  const editBytesRef = useRef<Uint8Array | null>(null);
  const editDirtyRef = useRef(false);
  const onDocumentReplacedRef = useRef(onDocumentReplaced);
  onDocumentReplacedRef.current = onDocumentReplaced;
  // Monotonically increasing id for redaction marks — stable identity for React
  // keys and filter-by-id (avoids reference-equality issues after state updates).
  const redactIdCounter = useRef(0);
  const nextRedactId = () => { redactIdCounter.current += 1; return redactIdCounter.current; };

  // H-4: clear text-edit error/note when a new document is opened.
  useEffect(() => { setEditError(null); setEditNote(null); }, [documentId]);

  const [redactBusy, setRedactBusy] = useState(false);
  const [redactError, setRedactError] = useState<string | null>(null);
  const [confirmRedact, setConfirmRedact] = useState(false);
  const toggleLeft = (p: 'thumbs' | 'outline' | 'comments') => setLeftPanel((cur) => (cur === p ? null : p));
  const { state: docScroll } = useScroll(documentId);
  const totalPages = docScroll?.totalPages ?? 0;

  const { state: anno, provides: annoApi } = useAnnotation(documentId);
  const { provides: annoCap } = useAnnotationCapability();
  const { provides: selectionCap } = useSelectionCapability();
  const { provides: history } = useHistoryCapability();
  const { provides: exportCap } = useExportCapability();
  const { provides: renderCap } = useRenderCapability();
  const { provides: docCap } = useDocumentManagerCapability();
  const { provides: sigCap } = useSignatureCapability();
  const { rotation: viewRotation, provides: rotateApi } = useRotate(documentId);
  const { state: fs } = useFullscreen();
  // Internal clipboard for copy/paste of annotations (stores annotation objects).
  const clipboardRef = useRef<Parameters<NonNullable<typeof annoApi>['createAnnotation']>[1][]>([]);
  const activeToolId = anno?.activeToolId ?? null;
  // Presentation mode: full screen is a clean reading view — hide editing chrome.
  const presenting = fs.isFullscreen;
  const editing = mode !== 'view' && !presenting;
  // Text is selectable whenever no drawing tool is active — i.e. View mode and
  // the Select tool in Edit/Suggest (activeToolId === null) — plus while a
  // text-markup tool is active (highlight/underline/…). It's only OFF for the
  // shape/ink/text/note tools that own the drag to draw. The AnnotationLayer
  // sits on top and still captures clicks on existing annotations, so selecting
  // text (over glyphs) and selecting/moving annotations coexist.
  // SelectionLayer must be off while text-edit mode is active: the interaction
  // manager routes pointer events to SelectionLayer before they reach the
  // TextEditLayer's native button elements, causing "selecting a char" instead
  // of opening the inline editor on click.
  const textSelectable = (activeToolId === null || MARKUP_TOOLS.has(activeToolId)) && !redacting && !textEditing;

  // Selection mini-toolbar: turn the current text selection into a markup
  // annotation (one per page the selection spans), using the selection's
  // formatted rects, then clear the selection.
  const applyMarkup = (toolId: 'highlight' | 'underline' | 'strikeout') => {
    if (!annoApi || !selectionCap) return;
    const subtype = MARKUP_SUBTYPE[toolId];
    const isHighlight = toolId === 'highlight';
    const color = isHighlight ? '#f5d90a' : '#e8453c';
    for (const s of selectionCap.getFormattedSelection(documentId) ?? []) {
      annoApi.createAnnotation(s.pageIndex, {
        type: subtype,
        id: genId(),
        pageIndex: s.pageIndex,
        rect: s.rect,
        segmentRects: s.segmentRects,
        strokeColor: color,
        opacity: isHighlight ? 0.4 : 1,
      } as Parameters<NonNullable<typeof annoApi>['createAnnotation']>[1]);
    }
    selectionCap.clear(documentId);
  };
  const copySelection = () => {
    selectionCap?.copyToClipboard(documentId);
    selectionCap?.clear(documentId);
  };
  // Track whether text is selected, to show the selection mini-toolbar. Gate on
  // the *formatted* selection (rects for actually-spanned glyphs) rather than the
  // raw range — a plain click yields a collapsed range (start === end) with no
  // rects, which would otherwise float the toolbar over an empty selection (e.g.
  // right after placing a signature, when the SelectionLayer remounts).
  useEffect(() => {
    if (!selectionCap) return;
    return selectionCap.onSelectionChange(() =>
      setHasSelection((selectionCap.getFormattedSelection(documentId)?.length ?? 0) > 0),
    );
  }, [selectionCap, documentId]);
  const showSelTools = editing && activeToolId === null && hasSelection;

  // Imperative API for host menus.
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      download: () => exportCap?.download(),
      undo: () => history?.undo(),
      redo: () => history?.redo(),
      canUndo: () => history?.canUndo() ?? false,
      canRedo: () => history?.canRedo() ?? false,
      deleteSelection: () => {
        const sel = annoApi?.getSelectedAnnotations() ?? [];
        if (annoApi && sel.length) annoApi.deleteAnnotations(sel.map((a) => ({ pageIndex: a.object.pageIndex, id: a.object.id })));
      },
      setTool: (id) => annoApi?.setActiveTool(id),
      openSearch: () => setSearchOpen(true),
      getBytes: async () => {
        if (!exportCap) return null;
        const ab = await exportCap.saveAsCopy().toPromise();
        return ab ? new Uint8Array(ab) : null;
      },
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, annoApi, history, exportCap, setSearchOpen]);

  // Preload PDFium WASM as soon as the user enters Edit/Suggest mode so
  // the "Edit text" tool has no perceptible delay on first click.
  useEffect(() => {
    if (mode !== 'view') {
      import('../textedit-pdfium').then(({ preloadPdfium }) => preloadPdfium());
    }
  }, [mode]);

  // Text tools default to the placeholder contents "Insert text", and editing
  // appends to it (so a new box reads "Insert textyour words"). Clear the
  // default so text boxes/callouts start empty and the user just types.
  useEffect(() => {
    if (!annoCap) return;
    for (const id of ['freeText', 'freeTextCallout', 'textComment']) {
      try {
        annoCap.setToolDefaults(id, { contents: '' });
      } catch {
        /* tool may not be registered in this build */
      }
    }
  }, [annoCap]);

  // Insert image: pick a PNG/JPEG, read its bytes + natural aspect, then arm
  // placement (the next page click drops it as an image STAMP annotation).
  const onImageFile = async (file: File) => {
    const mimeType = file.type === 'image/png' ? 'image/png' : file.type === 'image/jpeg' ? 'image/jpeg' : null;
    if (!mimeType) return;
    const data = await file.arrayBuffer();
    let w = 1;
    let h = 1;
    try {
      const bmp = await createImageBitmap(file);
      w = bmp.width;
      h = bmp.height;
      bmp.close();
    } catch {
      /* aspect falls back to 1:1 if the bitmap can't be decoded */
    }
    annoApi?.setActiveTool(null); // select mode → the placer's pointer handler is live
    annoApi?.deselectAnnotation();
    setRedacting(false);
    setPendingImage({ data, mimeType, w, h });
  };

  // Redaction: toggle marking mode (mutually exclusive with annotation tools /
  // image placement), and apply — rasterize + flatten each marked page.
  const toggleRedact = () => {
    setRedacting((v) => {
      const next = !v;
      if (next) {
        annoApi?.setActiveTool(null);
        annoApi?.deselectAnnotation();
        setPendingImage(null);
        setRedactError(null);
        // Redaction works in the page's native orientation so captured marks and
        // the rendered bitmap share one coordinate space. Reset any view rotation.
        rotateApi?.setRotation(Rotation.Degree0);
      }
      return next;
    });
  };
  const SCALE = 2; // render scale for flattened pages (2× for crisp output)
  // Redaction = rasterize-and-flatten (the secure default; immune to the
  // de-redaction attacks that defeat surgical text removal — see the research
  // note in docs). Each marked page is rendered at 2× in its NATIVE orientation,
  // opaque black boxes are painted over the marks, and the page is rebuilt
  // PRESERVING its MediaBox/CropBox/Rotate (buildRedactedPdf). Untouched pages
  // are copied verbatim (keeping their text). The surgical wasm path is shelved
  // until it's a fail-closed interpreter (it under-redacts on XObjects/Type3).
  const applyRedactions = async () => {
    setConfirmRedact(false);
    if (!renderCap || !docCap || !exportCap || !redactions.length) return;
    setRedactBusy(true);
    setRedactError(null);
    try {
      const ab = await exportCap.saveAsCopy().toPromise();
      if (!ab) throw new Error('Could not read the document.');
      const srcBytes = new Uint8Array(ab);
      const scope = renderCap.forDocument(documentId);
      const pageIndices = [...new Set(redactions.map((r) => r.pageIndex))];
      const flattened: { pageIndex: number; png: Uint8Array }[] = [];
      for (const pi of pageIndices) {
        const blob = await scope.renderPage({ pageIndex: pi, options: { scaleFactor: SCALE, withAnnotations: true } }).toPromise();
        // A failed render must NOT be skipped — that would leave the page's
        // content un-redacted in the output. Fail the whole operation instead.
        if (!blob) throw new Error(`Couldn't render page ${pi + 1} for redaction.`);
        // The viewer renders pages in native orientation (it reads /Rotate but
        // doesn't rotate the canvas), and renderPage is native too — so the marks
        // and the bitmap share one space; paint directly. The output page keeps
        // the source /Rotate (buildRedactedPdf) so external viewers match.
        const png = await flattenPage(blob, redactions.filter((r) => r.pageIndex === pi));
        flattened.push({ pageIndex: pi, png });
      }
      const { buildRedactedPdf } = await import('../redact');
      const out = await buildRedactedPdf(srcBytes, flattened);
      if (onDocumentReplaced) {
        onDocumentReplaced(out);
      } else {
        const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
        await docCap.openDocumentBuffer({ buffer, name: 'redacted.pdf', autoActivate: true }).toPromise();
      }
      onEdited?.();
      setRedactions([]);
      setRedacting(false);
    } catch (e) {
      // Keep the marks so the user can retry, and surface the failure — never
      // silently no-op on a trust feature.
      setRedactError(e instanceof Error ? e.message : 'Redaction failed. Nothing was changed.');
    } finally {
      setRedactBusy(false);
    }
  };

  // Tier-2 text editing: activate → snapshot the current bytes for the PDFium
  // edit core to operate on; deactivate other tools. Commit → editTextRun on the
  // snapshot, reload the result, and keep the snapshot current for further edits.
  const toggleTextEdit = async () => {
    if (textEditing) {
      // Fire onDocumentReplaced only when edits were made so the host can swap
      // the src to a new Blob URL — this triggers EmbedPDF to re-index the text
      // layer (search/selection fix). In-session commits used openDocumentBuffer
      // (no remount) so the re-index is deferred to here.
      if (editDirtyRef.current && editBytesRef.current && onDocumentReplacedRef.current) {
        onDocumentReplacedRef.current(editBytesRef.current);
      }
      setTextEditing(false);
      editBytesRef.current = null; setEditBytes(null);
      editDirtyRef.current = false;
      setTextRunsReady(false);
      return;
    }
    if (!exportCap) return;
    annoApi?.setActiveTool(null);
    annoApi?.deselectAnnotation();
    setRedacting(false);
    setPendingImage(null);
    // PDFium WASM is already warmed by the useEffect that fires on mode→Edit.
    // Do NOT call preloadPdfium() here again — it would fire a second redundant import.
    const ab = await exportCap.saveAsCopy().toPromise();
    if (!ab) return;
    const bytes = new Uint8Array(ab);
    editBytesRef.current = bytes; setEditBytes(bytes);
    setTextEditing(true);
  };
  const commitTextEdit = async (pageIndex: number, objectIndex: number, objectIndices: number[], newText: string) => {
    if (!editBytesRef.current || !docCap || editBusy) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const { editTextRun } = await import('../textedit-pdfium');
      const { bytes: out, substituted } = await editTextRun(editBytesRef.current, pageIndex, objectIndex, objectIndices, newText);
      // Use openDocumentBuffer (not onDocumentReplaced) so the Viewer stays mounted
      // and the user can keep editing without re-clicking the tool. The text layer
      // re-index via onDocumentReplaced is deferred to when they exit text-edit mode.
      const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      await docCap.openDocumentBuffer({ buffer, name: 'edited.pdf', autoActivate: true }).toPromise();
      editBytesRef.current = out; setEditBytes(out); // updated bytes for the next commit
      editDirtyRef.current = true;
      // Let the user know when we silently swapped the font (subsetted or new glyphs).
      setEditNote(substituted ? 'Font changed to a standard substitute (original was embedded/subsetted).' : null);
      onEdited?.();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Edit failed — the document is unchanged.');
    } finally {
      setEditBusy(false);
    }
  };

  // Redact the current text selection: convert each selected line's rect (page
  // points) into a fractional redaction mark, then enter redact mode so the user
  // can review + Apply. Per-line `segmentRects` give tight boxes over wrapped
  // text rather than one loose bounding box.
  const redactSelection = () => {
    if (!selectionCap || !docCap) return;
    const doc = docCap.getDocument(documentId);
    const sel = selectionCap.getFormattedSelection(documentId) ?? [];
    const marks: RedactRect[] = [];
    for (const s of sel) {
      const size = doc?.pages?.[s.pageIndex]?.size;
      if (!size) continue;
      const rects = s.segmentRects?.length ? s.segmentRects : [s.rect];
      for (const r of rects) {
        marks.push({
          id: nextRedactId(),
          pageIndex: s.pageIndex,
          x: r.origin.x / size.width,
          // PDF origin is bottom-left; CSS is top-left. Flip so the mark lands
          // over the selected text in the page overlay (top-left fraction).
          y: 1 - (r.origin.y + r.size.height) / size.height,
          w: r.size.width / size.width,
          h: r.size.height / size.height,
        });
      }
    }
    selectionCap.clear(documentId);
    if (marks.length) {
      setRedactions((prev) => [...prev, ...marks]);
      setRedacting(true);
    }
  };

  // Redact every match of the current search: convert each hit's rects (page
  // points) into fractional marks, then enter redact mode for review + Apply.
  const redactSearchMatches = (
    results: { pageIndex: number; rects: { origin: { x: number; y: number }; size: { width: number; height: number } }[] }[],
  ) => {
    if (!docCap) return;
    const doc = docCap.getDocument(documentId);
    const marks: RedactRect[] = [];
    for (const res of results) {
      const size = doc?.pages?.[res.pageIndex]?.size;
      if (!size) continue;
      for (const r of res.rects) {
        marks.push({
          id: nextRedactId(),
          pageIndex: res.pageIndex,
          x: r.origin.x / size.width,
          // PDF origin is bottom-left; CSS is top-left. Flip to overlay correctly.
          y: 1 - (r.origin.y + r.size.height) / size.height,
          w: r.size.width / size.width,
          h: r.size.height / size.height,
        });
      }
    }
    if (marks.length) {
      setRedactions((prev) => [...prev, ...marks]);
      setRedacting(true);
      setSearchOpen(false);
    }
  };

  // Entering a read-only view (View mode OR full-screen presentation): drop any
  // active tool + selection so no crosshair/handles linger. This is the *gentle*
  // cleanup — it must NOT discard in-progress edits (pending image, redaction
  // marks), so a quick full-screen peek doesn't wipe your work.
  useEffect(() => {
    if (!editing) {
      annoApi?.setActiveTool(null);
      annoApi?.deselectAnnotation();
    }
  }, [editing, annoApi]);

  // Truly leaving edit (mode → View): tear down every editing surface so none
  // persists in read-only mode — pending placements, redaction marks, the
  // organize / signature modals, and any armed signature placement.
  // C-4: use refs (not state) to read editDirty/editBytes so this effect never
  // stales — adding them as deps would cause it to re-fire on every commit.
  useEffect(() => {
    if (mode === 'view') {
      // Preserve any text edits made before the mode switch.
      if (editDirtyRef.current && editBytesRef.current && onDocumentReplacedRef.current) {
        onDocumentReplacedRef.current(editBytesRef.current);
      }
      setPendingImage(null);
      setRedacting(false);
      setRedactions([]);
      setRedactError(null);
      setConfirmRedact(false);
      setOrganizing(false);
      setSigning(false);
      setTextEditing(false);
      editBytesRef.current = null; setEditBytes(null);
      editDirtyRef.current = false;
      setTextRunsReady(false);
      sigCap?.forDocument(documentId).deactivatePlacement();
    }
  }, [mode, sigCap, documentId]);

  // While redacting, keep the page in its native orientation so marks stay
  // aligned with the rendered bitmap (snap back if the view gets rotated).
  useEffect(() => {
    if (redacting && viewRotation !== Rotation.Degree0) {
      rotateApi?.setRotation(Rotation.Degree0);
    }
  }, [redacting, viewRotation, rotateApi]);

  // Escape cancels a pending image placement (and the redaction confirm).
  useEffect(() => {
    if (!pendingImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingImage(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingImage]);

  // Escape dismisses the redaction confirm dialog (unless mid-apply).
  useEffect(() => {
    if (!confirmRedact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !redactBusy) setConfirmRedact(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmRedact, redactBusy]);

  // View mode (and presentation) is read-only: lock annotations so they can't be
  // moved/resized/deleted. They stay selectable, so clicking a note still opens
  // its comment. Edit/Suggest unlock full interaction.
  useEffect(() => {
    annoApi?.setLocked({ type: mode === 'view' || presenting ? LockModeType.All : LockModeType.None });
  }, [annoApi, mode, presenting]);

  // (EmbedPDF deselects natively on empty-canvas click now that text selection
  // is View-mode-only, so no custom background handler is needed.)

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

  // Mark the document dirty (for host unsaved-changes warnings) on any
  // annotation create/update/delete.
  useEffect(() => {
    if (!annoApi || !onEdited) return;
    return annoApi.onAnnotationEvent((ev) => {
      if (ev.type === 'create' || ev.type === 'update' || ev.type === 'delete') onEdited();
    });
  }, [annoApi, onEdited]);

  // Keyboard: editing shortcuts (ignored while typing in a field).
  useEffect(() => {
    if (!editing) return;
    // Clone an annotation shifted by (dx,dy) with a fresh id, so pasted/dup'd
    // copies are visible (not stacked) and each is its own createAnnotation
    // command → individually undoable (importAnnotations folds into the prior
    // history entry, which made undo remove the original too). transformAnnotation
    // builds a type-correct patch (rect + vertices/inkList) just like nudging.
    const cloneAnnotation = (obj: Parameters<NonNullable<typeof annoCap>['transformAnnotation']>[0], dx: number, dy: number) => {
      const r = obj.rect;
      if (!r) return { ...obj, id: genId() } as typeof obj; // no geometry to offset
      const rect = { origin: { x: r.origin.x + dx, y: r.origin.y + dy }, size: r.size };
      const patch = annoCap?.transformAnnotation(obj, { type: 'move', changes: { rect } }) ?? {};
      // Spreading the discriminated union widens its `type` discriminant; the
      // merged object is the same annotation kind as obj, so assert that back.
      return { ...obj, ...patch, id: genId() } as typeof obj;
    };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      // Copy / paste selection (⌘/Ctrl+C / ⌘/Ctrl+V). Paste cascades by offset.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        const sel = annoApi?.getSelectedAnnotations() ?? [];
        if (sel.length) {
          e.preventDefault();
          // Image stamps (incl. signatures, subtype STAMP=13) carry their bitmap
          // in a separate creation ctx that a plain clone can't reproduce, so
          // copying them would paste a blank box — exclude them.
          clipboardRef.current = sel.map((a) => a.object).filter((o) => (o as { type?: number }).type !== 13);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        if (annoApi && clipboardRef.current.length) {
          e.preventDefault();
          const clones = clipboardRef.current.map((o) => cloneAnnotation(o, 16, 16));
          clones.forEach((c) => annoApi.createAnnotation(c.pageIndex, c));
          clipboardRef.current = clones; // next paste cascades from here
        }
        return;
      }
      // Select all annotations (⌘/Ctrl+A) — enables bulk move/style/delete.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        const all = annoApi?.getAnnotations() ?? [];
        if (annoApi && all.length) {
          e.preventDefault();
          annoApi.setSelection(all.map((a) => a.object.id));
        }
        return;
      }
      // Undo / redo (⌘Z / ⌘⇧Z / Ctrl+Y) are handled by the host app so it can
      // layer a version-level undo (redaction, organize, text-edit) on top of
      // the annotation-history undo. Don't intercept them here.

      // Duplicate selection (⌘/Ctrl+D) — offset copy with a fresh id.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        const sel = (annoApi?.getSelectedAnnotations() ?? []).filter((a) => (a.object as { type?: number }).type !== 13);
        if (annoApi && sel.length) {
          e.preventDefault();
          sel.forEach((a) => {
            const c = cloneAnnotation(a.object, 12, 12);
            annoApi.createAnnotation(c.pageIndex, c);
          });
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
      } else if (e.key.startsWith('Arrow')) {
        // Nudge the selection: arrows move by 1pt, Shift+arrow by 10pt.
        // transformAnnotation builds a type-correct patch (rect + vertices/ink).
        // Only annotations with a rect can be nudged (skip rect-less ones).
        const sel = (annoApi?.getSelectedAnnotations() ?? []).filter((a) => a.object.rect);
        const delta: Record<string, [number, number]> = {
          ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
        };
        const d = delta[e.key];
        if (annoApi && annoCap && sel.length && d) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const [dx, dy] = [d[0] * step, d[1] * step];
          annoApi.updateAnnotations(
            sel.map((a) => {
              const r = a.object.rect;
              const rect = { origin: { x: r.origin.x + dx, y: r.origin.y + dy }, size: r.size };
              return {
                pageIndex: a.object.pageIndex,
                id: a.object.id,
                patch: annoCap.transformAnnotation(a.object, { type: 'move', changes: { rect } }),
              };
            }),
          );
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
  }, [editing, annoApi, annoCap, history]);

  return (
    <AnnotationRendererProvider>
      {/* Registers interactive form-field renderers once (consumed by the
          AnnotationLayer's annotationRenderers). */}
      <FormRendererRegistration />
      <div className="cpdf" id={ROOT_ID} data-tool={activeToolId ?? undefined}>
        <div className="cpdf__main">
          {!presenting && <LeftRail documentId={documentId} mode={mode} leftPanel={leftPanel} onToggleLeft={toggleLeft} onOrganize={() => setOrganizing(true)} onSign={() => setSigning(true)} onInsertImage={() => imageInputRef.current?.click()} redacting={redacting} onToggleRedact={toggleRedact} textEditing={textEditing} onToggleTextEdit={toggleTextEdit} onUndo={onUndo} onRedo={onRedo} />}
          {!presenting && leftPanel === 'thumbs' && <ThumbnailSidebar documentId={documentId} onClose={() => setLeftPanel(null)} />}
          {!presenting && leftPanel === 'outline' && <OutlineSidebar documentId={documentId} onClose={() => setLeftPanel(null)} />}
          {!presenting && leftPanel === 'comments' && <CommentsSidebar documentId={documentId} onClose={() => setLeftPanel(null)} />}
          {/* Ctrl/⌘ + wheel and pinch-to-zoom over the document. */}
          <ZoomGestureWrapper documentId={documentId} className="cpdf__zoomwrap">
            <Viewport documentId={documentId} className="cpdf__viewport">
              <Scroller
                documentId={documentId}
                renderPage={({ width, height, pageIndex }) => (
                  <PagePointerProvider documentId={documentId} pageIndex={pageIndex} className="cpdf__page" style={{ width, height, position: 'relative' }}>
                    {/* EmbedPDF types RenderLayer props as HTMLAttributes (no `alt`),
                        so name the rendered page image via aria-label for WCAG image-alt. */}
                    <RenderLayer documentId={documentId} pageIndex={pageIndex} aria-label={`Page ${pageIndex + 1}`} />
                    <SearchLayer documentId={documentId} pageIndex={pageIndex} />
                    {/* Text selection is needed in View mode (read/copy) and when a
                        text-markup tool is active (highlight/underline/… select text
                        to mark up). It must be OFF for Select/shape/ink tools, or it
                        captures drags and breaks annotation move / deselect. */}
                    {textSelectable && <SelectionLayer documentId={documentId} pageIndex={pageIndex} />}
                    <AnnotationLayer
                      documentId={documentId}
                      pageIndex={pageIndex}
                      style={{ position: 'absolute', inset: 0 }}
                      annotationRenderers={formRenderers}
                      selectionMenu={({ context, menuWrapperProps }) => {
                        // Read-only sticky for viewing a comment on the page (View
                        // mode). In Edit/Suggest the editable field lives in the
                        // panel — EmbedPDF's selection-menu container can't reliably
                        // host a focusable textarea.
                        if (mode !== 'view') return null;
                        const obj = context.annotation.object;
                        if (annoApi?.findToolForAnnotation(obj)?.id !== 'textComment') return null;
                        return (
                          <div ref={menuWrapperProps.ref} style={{ ...menuWrapperProps.style, zIndex: 50 }}>
                            <StickyComment note={obj} />
                          </div>
                        );
                      }}
                    />
                    {mode !== 'view' && !pendingImage && !redacting && !textEditing && <MarqueeSelect documentId={documentId} pageIndex={pageIndex} />}
                    {editing && textEditing && editBytes && (
                      <TextEditLayer documentId={documentId} pageIndex={pageIndex} bytes={editBytes} onCommit={commitTextEdit} onReady={() => setTextRunsReady(true)} editBusy={editBusy} />
                    )}
                    {editing && pendingImage && (
                      <ImagePlacer documentId={documentId} pageIndex={pageIndex} image={pendingImage} onPlaced={() => setPendingImage(null)} />
                    )}
                    {editing && redacting && (
                      <RedactionLayer
                        pageIndex={pageIndex}
                        redactions={redactions}
                        onAdd={(r) => setRedactions((prev) => [...prev, { ...r, id: nextRedactId() }])}
                        onRemove={(mark) => setRedactions((prev) => prev.filter((r) => r.id !== mark.id))}
                      />
                    )}
                  </PagePointerProvider>
                )}
              />
            </Viewport>
          </ZoomGestureWrapper>
          {editing && <PropertiesPanel documentId={documentId} />}
        </div>
        <BottomBar documentId={documentId} searchOpen={searchOpen} onToggleSearch={() => setSearchOpen((v) => !v)} />
        {searchOpen && (
          <SearchPanel
            documentId={documentId}
            onClose={() => setSearchOpen(false)}
            canRedact={editing}
            onRedactMatches={redactSearchMatches}
          />
        )}
        {showSelTools && (
          <div className="cpdf__seltools" role="toolbar" aria-label="Selection actions" onMouseDown={(e) => e.preventDefault()}>
            <button type="button" className="cpdf-iconbtn" title="Highlight" aria-label="Highlight" onClick={() => applyMarkup('highlight')}>
              <Icon name="marker" size={18} />
            </button>
            <button type="button" className="cpdf-iconbtn" title="Underline" aria-label="Underline" onClick={() => applyMarkup('underline')}>
              <Icon name="underline" size={18} />
            </button>
            <button type="button" className="cpdf-iconbtn" title="Strikethrough" aria-label="Strikethrough" onClick={() => applyMarkup('strikeout')}>
              <Icon name="strikeout" size={18} />
            </button>
            <span className="cpdf__sep" aria-hidden="true" />
            <button type="button" className="cpdf-iconbtn" title="Copy" aria-label="Copy" onClick={copySelection}>
              <Icon name="copy" size={18} />
            </button>
            <button type="button" className="cpdf-iconbtn" title="Redact selected text" aria-label="Redact selected text" onClick={redactSelection}>
              <Icon name="redact" size={18} />
            </button>
          </div>
        )}
        {organizing && (
          <OrganizeOverlay documentId={documentId} engine={engine} totalPages={totalPages} onClose={() => setOrganizing(false)} onApplied={onEdited} onDocumentReplaced={onDocumentReplaced} />
        )}
        {signing && <SignatureModal documentId={documentId} onClose={() => setSigning(false)} />}
        <PlacementBanner documentId={documentId} />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImageFile(f);
            e.target.value = '';
          }}
        />
        {pendingImage && !presenting && (
          <div className="cpdf__placebanner" role="status">
            <Icon name="image" size={18} />
            <span>Click on a page to place the image</span>
            <button type="button" className="cpdf__btn" onClick={() => setPendingImage(null)}>
              Cancel
            </button>
          </div>
        )}
        {textEditing && !presenting && (
          <div className="cpdf__placebanner" role="status">
            <Icon name="text-tool" size={18} />
            <span>
              {editBusy
                ? 'Applying edit…'
                : editError
                  ? editError
                  : editNote
                    ? editNote
                    : textRunsReady
                      ? 'Click any text to edit — Tab to jump between runs, Esc to cancel'
                      : 'Analyzing text runs…'}
            </span>
            {(editError || editNote) && (
              <button type="button" className="cpdf__iconbtn" aria-label="Dismiss" onClick={() => { setEditError(null); setEditNote(null); }}>
                <Icon name="close" size={16} />
              </button>
            )}
            <button type="button" className="cpdf__btn" disabled={editBusy} onClick={() => toggleTextEdit()}>
              Done
            </button>
          </div>
        )}
        {redacting && !presenting && (
          <div className="cpdf__placebanner cpdf__placebanner--redact" role="status">
            <Icon name="redact" size={18} />
            <span>
              {redactError
                ? redactError
                : redactions.length
                  ? `${redactions.length} region${redactions.length === 1 ? '' : 's'} marked — drag to mark more`
                  : 'Drag on a page to mark regions to permanently remove'}
            </span>
            {redactions.length > 0 && (
              <button type="button" className="cpdf__btn" disabled={redactBusy} onClick={() => { setRedactions([]); setRedactError(null); }}>
                Clear
              </button>
            )}
            <button
              type="button"
              className="cpdf__btn cpdf__btn--danger"
              disabled={redactBusy || editBusy || !redactions.length}
              onClick={() => setConfirmRedact(true)}
            >
              {redactBusy ? 'Applying…' : 'Apply redactions'}
            </button>
          </div>
        )}
        {confirmRedact && (
          <div className="cpdf__scrim" role="presentation" onClick={() => !redactBusy && setConfirmRedact(false)}>
            <div
              className="cpdf__confirm"
              role="dialog"
              aria-modal="true"
              aria-label="Apply redactions"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="cpdf__confirm-head">
                <span className="cpdf__confirm-icon"><Icon name="redact" size={22} /></span>
                <h2 className="cpdf__confirm-title">Apply redactions?</h2>
              </div>
              <p className="cpdf__confirm-body">
                This permanently removes the content under {redactions.length} marked region
                {redactions.length === 1 ? '' : 's'} — it <strong>can't be undone</strong>. The{' '}
                {new Set(redactions.map((r) => r.pageIndex)).size} affected page
                {new Set(redactions.map((r) => r.pageIndex)).size === 1 ? '' : 's'} are rebuilt as flattened images
                (preserving their size &amp; rotation), so text on {new Set(redactions.map((r) => r.pageIndex)).size === 1 ? 'it' : 'them'} is
                no longer selectable. Untouched pages keep their text. Download the result to keep the redacted copy.
              </p>
              <div className="cpdf__confirm-acts">
                <button type="button" className="cpdf__btn" onClick={() => setConfirmRedact(false)}>
                  Cancel
                </button>
                <button type="button" className="cpdf__btn cpdf__btn--danger" onClick={applyRedactions}>
                  Redact &amp; remove
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AnnotationRendererProvider>
  );
}
