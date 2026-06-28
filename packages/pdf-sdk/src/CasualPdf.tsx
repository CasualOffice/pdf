// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
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
export function CasualPdf({ src, mode = 'view', onModeChange, apiRef, className, style }: CasualPdfProps) {
  const { engine, isLoading, error } = usePdfiumEngine();

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
      createPluginRegistration(ThumbnailPluginPackage, { width: 180, gap: 16, labelHeight: 24, imagePadding: 6, paddingY: 8 }),
      createPluginRegistration(BookmarkPluginPackage),
      createPluginRegistration(HistoryPluginPackage),
      createPluginRegistration(AnnotationPluginPackage),
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

  if (isLoading || !engine) {
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
      <EmbedPDF engine={engine} plugins={plugins}>
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
                  <Viewer documentId={activeDocumentId} mode={mode} onModeChange={onModeChange} apiRef={apiRef} />
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
