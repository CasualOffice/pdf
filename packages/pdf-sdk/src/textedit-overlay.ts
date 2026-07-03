// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Overlay-replace text editing ("Option A" — quick edits, done right).
 *
 * Instead of mutating the page content stream (which substitutes the font AND
 * re-flows/re-spaces the whole page — see docs/TEXT-EDITING.md), an edit here is
 * localized: paint an opaque rectangle over the old run, then draw the new text
 * on top in a matched standard font. Nothing else on the page moves — no
 * justification collapse, no neighbour shift.
 *
 * Trade-offs (disclosed in the UI): the overlay text uses a standard-14 font
 * (not the original embedded face), there is no paragraph reflow, and in this
 * non-destructive mode the original glyphs remain in the bytes beneath the opaque
 * box (use Redaction, or a future Bake mode, to remove them). Pure pdf-lib —
 * lazy-loaded, same shared chunk as redact.ts / merge.ts.
 */

/** A run's bounds in PDF user space (points, bottom-left origin). */
export interface OverlayRect {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/** Visual style to match, taken from the edited PdfTextRun. */
export interface OverlayStyle {
  /** CSS font-family stack (serif/sans/mono is inferred from it). */
  fontFamily: string;
  /** Rendered font size in PDF points. */
  fontSizePt: number;
  /** CSS font-weight 100–900. */
  fontWeight: number;
  fontItalic: boolean;
  /** CSS color string, e.g. "rgb(0,0,0)". */
  color: string;
  /** Bytes of a bundled metric-compatible font (Option C). When present, the
   *  overlay embeds this font (via pdf-lib + fontkit) so the edit keeps the
   *  apparent typeface; otherwise it falls back to a standard-14 substitute. */
  matchedFontBytes?: Uint8Array;
}

export interface OverlayOptions {
  /** Fill for the covering box. Defaults to white (most pages). RGB 0–255. */
  bgColor?: [number, number, number];
}

function parseRgb(css: string): [number, number, number] {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(css);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Map the run's style to one of the 14 standard fonts. Mirrors the PDFium-path
 *  substitution so the two editors pick the same face. */
function standardFontName(style: OverlayStyle): string {
  const f = style.fontFamily.toLowerCase();
  const mono = /courier|mono|consol/.test(f);
  const serif = !mono && /times|serif|georgia|roman|garamond|minion/.test(f);
  const bold = style.fontWeight >= 600;
  const italic = style.fontItalic;
  if (mono) return bold ? (italic ? 'CourierBoldOblique' : 'CourierBold') : (italic ? 'CourierOblique' : 'Courier');
  if (serif) return bold ? (italic ? 'TimesRomanBoldItalic' : 'TimesRomanBold') : (italic ? 'TimesRomanItalic' : 'TimesRoman');
  return bold ? (italic ? 'HelveticaBoldOblique' : 'HelveticaBold') : (italic ? 'HelveticaOblique' : 'Helvetica');
}

/**
 * Return new PDF bytes with `rect` on `pageIndex` covered and `newText` drawn on
 * top in a matched standard font. Coordinates are PDF user space (as reported by
 * the text-run engine). Rotated pages / non-zero-origin MediaBoxes are handled by
 * pdf-lib's page coordinate space.
 */
export async function buildOverlayEdit(
  src: Uint8Array,
  pageIndex: number,
  rect: OverlayRect,
  newText: string,
  style: OverlayStyle,
  opts: OverlayOptions = {},
): Promise<{ bytes: Uint8Array; matched: boolean }> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.load(src);
  const pages = doc.getPages();
  if (pageIndex < 0 || pageIndex >= pages.length) throw new Error(`Page ${pageIndex + 1} is out of range.`);
  const page = pages[pageIndex];

  const [br, bg, bb] = opts.bgColor ?? [255, 255, 255];
  const box = rgb(br / 255, bg / 255, bb / 255);
  const [tr, tg, tb] = parseRgb(style.color);
  const textColor = rgb(tr / 255, tg / 255, tb / 255);

  // Cover the old run. Pad slightly so anti-aliased glyph edges don't peek out.
  const pad = Math.max(0.5, style.fontSizePt * 0.06);
  page.drawRectangle({
    x: rect.left - pad,
    y: rect.bottom - pad,
    width: rect.right - rect.left + pad * 2,
    height: rect.top - rect.bottom + pad * 2,
    color: box,
  });

  let matched = false;
  if (newText.length > 0) {
    let font;
    if (style.matchedFontBytes) {
      // Option C: embed the bundled metric-compatible font so the typeface is
      // kept. subset:true can crash on some fonts (fontkit #1396) → retry full
      // embed, then fall back to a standard font.
      const fontkit = (await import('@pdf-lib/fontkit')).default;
      doc.registerFontkit(fontkit);
      try {
        font = await doc.embedFont(style.matchedFontBytes, { subset: true });
        matched = true;
      } catch {
        try {
          font = await doc.embedFont(style.matchedFontBytes, { subset: false });
          matched = true;
        } catch {
          font = await doc.embedFont(StandardFonts[standardFontName(style) as keyof typeof StandardFonts]);
        }
      }
    } else {
      font = await doc.embedFont(StandardFonts[standardFontName(style) as keyof typeof StandardFonts]);
    }
    // The run bounds' bottom is the glyph bounding box bottom (below the
    // baseline by the descent). Lift the baseline by an approximate descent
    // (~20% of size) so the new text sits on the original baseline.
    const size = style.fontSizePt;
    page.drawText(newText, {
      x: rect.left,
      y: rect.bottom + size * 0.2,
      size,
      font,
      color: textColor,
    });
  }

  return { bytes: await doc.save(), matched };
}
