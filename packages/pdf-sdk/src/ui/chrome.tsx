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

/** Deselect when the user clicks empty space (no annotation under the pointer).
 *  EmbedPDF selects annotations on click but doesn't deselect on background click;
 *  we hit-test the click against annotation rects so move/select are unaffected.
 *  Registered for the default 'pointerMode' (Select tool), so drawing is unaffected. */
function DeselectGuard({ documentId, pageIndex }: { documentId: string; pageIndex: number }) {
  const { provides: cap } = useAnnotationCapability();
  const { register } = usePointerHandlers({ modeId: 'pointerMode', pageIndex, documentId });
  useEffect(() => {
    return register({
      onPointerDown: (pos) => {
        const scope = cap?.forDocument(documentId);
        if (!scope) return;
        const here = scope.getAnnotations().filter((a) => a.object.pageIndex === pageIndex);
        const hit = here.some((a) => {
          const r = a.object.rect;
          return (
            !!r &&
            pos.x >= r.origin.x &&
            pos.x <= r.origin.x + r.size.width &&
            pos.y >= r.origin.y &&
            pos.y <= r.origin.y + r.size.height
          );
        });
        if (!hit) scope.deselectAnnotation();
      },
    });
  }, [register, cap, documentId, pageIndex]);
  return null;
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
 *  the committed + in-progress marks as red boxes. Applying the marks rasterizes
 *  + flattens the page (see redact.ts). */
function RedactionLayer({
  pageIndex,
  redactions,
  onAdd,
}: {
  pageIndex: number;
  redactions: RedactRect[];
  onAdd: (r: RedactRect) => void;
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
      {mine.map((r, i) => (
        <div key={i} className="cpdf__redactrect" style={pctStyle(r)} />
      ))}
      {draft && <div className="cpdf__redactrect cpdf__redactrect--draft" style={pctStyle(draft)} />}
    </div>
  );
}

/** Render a page Blob to a canvas, paint opaque black over the fractional
 *  redaction rects, and return PNG bytes — the flattened, redacted page image. */
async function flattenPage(blob: Blob, rects: RedactRect[]): Promise<Uint8Array> {
  const img = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  img.close();
  ctx.fillStyle = '#000';
  for (const r of rects) {
    ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
  }
  const out: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  return new Uint8Array(await out.arrayBuffer());
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
}) {
  const { state: anno, provides: annoApi } = useAnnotation(documentId);
  const { provides: history } = useHistoryCapability();
  const activeToolId = anno?.activeToolId ?? null;
  const editing = mode !== 'view';

  return (
    <div className="cpdf__rail" role="toolbar" aria-orientation="vertical" aria-label="Tools">
      <RailBtn icon="thumbnails" label="Pages" title="Page thumbnails" active={leftPanel === 'thumbs'} onClick={() => onToggleLeft('thumbs')} />
      <RailBtn icon="outline" label="Outline" title="Document outline" active={leftPanel === 'outline'} onClick={() => onToggleLeft('outline')} />
      <RailBtn icon="comments" label="Comments" title="Comments & annotations" active={leftPanel === 'comments'} onClick={() => onToggleLeft('comments')} />
      {editing && (
        <>
          <span className="cpdf__rail-sep" aria-hidden="true" />
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
}: {
  documentId: string;
  engine: MergeEngine;
  totalPages: number;
  onClose: () => void;
}) {
  const { provides: docCap } = useDocumentManagerCapability();
  const [order, setOrder] = useState<number[]>(() => Array.from({ length: totalPages }, (_, i) => i));
  const [busy, setBusy] = useState(false);
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
    try {
      const file = await engine.mergePages([{ docId: documentId, pageIndices: order }]).toPromise();
      await docCap.openDocumentBuffer({ buffer: file.content, name: 'organized.pdf', autoActivate: true }).toPromise();
      onClose();
    } catch {
      setBusy(false);
    }
  };
  return (
    <div className="cpdf__organize" role="dialog" aria-modal="true" aria-label="Organize pages">
      <div className="cpdf__organize-bar">
        <span className="cpdf__organize-title">Organize pages</span>
        <span className="cpdf__organize-hint">{order.length} page{order.length === 1 ? '' : 's'}</span>
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
  const result = tab === 'draw' ? draw : typed;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
  engine,
}: {
  documentId: string;
  mode: Mode;
  onModeChange?: (m: Mode) => void;
  apiRef?: MutableRefObject<CasualPdfApi | null>;
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
  const [redactBusy, setRedactBusy] = useState(false);
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
  const textSelectable = (activeToolId === null || MARKUP_TOOLS.has(activeToolId)) && !redacting;

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
      deleteSelection: () => {
        const sel = annoApi?.getSelectedAnnotations() ?? [];
        if (annoApi && sel.length) annoApi.deleteAnnotations(sel.map((a) => ({ pageIndex: a.object.pageIndex, id: a.object.id })));
      },
      setTool: (id) => annoApi?.setActiveTool(id),
      getBytes: async () => {
        if (!exportCap) return null;
        const ab = await exportCap.saveAsCopy().toPromise();
        return ab ? new Uint8Array(ab) : null;
      },
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, annoApi, history, exportCap]);

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
      }
      return next;
    });
  };
  const applyRedactions = async () => {
    if (!renderCap || !docCap || !exportCap || !redactions.length) return;
    setRedactBusy(true);
    try {
      const ab = await exportCap.saveAsCopy().toPromise();
      if (!ab) throw new Error('no document bytes');
      const srcBytes = new Uint8Array(ab);
      const scope = renderCap.forDocument(documentId);
      const pageIndices = [...new Set(redactions.map((r) => r.pageIndex))];
      const flattened: { pageIndex: number; png: Uint8Array }[] = [];
      for (const pi of pageIndices) {
        // Render at 2× with annotations baked so flattened pages keep markups.
        const blob = await scope.renderPage({ pageIndex: pi, options: { scaleFactor: 2, withAnnotations: true } }).toPromise();
        if (!blob) continue;
        const png = await flattenPage(blob, redactions.filter((r) => r.pageIndex === pi));
        flattened.push({ pageIndex: pi, png });
      }
      // Lazy-load the pdf-lib assembly (~90 KB gz) only when applying.
      const { buildRedactedPdf } = await import('../redact');
      const out = await buildRedactedPdf(srcBytes, flattened);
      const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      await docCap.openDocumentBuffer({ buffer, name: 'redacted.pdf', autoActivate: true }).toPromise();
      setRedactions([]);
      setRedacting(false);
    } catch {
      // Keep the marks so the user can retry.
    } finally {
      setRedactBusy(false);
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
          pageIndex: s.pageIndex,
          x: r.origin.x / size.width,
          y: r.origin.y / size.height,
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
          pageIndex: res.pageIndex,
          x: r.origin.x / size.width,
          y: r.origin.y / size.height,
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

  // Leaving the editing state (View mode or full-screen presentation) is
  // read-only: drop any active tool (so no crosshair cursor lingers) and clear
  // the selection for a clean read view.
  useEffect(() => {
    if (!editing) {
      annoApi?.setActiveTool(null);
      annoApi?.deselectAnnotation();
      setPendingImage(null);
      setRedacting(false);
      setRedactions([]);
    }
  }, [editing, annoApi]);

  // Escape cancels a pending image placement.
  useEffect(() => {
    if (!pendingImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingImage(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingImage]);

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
          clipboardRef.current = sel.map((a) => a.object);
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
      // Undo / redo (⌘/Ctrl+Z, ⇧ for redo; Ctrl+Y also redoes).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) history?.redo();
        else history?.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        history?.redo();
        return;
      }
      // Duplicate selection (⌘/Ctrl+D) — offset copy with a fresh id.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        const sel = annoApi?.getSelectedAnnotations() ?? [];
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
          {!presenting && <LeftRail documentId={documentId} mode={mode} leftPanel={leftPanel} onToggleLeft={toggleLeft} onOrganize={() => setOrganizing(true)} onSign={() => setSigning(true)} onInsertImage={() => imageInputRef.current?.click()} redacting={redacting} onToggleRedact={toggleRedact} />}
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
                    {mode !== 'view' && !pendingImage && !redacting && <DeselectGuard documentId={documentId} pageIndex={pageIndex} />}
                    {editing && pendingImage && (
                      <ImagePlacer documentId={documentId} pageIndex={pageIndex} image={pendingImage} onPlaced={() => setPendingImage(null)} />
                    )}
                    {editing && redacting && (
                      <RedactionLayer
                        pageIndex={pageIndex}
                        redactions={redactions}
                        onAdd={(r) => setRedactions((prev) => [...prev, r])}
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
          <OrganizeOverlay documentId={documentId} engine={engine} totalPages={totalPages} onClose={() => setOrganizing(false)} />
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
        {pendingImage && (
          <div className="cpdf__placebanner" role="status">
            <Icon name="image" size={18} />
            <span>Click on a page to place the image</span>
            <button type="button" className="cpdf__btn" onClick={() => setPendingImage(null)}>
              Cancel
            </button>
          </div>
        )}
        {redacting && (
          <div className="cpdf__placebanner cpdf__placebanner--redact" role="status">
            <Icon name="redact" size={18} />
            <span>
              {redactions.length
                ? `${redactions.length} region${redactions.length === 1 ? '' : 's'} marked — drag to mark more`
                : 'Drag on a page to mark regions to permanently remove'}
            </span>
            {redactions.length > 0 && (
              <button type="button" className="cpdf__btn" disabled={redactBusy} onClick={() => setRedactions([])}>
                Clear
              </button>
            )}
            <button
              type="button"
              className="cpdf__btn cpdf__btn--danger"
              disabled={redactBusy || !redactions.length}
              onClick={applyRedactions}
            >
              {redactBusy ? 'Applying…' : 'Apply redactions'}
            </button>
          </div>
        )}
      </div>
    </AnnotationRendererProvider>
  );
}
