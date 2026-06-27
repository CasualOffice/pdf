import { useMemo } from 'react';
import { createPluginRegistration } from '@embedpdf/core';
import { EmbedPDF } from '@embedpdf/core/react';
import { usePdfiumEngine } from '@embedpdf/engines/react';
import { Viewport, ViewportPluginPackage } from '@embedpdf/plugin-viewport/react';
import { Scroller, ScrollPluginPackage } from '@embedpdf/plugin-scroll/react';
import {
  DocumentContent,
  DocumentManagerPluginPackage,
} from '@embedpdf/plugin-document-manager/react';
import { RenderLayer, RenderPluginPackage } from '@embedpdf/plugin-render/react';
import type { CasualPdfProps } from './modes';

/**
 * The single embeddable surface for all of Casual PDF. The same component backs
 * the web app, the desktop shell, and third-party embeds; `mode` and `collab`
 * are runtime flags on this one core (docs/ARCHITECTURE.md §2b).
 *
 * Phase 0 wires the PDFium-WASM viewer (render / virtualized scroll / zoom).
 * The annotation overlay, suggest-mode review, and collab binding layer onto
 * this in Phases 2–3 via the model + collab modules.
 */
export function CasualPdf({ src, mode = 'view', className, style }: CasualPdfProps) {
  const { engine, isLoading } = usePdfiumEngine();

  const plugins = useMemo(
    () => [
      createPluginRegistration(DocumentManagerPluginPackage, {
        initialDocuments: [{ url: src }],
      }),
      createPluginRegistration(ViewportPluginPackage),
      createPluginRegistration(ScrollPluginPackage),
      createPluginRegistration(RenderPluginPackage),
    ],
    [src],
  );

  if (isLoading || !engine) {
    return (
      <div className={className} style={style} data-casual-pdf-mode={mode}>
        Loading PDF engine…
      </div>
    );
  }

  return (
    <div className={className} style={style} data-casual-pdf-mode={mode}>
      <EmbedPDF engine={engine} plugins={plugins}>
        {({ activeDocumentId }) =>
          activeDocumentId ? (
            <DocumentContent documentId={activeDocumentId}>
              {({ isLoaded }) =>
                isLoaded ? (
                  <Viewport documentId={activeDocumentId}>
                    <Scroller
                      documentId={activeDocumentId}
                      renderPage={({ width, height, pageIndex }) => (
                        <div style={{ width, height }}>
                          <RenderLayer documentId={activeDocumentId} pageIndex={pageIndex} />
                        </div>
                      )}
                    />
                  </Viewport>
                ) : null
              }
            </DocumentContent>
          ) : null
        }
      </EmbedPDF>
    </div>
  );
}
