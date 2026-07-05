// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-span highlighting for AI citations (docs/AI.md §5 / UX-AI1). When the
 * AI cites a passage, `highlight_source(page, text)` finds the matching text
 * runs and highlights them so the user sees exactly where an answer came from.
 *
 * The critical bit — the coordinate space — is unit-tested here: `extractPageText`
 * returns run bounds in PDF user space (bottom-left origin, `{left,bottom,right,
 * top}`), and the EmbedPDF annotation rect uses the SAME space as
 * `{origin:{x,y}, size:{width,height}}` (confirmed against the redaction path in
 * chrome.tsx). So it's a shape change, not a risky re-projection — no Y-flip.
 */

import type { UserSpaceRect } from '../extract';

/** EmbedPDF annotation rectangle (PDF user space, bottom-left origin). */
export interface AnnotationRect {
  origin: { x: number; y: number };
  size: { width: number; height: number };
}

/** A PDF user-space rect → EmbedPDF annotation rect. Same space; no flip. */
export function toAnnotationRect(r: UserSpaceRect): AnnotationRect {
  return {
    origin: { x: r.left, y: r.bottom },
    size: { width: r.right - r.left, height: r.top - r.bottom },
  };
}

/** The bounding rect over a set of annotation rects (for the annotation's `rect`). */
export function boundingRect(rects: AnnotationRect[]): AnnotationRect {
  const xs = rects.map((r) => r.origin.x);
  const ys = rects.map((r) => r.origin.y);
  const x2 = rects.map((r) => r.origin.x + r.size.width);
  const y2 = rects.map((r) => r.origin.y + r.size.height);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { origin: { x: minX, y: minY }, size: { width: Math.max(...x2) - minX, height: Math.max(...y2) - minY } };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Select the runs that make up a cited passage: a run matches when (normalised)
 * it contains the query or the query contains it — so a phrase spanning several
 * runs highlights all of them, and a keyword highlights the run(s) it sits in.
 * Best-effort: the model passes an exact quote; this tolerates whitespace.
 */
export function findRunsForText<T extends { text: string; userSpace: UserSpaceRect }>(runs: T[], query: string): T[] {
  const q = norm(query);
  if (!q) return [];
  return runs.filter((r) => {
    const t = norm(r.text);
    return t.length > 0 && (t.includes(q) || q.includes(t));
  });
}
