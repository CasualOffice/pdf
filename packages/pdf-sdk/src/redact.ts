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
import { visualPlacer } from './page-furniture.ts';

/** A redaction mark in fractional top-left page coordinates (as the viewer stores them). */
export interface CoverMark {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Region-only redaction ("Keep text" mode, user decision 2026-07-06): draw an
 * OPAQUE black box over each marked region and leave the rest of the page's
 * content stream intact, so the page's other text stays selectable/editable.
 *
 * TRADE-OFF — this is a VISUAL cover, NOT secure removal: the text under a box
 * remains in the file bytes and could be extracted. It is deliberately weaker
 * than the flatten path (UX-S5); the UI must disclose this and offer the secure
 * flatten (`buildRedactedPdf`) for true removal. Boxes are placed in displayed
 * ("visual") space honoring `/Rotate` + MediaBox origin (reuses `visualPlacer`);
 * the mapped rectangle is axis-aligned for all quarter rotations, so we take the
 * page-space bounding box of the four mapped corners — no rectangle rotation.
 */
export async function buildCoveredPdf(srcBytes: Uint8Array, marks: CoverMark[]): Promise<Uint8Array> {
  const { rgb } = await import('pdf-lib');
  const doc = await PDFDocument.load(srcBytes);
  const pages = doc.getPages();
  for (const m of marks) {
    const page = pages[m.pageIndex];
    if (!page) continue;
    const { vw, vh, toPage } = visualPlacer(page);
    // Fractional top-left {x,y,w,h} → visual-space corners (v is up from the
    // visual bottom, so the top edge is at (1 - y) and the bottom at (1 - y - h)).
    const u0 = m.x * vw;
    const u1 = (m.x + m.w) * vw;
    const vBot = (1 - m.y - m.h) * vh;
    const vTop = (1 - m.y) * vh;
    const corners = [toPage(u0, vBot), toPage(u1, vBot), toPage(u0, vTop), toPage(u1, vTop)];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    page.drawRectangle({
      x: minX,
      y: minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY,
      color: rgb(0, 0, 0),
      opacity: 1,
    });
  }
  return doc.save();
}

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
