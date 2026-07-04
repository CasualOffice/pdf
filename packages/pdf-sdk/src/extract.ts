// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical text-with-coordinates extraction — the grounding primitive the AI
 * layer builds on (RAG chunking, "ask-with-citations", structured extract). See
 * `docs/AI.md` §4 (RAG) / §12 (UX-AI1).
 *
 * There are two coordinate systems in this codebase and mixing them is the #1
 * source of misaligned highlights, so this module fixes ONE canonical shape and
 * a single documented converter:
 *
 *  - **PDF user space** (what PDFium / `listTextRuns` report): origin at the
 *    page's MediaBox corner, **Y grows upward**, units = points. A run is
 *    `{ left, bottom, right, top }`.
 *  - **Fractional top-left** (what this module emits as `frac`, and what the
 *    viewer's annotation/redaction layers consume): origin at the page's
 *    TOP-left, **Y grows downward**, both axes normalised to `[0, 1]` of the
 *    MediaBox. A rect is `{ x, y, w, h }`.
 *
 * `toFractionalTopLeft` is the ONLY sanctioned conversion — call it, never
 * hand-roll a Y-flip. Coordinates are in the page's **native** orientation
 * (the app viewer renders native and ignores `/Rotate`, matching redaction and
 * search highlights); a page with a non-zero `/Rotate` would need the display
 * transform for spec-compliant EXTERNAL viewers — tracked as a follow-up.
 *
 * Pure bytes in, no viewer required — so the same primitive runs client-side or
 * server-side (Docker-via-collab). Built on `listTextRuns` (already reading-order
 * sorted: baseline top→bottom, then left→right) + pdf-lib for the MediaBox.
 */
import { listTextRuns, type PdfTextRun } from './textedit-pdfium';

/** A rectangle in PDF user space (origin at the MediaBox corner, Y up). */
export interface UserSpaceRect {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/** A rectangle in canonical fractional top-left space (`[0,1]`, Y down). */
export interface FractionalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Origin-aware page box in points. */
export interface MediaBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One extracted text run: text, both coordinate forms, char offsets, font. */
export interface ExtractedRun {
  /** The run's text. */
  text: string;
  /** Inclusive-exclusive char range into the page's `text` string
   *  (`text.slice(charStart, charEnd) === run.text`). Lets an LLM-cited char
   *  span be resolved back to the run(s) that produced it. */
  charStart: number;
  charEnd: number;
  /** Bounds in PDF user space (origin at MediaBox corner, Y up). */
  userSpace: UserSpaceRect;
  /** Bounds in canonical fractional top-left space (for the highlight layer). */
  frac: FractionalRect;
  /** Rendered font size in points. */
  fontSizePt: number;
  /** CSS font weight (100–900). */
  fontWeight: number;
  fontItalic: boolean;
  /** Base family name, subset tag stripped (e.g. "Arial"). */
  fontBaseName: string;
  /** True when the run's font is subsetted (heading/structure heuristics). */
  fontSubsetted: boolean;
  /** CSS color string of the text fill. */
  color: string;
}

/** The canonical extraction result for a single page. */
export interface PageText {
  /** Zero-based page index. */
  pageIndex: number;
  /** Page width/height in points (MediaBox). */
  width: number;
  height: number;
  /** Origin-aware MediaBox (needed to re-run the coordinate conversion). */
  mediaBox: MediaBox;
  /** The full page text, runs joined in reading order by newlines. */
  text: string;
  /** The runs, in reading order, each carrying its coordinates + char range. */
  runs: ExtractedRun[];
}

/**
 * THE canonical converter: a PDF user-space rect → fractional top-left, relative
 * to `mediaBox`. Handles a non-zero MediaBox origin and flips Y. Output is
 * clamped to `[0, 1]`. Do not duplicate this math elsewhere.
 */
export function toFractionalTopLeft(rect: UserSpaceRect, mediaBox: MediaBox): FractionalRect {
  const { x: ox, y: oy, width: W, height: H } = mediaBox;
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const x = clamp01((rect.left - ox) / W);
  // Flip Y: the run's TOP edge (largest user-space Y) becomes the smallest
  // top-left Y. `y` is the distance from the page top down to the run's top.
  const y = clamp01((oy + H - rect.top) / H);
  const w = clamp01((rect.right - rect.left) / W);
  const h = clamp01((rect.top - rect.bottom) / H);
  return { x, y, w, h };
}

/** Read a page's MediaBox via pdf-lib (lazy-loaded, same as redact/furniture). */
async function readMediaBox(src: Uint8Array, pageIndex: number): Promise<MediaBox> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(src, { updateMetadata: false });
  const pages = doc.getPages();
  if (pageIndex < 0 || pageIndex >= pages.length) {
    throw new Error(`page ${pageIndex} out of range (0..${pages.length - 1})`);
  }
  return pages[pageIndex].getMediaBox(); // origin-aware {x, y, width, height}
}

function toExtractedRun(run: PdfTextRun, mediaBox: MediaBox, charStart: number): ExtractedRun {
  const userSpace: UserSpaceRect = {
    left: run.left,
    bottom: run.bottom,
    right: run.right,
    top: run.top,
  };
  return {
    text: run.text,
    charStart,
    charEnd: charStart + run.text.length,
    userSpace,
    frac: toFractionalTopLeft(userSpace, mediaBox),
    fontSizePt: run.fontSizePt,
    fontWeight: run.fontWeight,
    fontItalic: run.fontItalic,
    fontBaseName: run.fontBaseName,
    fontSubsetted: run.fontSubsetted,
    color: run.color,
  };
}

/**
 * Extract a page's text with per-run coordinates in both user space and the
 * canonical fractional top-left form. Runs are in reading order and their
 * `charStart`/`charEnd` index into `PageText.text` (joined by newlines).
 */
export async function extractPageText(src: Uint8Array, pageIndex: number): Promise<PageText> {
  const [runs, mediaBox] = await Promise.all([
    listTextRuns(src, pageIndex),
    readMediaBox(src, pageIndex),
  ]);

  const extracted: ExtractedRun[] = [];
  let offset = 0;
  let text = '';
  for (const run of runs) {
    if (offset > 0) {
      text += '\n';
      offset += 1;
    }
    extracted.push(toExtractedRun(run, mediaBox, offset));
    text += run.text;
    offset += run.text.length;
  }

  return {
    pageIndex,
    width: mediaBox.width,
    height: mediaBox.height,
    mediaBox,
    text,
    runs: extracted,
  };
}
