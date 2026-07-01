// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 5 — Page furniture: watermark, header/footer, and Bates numbering,
 * implemented via pdf-lib (already in the write-side stack). Each function
 * receives the current document bytes and options, and returns new bytes as an
 * incremental update (append-only so existing annotations/signatures survive).
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
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
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
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(opts.text, fontSize);
    page.drawText(opts.text, {
      x: (width - textWidth) / 2,
      y: (height - fontSize) / 2,
      size: fontSize,
      font,
      color: rgb(r, g, b),
      opacity,
      rotate: degrees(rotation),
    });
  }

  return doc.save();
}

/** Add header and/or footer text to every page. Supports {page}, {pages}, {date}. */
export async function addHeaderFooter(src: Uint8Array, opts: HeaderFooterOptions): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.load(src);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontSize = opts.fontSize ?? 10;
  const margin = opts.margin ?? 36;
  const pages = doc.getPages();
  const total = pages.length;

  for (let i = 0; i < pages.length; i++) {
    if (opts.skipFirstPage && i === 0) continue;
    const page = pages[i];
    const { width, height } = page.getSize();
    const pageNum = i + 1;

    const drawBand = (band: { left?: string; center?: string; right?: string }, y: number) => {
      const half = width / 2;
      if (band.left) {
        const text = resolveTemplate(band.left, pageNum, total);
        page.drawText(text, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
      }
      if (band.center) {
        const text = resolveTemplate(band.center, pageNum, total);
        const tw = font.widthOfTextAtSize(text, fontSize);
        page.drawText(text, { x: half - tw / 2, y, size: fontSize, font, color: rgb(0, 0, 0) });
      }
      if (band.right) {
        const text = resolveTemplate(band.right, pageNum, total);
        const tw = font.widthOfTextAtSize(text, fontSize);
        page.drawText(text, { x: width - margin - tw, y, size: fontSize, font, color: rgb(0, 0, 0) });
      }
    };

    if (opts.header) drawBand(opts.header, height - margin);
    if (opts.footer) drawBand(opts.footer, margin - fontSize);
  }

  return doc.save();
}

/** Stamp sequential Bates numbers on every (or selected) page. */
export async function addBatesNumbers(src: Uint8Array, opts: BatesOptions): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
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
    if (pageSet && !pageSet.has(i)) { counter++; continue; }
    const page = pages[i];
    const { width, height } = page.getSize();
    const label = `${prefix}${String(counter).padStart(digits, '0')}`;
    const tw = font.widthOfTextAtSize(label, fontSize);

    const isTop = position.startsWith('top');
    const isRight = position.endsWith('right');
    const x = isRight ? width - margin - tw : margin;
    const y = isTop ? height - margin : margin - fontSize;

    page.drawText(label, { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
    counter++;
  }

  return doc.save();
}
