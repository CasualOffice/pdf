// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Redaction assembly (rasterize + flatten). True byte-level redaction by
 * construction: a redacted page is rebuilt from a rendered image with opaque
 * black boxes already painted over the regions, so the underlying text / images
 * are simply not present in the output bytes — there is nothing to extract.
 *
 * This is the *secure* method (research-backed): rasterized pages are immune to
 * the de-redaction attacks — preserved glyph-advance widths, sub-pixel neighbour
 * shifts, obscured/overlapping objects — that defeat surgical text removal.
 *
 * Trade-off: a redacted page loses selectable / searchable text (it becomes an
 * image). Pages with no redactions are copied verbatim from the source, so they
 * keep their text.
 *
 * CRITICAL — geometry fidelity: the rebuilt page MUST inherit the source page's
 * MediaBox (including a non-zero origin), CropBox, and `/Rotate`. Synthesizing a
 * page from the rendered image's pixel dimensions (origin 0,0, no rotation)
 * silently rotates/repositions/resizes pages that aren't a plain unrotated
 * Letter — the root cause of the "horizontal became vertical / bled content
 * snapped inside" bug. We render in the page's NATIVE orientation, so the image
 * maps 1:1 onto the unrotated MediaBox and `/Rotate` handles display.
 *
 * @gate UX-S5 — text extracted from a redacted region must be empty.
 */
import { PDFDocument, degrees } from 'pdf-lib';

/** A page rebuilt from a flattened, black-boxed raster image (native orientation). */
export interface FlattenedPage {
  pageIndex: number;
  /** PNG bytes of the page rendered (native orientation) with black boxes painted. */
  png: Uint8Array;
}

/**
 * Build the redacted PDF: redacted pages are replaced by their flattened image
 * (inheriting the source page's MediaBox/CropBox/Rotate); every other page is
 * copied unchanged from `srcBytes`. Page order is preserved.
 */
export async function buildRedactedPdf(srcBytes: Uint8Array, flattened: FlattenedPage[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(srcBytes);
  const out = await PDFDocument.create();
  const byIndex = new Map(flattened.map((f) => [f.pageIndex, f]));
  const total = src.getPageCount();

  for (let i = 0; i < total; i++) {
    const f = byIndex.get(i);
    if (!f) {
      // Untouched page: copy verbatim so its text/vectors/geometry survive.
      const [copied] = await out.copyPages(src, [i]);
      out.addPage(copied);
      continue;
    }
    // Flattened page: replicate the source geometry exactly, then fill the
    // MediaBox with the rendered image (rendered native, so no rotation skew).
    const srcPage = src.getPage(i);
    const mb = srcPage.getMediaBox(); // origin-aware {x, y, width, height}
    const cb = srcPage.getCropBox(); // defaults to MediaBox when absent
    const rotation = srcPage.getRotation().angle; // multiple of 90

    const page = out.addPage([mb.width, mb.height]);
    page.setMediaBox(mb.x, mb.y, mb.width, mb.height);
    page.setCropBox(cb.x, cb.y, cb.width, cb.height);
    if (rotation) page.setRotation(degrees(rotation));

    const img = await out.embedPng(f.png);
    page.drawImage(img, { x: mb.x, y: mb.y, width: mb.width, height: mb.height });
  }
  return out.save();
}
