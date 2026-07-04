// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';

// ── Visual-order geometry patch ──────────────────────────────────────────────
// PDFium enumerates text chars in content-stream order, which frequently
// doesn't match visual reading order (multi-column layouts, headers/footers
// rendered after body, bottom-up content streams from some PDF generators).
// The EmbedPDF selection plugin uses char indices as selection boundaries, so
// if the visual "top" of a page has a high PDFium char index and the "bottom"
// has a low one, drag selection spans everything in between.
//
// Fix: wrap getPageGeometry to sort runs top→bottom / left→right and remap
// charStart values to be sequential in that visual order.  Wrap getTextSlices
// to translate visual-order charIndex/charCount back to PDFium-native indices
// so clipboard text extraction still works correctly.

type Run = {
  rect: { x: number; y: number; width: number; height: number };
  charStart: number;
  glyphs: unknown[];
  [k: string]: unknown;
};
type RemappedRun = Run & { _origCharStart: number };
type PageGeo = { runs: RemappedRun[]; [k: string]: unknown };

function sortAndRemapGeo(geo: { runs: Run[]; [k: string]: unknown }): PageGeo {
  // Group runs into visual lines using a 5-pt floor bucket, then sort lines
  // top→bottom and runs within each line left→right.
  const SNAP = 5;
  const sorted = [...geo.runs].sort((a, b) => {
    const aY = Math.floor(a.rect.y / SNAP) * SNAP;
    const bY = Math.floor(b.rect.y / SNAP) * SNAP;
    return aY !== bY ? aY - bY : a.rect.x - b.rect.x;
  });
  let next = 0;
  const runs: RemappedRun[] = sorted.map(r => {
    const mapped = { ...r, charStart: next, _origCharStart: r.charStart };
    next += r.glyphs.length;
    return mapped;
  });
  return { ...geo, runs };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeVisualOrderEngine(engine: any): any {
  // Per-document, per-page cache of remapped geometry.
  const geoCache = new Map<string, Map<number, PageGeo>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = Object.create(engine) as any;

  wrapped.getPageGeometry = (doc: { id: string }, page: { index: number }) => {
    const task = engine.getPageGeometry(doc, page);
    const origWait = task.wait.bind(task);
    task.wait = (onOk: (g: PageGeo) => void, onErr: (e: unknown) => void) => {
      origWait((geo: { runs: Run[]; [k: string]: unknown }) => {
        const remapped = sortAndRemapGeo(geo);
        let docMap = geoCache.get(doc.id);
        if (!docMap) {
          // Bound the cache — each openDocumentBuffer/reload (text-edit commit,
          // redaction, organize) mints a fresh doc.id, so without eviction this
          // Map grows for the whole session. Drop the oldest documents' geometry
          // (never the one being cached now) when a new document appears.
          const MAX_DOCS = 4;
          while (geoCache.size >= MAX_DOCS) {
            const oldest = geoCache.keys().next().value;
            if (oldest === undefined || oldest === doc.id) break;
            geoCache.delete(oldest);
          }
          docMap = new Map();
          geoCache.set(doc.id, docMap);
        }
        docMap.set(page.index, remapped);
        onOk(remapped);
      }, onErr);
    };
    task.toPromise = () => new Promise((res, rej) => task.wait(res, rej));
    return task;
  };

  wrapped.getTextSlices = (
    doc: { id: string },
    slices: { pageIndex: number; charIndex: number; charCount: number }[],
  ) => {
    if (slices.length === 0) return engine.getTextSlices(doc, slices);

    const docMap = geoCache.get(doc.id);

    // For each original slice, expand to the PDFium-native slices it maps to.
    // Each group keeps visual order (sorted by visualStart) so concatenation
    // produces reading-order text.
    const groups: {
      slice: { pageIndex: number; charIndex: number; charCount: number };
      visualStart: number;
    }[][] = slices.map(() => []);

    for (let i = 0; i < slices.length; i++) {
      const s = slices[i];
      const geo = docMap?.get(s.pageIndex);
      if (!geo) {
        groups[i].push({ slice: s, visualStart: s.charIndex });
        continue;
      }
      const vFrom = s.charIndex;
      const vTo   = s.charIndex + s.charCount - 1;
      for (const run of geo.runs) {
        const rEnd = run.charStart + run.glyphs.length - 1;
        if (rEnd < vFrom || run.charStart > vTo) continue;
        const ovFrom = Math.max(vFrom, run.charStart);
        const ovTo   = Math.min(vTo, rEnd);
        const off    = ovFrom - run.charStart;
        groups[i].push({
          slice: {
            pageIndex: s.pageIndex,
            charIndex: run._origCharStart + off,
            charCount: ovTo - ovFrom + 1,
          },
          visualStart: ovFrom,
        });
      }
      groups[i].sort((a, b) => a.visualStart - b.visualStart);
    }

    const flat = groups.flat().map(e => e.slice);
    const origTask = engine.getTextSlices(doc, flat);
    return {
      wait(onOk: (texts: string[]) => void, onErr: (e: unknown) => void) {
        origTask.wait((texts: string[]) => {
          let j = 0;
          const result = groups.map(g => g.map(() => texts[j++] ?? '').join(''));
          onOk(result);
        }, onErr);
      },
      abort(r?: unknown) { return origTask.abort?.(r); },
      toPromise(): Promise<string[]> {
        return new Promise((res, rej) => this.wait(res, rej));
      },
    };
  };

  return wrapped;
}
import { createPluginRegistration } from '@embedpdf/core';
import { EmbedPDF } from '@embedpdf/core/react';
import { usePdfiumEngine } from '@embedpdf/engines/react';
import { ViewportPluginPackage } from '@embedpdf/plugin-viewport/react';
import { ScrollPluginPackage } from '@embedpdf/plugin-scroll/react';
import { DocumentManagerPluginPackage, DocumentContent } from '@embedpdf/plugin-document-manager/react';
import { RenderPluginPackage } from '@embedpdf/plugin-render/react';
import { InteractionManagerPluginPackage } from '@embedpdf/plugin-interaction-manager/react';
import { ZoomPluginPackage } from '@embedpdf/plugin-zoom/react';
import { RotatePluginPackage } from '@embedpdf/plugin-rotate/react';
import { SpreadPluginPackage } from '@embedpdf/plugin-spread/react';
import { FullscreenPluginPackage } from '@embedpdf/plugin-fullscreen/react';
import { PanPluginPackage } from '@embedpdf/plugin-pan/react';
import { SearchPluginPackage } from '@embedpdf/plugin-search/react';
import { SelectionPluginPackage } from '@embedpdf/plugin-selection/react';
import { ThumbnailPluginPackage } from '@embedpdf/plugin-thumbnail/react';
import { BookmarkPluginPackage } from '@embedpdf/plugin-bookmark/react';
import { AnnotationPluginPackage } from '@embedpdf/plugin-annotation/react';
import { FormPluginPackage } from '@embedpdf/plugin-form/react';
import { SignaturePluginPackage, SignatureMode } from '@embedpdf/plugin-signature/react';
import { HistoryPluginPackage } from '@embedpdf/plugin-history/react';
import { ExportPluginPackage } from '@embedpdf/plugin-export/react';
import { TilingPluginPackage } from '@embedpdf/plugin-tiling/react';
import { Viewer } from './ui/chrome';
import { Icon } from './ui/icons';
import './ui/viewer.css';
import type { CasualPdfProps } from './modes';

/**
 * The single embeddable surface for all of Casual PDF. The same component backs
 * the web app, the desktop shell, and third-party embeds; `mode` and `collab`
 * are runtime flags on this one core (docs/ARCHITECTURE.md §2b).
 *
 * Phase 1 layers the production viewer onto the PDFium-WASM engine: virtualized
 * scroll + tiling, zoom / fit modes, rotate, page nav, two-page spread, text
 * search + selection, thumbnails, pan, and fullscreen — all via EmbedPDF
 * plugins, driven by the floating toolbar in ./ui/chrome. The annotation
 * overlay, suggest-mode review, and collab binding layer on in Phases 2–3.
 */
export function CasualPdf({ src, mode = 'view', onModeChange, apiRef, onEdited, onDocumentReplaced, onUndo, onRedo, className, style }: CasualPdfProps) {
  const { engine, isLoading, error } = usePdfiumEngine();

  // Wrap the engine so geometry runs are sorted in visual reading order.
  // This fixes drag-selection on PDFs whose content stream order ≠ visual order.
  const patchedEngine = useMemo(
    () => (engine ? makeVisualOrderEngine(engine) : null),
    [engine],
  );

  const plugins = useMemo(
    () => [
      createPluginRegistration(DocumentManagerPluginPackage, {
        initialDocuments: [{ url: src }],
      }),
      createPluginRegistration(ViewportPluginPackage),
      createPluginRegistration(ScrollPluginPackage),
      createPluginRegistration(RenderPluginPackage),
      createPluginRegistration(TilingPluginPackage),
      createPluginRegistration(InteractionManagerPluginPackage),
      createPluginRegistration(ZoomPluginPackage),
      createPluginRegistration(RotatePluginPackage),
      createPluginRegistration(SpreadPluginPackage),
      createPluginRegistration(FullscreenPluginPackage),
      createPluginRegistration(PanPluginPackage),
      createPluginRegistration(SearchPluginPackage),
      createPluginRegistration(SelectionPluginPackage),
      // width drives the virtualized row geometry; keep it in sync with the CSS
      // so thumbnails keep page aspect (not square) and rows don't overlap.
      createPluginRegistration(ThumbnailPluginPackage, { width: 132, gap: 6, labelHeight: 18, imagePadding: 3, paddingY: 4 }),
      createPluginRegistration(BookmarkPluginPackage),
      createPluginRegistration(HistoryPluginPackage),
      createPluginRegistration(AnnotationPluginPackage),
      createPluginRegistration(FormPluginPackage),
      // E-signature: draw/type a signature, then place it as a stamp/ink
      // annotation (the plugin registers signatureStamp/signatureInk tools into
      // the annotation plugin, so placements render via the AnnotationLayer).
      createPluginRegistration(SignaturePluginPackage, { mode: SignatureMode.SignatureOnly }),
      createPluginRegistration(ExportPluginPackage),
    ],
    [src],
  );

  if (error) {
    return (
      <div className={className} style={style} data-casual-pdf-mode={mode}>
        <div className="cpdf__status" role="alert">
          <span className="cpdf__status-icon cpdf__status-icon--error">
            <Icon name="warning" size={40} />
          </span>
          <span className="cpdf__status-title">Couldn’t load the PDF engine</span>
          <span className="cpdf__status-sub">Check your connection and reload the page.</span>
        </div>
      </div>
    );
  }

  if (isLoading || !engine || !patchedEngine) {
    return (
      <div className={className} style={style} data-casual-pdf-mode={mode}>
        <div className="cpdf__status">
          <span className="cpdf__spinner" aria-hidden="true" />
          <span className="cpdf__status-title">Loading PDF engine…</span>
        </div>
      </div>
    );
  }

  return (
    <div className={className} style={style} data-casual-pdf-mode={mode}>
      <EmbedPDF engine={patchedEngine} plugins={plugins}>
        {({ activeDocumentId }) =>
          activeDocumentId ? (
            <DocumentContent documentId={activeDocumentId}>
              {({ isLoaded, isError }) =>
                isError ? (
                  <div className="cpdf__status" role="alert">
                    <span className="cpdf__status-icon cpdf__status-icon--error">
                      <Icon name="warning" size={40} />
                    </span>
                    <span className="cpdf__status-title">Couldn’t open this PDF</span>
                    <span className="cpdf__status-sub">It may be corrupt, password-protected, or not a PDF.</span>
                  </div>
                ) : isLoaded ? (
                  <Viewer documentId={activeDocumentId} mode={mode} onModeChange={onModeChange} apiRef={apiRef} onEdited={onEdited} onDocumentReplaced={onDocumentReplaced} onUndo={onUndo} onRedo={onRedo} engine={patchedEngine} />
                ) : (
                  <div className="cpdf__status">
                    <span className="cpdf__spinner" aria-hidden="true" />
                    <span className="cpdf__status-title">Loading document…</span>
                  </div>
                )
              }
            </DocumentContent>
          ) : (
            <div className="cpdf__status">No document</div>
          )
        }
      </EmbedPDF>
    </div>
  );
}
