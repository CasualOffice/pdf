// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 5 — Page furniture: watermark, header/footer, and Bates numbering,
 * implemented via pdf-lib (already in the write-side stack). Each function
 * receives the current document bytes and options and returns new bytes.
 *
 * NOTE: pdf-lib's save() performs a FULL rewrite, not an incremental/append-only
 * update. Existing page content and annotations are preserved, but any
 * pre-existing cryptographic signature is INVALIDATED (its /ByteRange no longer
 * matches the rewritten file). Apply page furniture before signing, not after.
 * (Same caveat applies to redact.ts and merge.ts, which also rewrite via pdf-lib.)
 *
 * pdf-lib is lazy-imported so the ~430 KB chunk only loads when this module is
 * first used (same pattern as redact.ts and sign.ts).
 */

/** Resolve a header/footer template string. Supports: {page} {pages} {date}. */
function resolveTemplate(tpl: string, pageNum: number, totalPages: number): string {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return tpl
    .replace(/\{page\}/gi, String(pageNum))
    .replace(/\{pages\}/gi, String(totalPages))
    .replace(/\{date\}/gi, date);
}

export interface WatermarkOptions {
  text: string;
  /** 0–1, default 0.3 */
  opacity?: number;
  /** degrees, default 45 */
  rotation?: number;
  /** Font size in pt, default 60 */
  fontSize?: number;
  /** Hex color, default '#808080' */
  color?: string;
  /** 1-based page indices to stamp; omit for all pages */
  pages?: number[];
}

export interface HeaderFooterOptions {
  header?: { left?: string; center?: string; right?: string };
  footer?: { left?: string; center?: string; right?: string };
  /** Font size in pt, default 10 */
  fontSize?: number;
  /** Distance from page edge in pt, default 36 (0.5") */
  margin?: number;
  /** Skip the first page (e.g. cover page), default false */
  skipFirstPage?: boolean;
}

export interface BatesOptions {
  /** Text prefix before the number, e.g. "CASE-" */
  prefix?: string;
  /** Starting number, 1-based, default 1 */
  startNumber?: number;
  /** Zero-pad width, default 6 */
  digits?: number;
  /** Page corner, default 'bottom-right' */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Font size in pt, default 10 */
  fontSize?: number;
  /** Distance from page edge in pt, default 36 */
  margin?: number;
  /** 1-based page indices to stamp; omit for all pages */
  pages?: number[];
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  // Tolerate malformed input: strip non-hex chars, expand 3-digit shorthand
  // (#abc → #aabbcc), pad short values, and treat unparseable channels as 0 —
  // never emit NaN (which would silently corrupt the pdf-lib rgb() call).
  let h = hex.replace(/[^0-9a-fA-F]/g, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length < 6) h = h.padEnd(6, '0');
  const channel = (a: number, b: number) => {
    const v = parseInt(h.slice(a, b), 16);
    return Number.isNaN(v) ? 0 : v / 255;
  };
  return { r: channel(0, 2), g: channel(2, 4), b: channel(4, 6) };
}

// pdf-lib's Page type isn't imported (lazy module); use a minimal structural type.
interface PdfLibPage {
  getMediaBox(): { x: number; y: number; width: number; height: number };
  getRotation(): { angle: number };
}

/**
 * Rotation-aware placement. Furniture is authored in "visual" space — the page
 * as displayed, origin at the visual bottom-left, u→right, v→up — and mapped to
 * pdf-lib's page (unrotated) space so text lands where the user sees the edge and
 * reads upright, even on a `/Rotate`d or origin-shifted page.
 *
 * `vw`/`vh` are the visual (displayed) dimensions. `toPage(u,v)` maps a visual
 * anchor to page-space (x,y). `rot` is the page rotation to add to any text angle
 * (a 0° watermark becomes `rot`; a 45° watermark becomes `rot + 45`).
 */
function visualPlacer(page: PdfLibPage) {
  const { x: ox, y: oy, width: W, height: H } = page.getMediaBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const vw = swap ? H : W;
  const vh = swap ? W : H;
  const toPage = (u: number, v: number): { x: number; y: number } => {
    switch (rot) {
      case 90: return { x: ox + (W - v), y: oy + u };
      case 180: return { x: ox + (W - u), y: oy + (H - v) };
      case 270: return { x: ox + v, y: oy + (H - u) };
      default: return { x: ox + u, y: oy + v };
    }
  };
  return { vw, vh, rot, toPage };
}

