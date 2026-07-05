// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Turn the page citations the AI writes into its answers ("page 3", "pages 4",
 * "p. 12") into clickable jump-to-source links. The model is prompted to cite
 * 1-based pages (catalog.ts PDF_SYSTEM_PROMPT); a click navigates the viewer via
 * `CasualPdfApi.gotoPage(page - 1)`.
 *
 * This is the low-risk citation layer (navigation only). Highlighting the exact
 * source span on the page is a later, coordinate-careful follow-on (docs/AI.md
 * §5 / UX-AI1) — it needs the fractional `extractPageText` rects mapped into the
 * annotation layer's space, which is verified separately.
 */

export type CiteSegment = { type: 'text'; text: string } | { type: 'page'; page: number; label: string };

// "page 3", "pages 3", "p. 3", "pp. 3", and ranges "pages 3-5" — a page keyword
// directly before a number (the whole range is consumed so "-5" isn't left as
// stray text; a click navigates to the range's first page).
const PAGE_RE = /\b(?:pages?|pp?\.)\s*(\d+)(?:\s*[-–—]\s*\d+)?/gi;

/**
 * Split `text` into plain-text and page-citation segments. `page` is 1-based
 * (as written for the user). Returns a single text segment when there are no
 * citations.
 */
export function linkifyCitations(text: string): CiteSegment[] {
  const segs: CiteSegment[] = [];
  let last = 0;
  PAGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAGE_RE.exec(text)) !== null) {
    const page = Number(m[1]);
    if (!Number.isInteger(page) || page < 1) continue;
    if (m.index > last) segs.push({ type: 'text', text: text.slice(last, m.index) });
    segs.push({ type: 'page', page, label: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: 'text', text: text.slice(last) });
  return segs.length ? segs : [{ type: 'text', text }];
}
