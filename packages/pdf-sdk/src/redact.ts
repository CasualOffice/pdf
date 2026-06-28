// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Redaction assembly (rasterize + flatten). True byte-level redaction by
 * construction: a redacted page is rebuilt from a rendered image with opaque
 * black boxes already painted over the regions, so the underlying text / images
 * are simply not present in the output bytes — there is nothing to extract.
 *
 * We use this approach (rather than PDFium object removal) because object-level
 * editing — `FPDFPage_RemoveObject` — segfaults on the available PDFium builds,
 * both native and the EmbedPDF WASM engine (the latter is why an earlier
 * plugin-based attempt failed). Rendering, by contrast, is rock-solid.
 *
 * Trade-off: a redacted page loses selectable / searchable text (it becomes an
 * image). Pages with no redactions are copied verbatim from the source, so they
 * keep their text. This is the safe default for a trust feature — a redacted
 * region can never leak because the content is gone, not merely covered.
 *
 * @gate UX-S5 — text extracted from a redacted region must be empty.
 */
import { PDFDocument } from 'pdf-lib';

/** A page rebuilt from a flattened, black-boxed raster image. */
export interface FlattenedPage {
  pageIndex: number;
  /** PNG bytes of the rendered page with black boxes already painted. */
  png: Uint8Array;
}

/**
 * Build the redacted PDF: redacted pages are replaced by their flattened image;
 * every other page is copied unchanged from `srcBytes` (keeping its real text).
 * Page order and sizes are preserved.
 */
export async function buildRedactedPdf(srcBytes: Uint8Array, flattened: FlattenedPage[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(srcBytes);
  const out = await PDFDocument.create();
  const byIndex = new Map(flattened.map((f) => [f.pageIndex, f.png]));
  const total = src.getPageCount();

  for (let i = 0; i < total; i++) {
    const png = byIndex.get(i);
    if (png) {
      // Flatten: a fresh page of the same size, filled by the black-boxed image.
      const { width, height } = src.getPage(i).getSize();
      const page = out.addPage([width, height]);
      const img = await out.embedPng(png);
      page.drawImage(img, { x: 0, y: 0, width, height });
    } else {
      // Untouched page: copy verbatim so its text/vectors are preserved.
      const [copied] = await out.copyPages(src, [i]);
      out.addPage(copied);
    }
  }
  return out.save();
}