/** Stamp a diagonal text watermark on every (or selected) page. */
export async function addWatermark(src: Uint8Array, opts: WatermarkOptions): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, degrees, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.load(src);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const { r, g, b } = hexToRgb(opts.color ?? '#808080');
  const opacity = opts.opacity ?? 0.3;
  const rotation = opts.rotation ?? 45;
  const fontSize = opts.fontSize ?? 60;
  const pageSet = opts.pages ? new Set(opts.pages.map((n) => n - 1)) : null;

  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    if (pageSet && !pageSet.has(i)) continue;
    const page = pages[i];
    const { vw, vh, rot, toPage } = visualPlacer(page);
    const textWidth = font.widthOfTextAtSize(opts.text, fontSize);
    // Centered in visual space; text angle combines the requested diagonal with
    // the page's own rotation so it reads consistently on rotated pages.
    const { x, y } = toPage((vw - textWidth) / 2, (vh - fontSize) / 2);
    page.drawText(opts.text, {
      x,
      y,
      size: fontSize,
      font,
      color: rgb(r, g, b),
      opacity,
      rotate: degrees(rot + rotation),
    });
  }

  return doc.save();
}

/** Add header and/or footer text to every page. Supports {page}, {pages}, {date}. */
export async function addHeaderFooter(src: Uint8Array, opts: HeaderFooterOptions): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import('pdf-lib');
  const doc = await PDFDocument.load(src);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontSize = opts.fontSize ?? 10;
  const margin = opts.margin ?? 36;
  const pages = doc.getPages();
  const total = pages.length;

  for (let i = 0; i < pages.length; i++) {
    if (opts.skipFirstPage && i === 0) continue;
    const page = pages[i];
    const { vw, vh, rot, toPage } = visualPlacer(page);
    const pageNum = i + 1;

    // `v` is the vertical position in visual space; `u` is horizontal. drawText
    // gets page-space coords + the page rotation so bands sit at the displayed
    // top/bottom edges and read upright on rotated pages.
    const drawBand = (band: { left?: string; center?: string; right?: string }, v: number) => {
      const put = (text: string, u: number) => {
        const { x, y } = toPage(u, v);
        page.drawText(text, { x, y, size: fontSize, font, color: rgb(0, 0, 0), rotate: degrees(rot) });
      };
      if (band.left) put(resolveTemplate(band.left, pageNum, total), margin);
      if (band.center) {
        const text = resolveTemplate(band.center, pageNum, total);
        put(text, vw / 2 - font.widthOfTextAtSize(text, fontSize) / 2);
      }
      if (band.right) {
        const text = resolveTemplate(band.right, pageNum, total);
        put(text, vw - margin - font.widthOfTextAtSize(text, fontSize));
      }
    };

    if (opts.header) drawBand(opts.header, vh - margin);
    if (opts.footer) drawBand(opts.footer, margin - fontSize);
  }

  return doc.save();
}

/** Stamp sequential Bates numbers on every (or selected) page. */
export async function addBatesNumbers(src: Uint8Array, opts: BatesOptions): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import('pdf-lib');
  const doc = await PDFDocument.load(src);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontSize = opts.fontSize ?? 10;
  const margin = opts.margin ?? 36;
  const digits = opts.digits ?? 6;
  const prefix = opts.prefix ?? '';
  const start = opts.startNumber ?? 1;
  const position = opts.position ?? 'bottom-right';
  const pageSet = opts.pages ? new Set(opts.pages.map((n) => n - 1)) : null;

  const pages = doc.getPages();
  let counter = start;

  for (let i = 0; i < pages.length; i++) {
    // Skip unselected pages WITHOUT advancing the counter, so stamped pages get
    // sequential numbers (start..start+N-1) rather than numbers with gaps.
    if (pageSet && !pageSet.has(i)) continue;
    const page = pages[i];
    const { vw, vh, rot, toPage } = visualPlacer(page);
    const label = `${prefix}${String(counter).padStart(digits, '0')}`;
    const tw = font.widthOfTextAtSize(label, fontSize);

    const isTop = position.startsWith('top');
    const isRight = position.endsWith('right');
    // Corner position in visual space, mapped to page space so the stamp lands
    // at the displayed corner and reads upright on rotated pages.
    const u = isRight ? vw - margin - tw : margin;
    const v = isTop ? vh - margin : margin - fontSize;
    const { x, y } = toPage(u, v);

    page.drawText(label, { x, y, size: fontSize, font, color: rgb(0, 0, 0), rotate: degrees(rot) });
    counter++;
  }

  return doc.save();
}
