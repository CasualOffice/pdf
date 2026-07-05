// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Tier-2 text editing via PDFium — the REAL engine (replaces the inadequate
 * lopdf Tj-rewrite). PDFium edits at the text-object level (FPDFText_SetText →
 * FPDFPage_GenerateContent → save), descends into Form XObjects, and handles
 * Type0/Type3 fonts — the things content-stream surgery can't. Validated in a
 * native spike (crates/casual-pdf-core/examples/edit_text.rs).
 *
 * On the web we need no second PDFium build and no Rust: the PDFium-WASM EmbedPDF
 * already loads exports the full edit API, and `@embedpdf/pdfium`'s `init()`
 * returns a wrapped module whose top level holds the cwrapped FPDF_* / PDFiumExt_*
 * callables and whose `.pdfium` member is the Emscripten module (heap + helpers).
 *
 * FONT CAVEAT (handled fail-closed by callers): embedded fonts are subsetted, so
 * typing a character the run's font doesn't already contain renders as .notdef.
 * Detection/substitution is layered on top; this module is the raw edit engine.
 */
import { init } from '@embedpdf/pdfium';
// Use the locally-bundled WASM asset so the browser can hit its HTTP cache
// (the viewer already fetches this file during render-engine init). The ?url
// Vite suffix emits the asset and returns its hashed public path.
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';

const FPDF_PAGEOBJ_TEXT = 1;
// Full rewrite (not FPDF_INCREMENTAL): the edited text replaces the original in
// the output rather than appending a superseding update, so the old text isn't
// left buried in the bytes (matches the native save_to_bytes() behaviour).
const FPDF_NO_INCREMENTAL = 2;

// PDF font descriptor flags (ISO 32000 Table 121; 1-based bit → value).
const FLAG_FIXED_PITCH = 1 << 0;
const FLAG_SERIF = 1 << 1;
const FLAG_ITALIC = 1 << 6;

/** The Emscripten heap helpers (on the wrapped module's `.pdfium`). */
interface Heap {
  _malloc(n: number): number;
  _free(p: number): void;
  HEAPU8: Uint8Array;
  stringToUTF16(s: string, ptr: number, maxBytes: number): void;
}

/** The wrapped PDFium module: cwrapped `FPDF_` / `PDFiumExt_` functions at the
 *  top level, the Emscripten module under `.pdfium`. Runtime shape; the published
 *  types don't declare the cwrapped members, so we assert this. */
interface Pdfium {
  pdfium: Heap;
  PDFiumExt_Init(): void;
  FPDF_LoadMemDocument(data: number, size: number, password: string): number;
  FPDF_LoadPage(doc: number, index: number): number;
  FPDF_ClosePage(page: number): void;
  FPDF_CloseDocument(doc: number): void;
  FPDFText_LoadPage(page: number): number;
  FPDFText_ClosePage(textPage: number): void;
  FPDFPage_CountObjects(page: number): number;
  FPDFPage_GetObject(page: number, index: number): number;
  FPDFPageObj_GetType(obj: number): number;
  FPDFTextObj_GetText(obj: number, textPage: number, buffer: number, length: number): number;
  FPDFPageObj_GetBounds(obj: number, l: number, b: number, r: number, t: number): boolean;
  FPDFText_SetText(obj: number, wide: number): boolean;
  FPDFTextObj_GetFont(obj: number): number;
  FPDFTextObj_GetFontSize(obj: number, sizeOut: number): boolean;
  FPDFFont_GetFlags(font: number): number;
  FPDFFont_GetWeight(font: number): number;
  FPDFFont_GetBaseFontName(font: number, buffer: number, length: number): number;
  FPDFPageObj_GetMatrix(obj: number, matrixOut: number): boolean;
  FPDFPageObj_SetMatrix(obj: number, matrix: number): boolean;
  FPDFPageObj_GetFillColor(obj: number, r: number, g: number, b: number, a: number): boolean;
  FPDFPageObj_SetFillColor(obj: number, r: number, g: number, b: number, a: number): boolean;
  FPDFText_LoadStandardFont(doc: number, fontName: string): number;
  FPDFPageObj_CreateTextObj(doc: number, font: number, fontSize: number): number;
  FPDFPage_InsertObject(page: number, obj: number): void;
  FPDFPage_GenerateContent(page: number): boolean;
  PDFiumExt_OpenFileWriter(): number;
  FPDF_SaveAsCopy(doc: number, writer: number, flags: number): boolean;
  PDFiumExt_GetFileWriterSize(writer: number): number;
  PDFiumExt_GetFileWriterData(writer: number, buffer: number, size: number): number;
  PDFiumExt_CloseFileWriter(writer: number): void;
}

let modulePromise: Promise<Pdfium> | null = null;
async function ensurePdfium(): Promise<Pdfium> {
  if (!modulePromise) {
    // Fetch the locally-bundled WASM. The render engine already fetched this
    // same URL so the browser HTTP cache serves it instantly on the second call.
    const p = (async () => {
      const wasmBinary = new Uint8Array(await (await fetch(pdfiumWasmUrl)).arrayBuffer());
      const wrapped = (await init({ wasmBinary } as Parameters<typeof init>[0])) as unknown as Pdfium;
      wrapped.PDFiumExt_Init();
      return wrapped;
    })();
    modulePromise = p;
    // On init failure (fetch/instantiate), clear the cached *rejected* promise so
    // the next call retries instead of returning the same rejection forever.
    // Guard by identity so we never null out a newer in-flight attempt.
    p.catch(() => { if (modulePromise === p) modulePromise = null; });
  }
  return modulePromise;
}

/** Warm up the PDFium WASM in the background (call when entering text-edit mode
 *  so the module is ready before the user clicks a run). */
export function preloadPdfium(): void {
  ensurePdfium().catch(() => { /* ignore — will retry on actual edit */ });
}

/** Read a text object's current text (UTF-16LE) via a text page. */
function readObjText(p: Pdfium, textPage: number, obj: number): string {
  const m = p.pdfium;
  // First call with null/0 returns the required size. PDFium may express this
  // in UTF-16 code units OR in bytes depending on build; we treat it as units
  // and allocate byteLen = need * 2 to be safe under either interpretation.
  const need = p.FPDFTextObj_GetText(obj, textPage, 0, 0);
  if (need <= 0) return '';
  const byteLen = need * 2;
  const buf = m._malloc(byteLen);
  try {
    // Pass byteLen (not need) so PDFium has the full buffer regardless of
    // whether it interprets the length as bytes or code units.
    p.FPDFTextObj_GetText(obj, textPage, buf, byteLen);
    const u16 = new Uint16Array(m.HEAPU8.buffer, buf, need);
    let s = '';
    for (let i = 0; i < u16.length; i++) {
      if (u16[i] === 0) break; // stop at null terminator, not at `need - 1`
      s += String.fromCharCode(u16[i]);
    }
    return s;
  } finally {
    m._free(buf);
  }
}

/** Write `text` as a NUL-terminated UTF-16LE buffer; returns a pointer to free. */
function allocUtf16(p: Pdfium, text: string): number {
  const bytes = (text.length + 1) * 2;
  const buf = p.pdfium._malloc(bytes);
  p.pdfium.stringToUTF16(text, buf, bytes);
  return buf;
}

/** Serialize the (edited) document to bytes via PDFium's file writer. */
function saveDoc(p: Pdfium, doc: number): Uint8Array {
  const m = p.pdfium;
  const writer = p.PDFiumExt_OpenFileWriter();
  try {
    if (!p.FPDF_SaveAsCopy(doc, writer, FPDF_NO_INCREMENTAL)) throw new Error('FPDF_SaveAsCopy failed');
    const size = p.PDFiumExt_GetFileWriterSize(writer);
    const buf = m._malloc(size);
    try {
      p.PDFiumExt_GetFileWriterData(writer, buf, size);
      return m.HEAPU8.slice(buf, buf + size);
    } finally {
      m._free(buf);
    }
  } finally {
    p.PDFiumExt_CloseFileWriter(writer);
  }
}

/** Run `fn` with a loaded document + page, cleaning up all PDFium handles. */
async function withPage<T>(
  src: Uint8Array,
  pageIndex: number,
  fn: (p: Pdfium, doc: number, page: number, textPage: number) => T | Promise<T>,
): Promise<T> {
  const p = await ensurePdfium();
  const m = p.pdfium;
  const srcPtr = m._malloc(src.length);
  m.HEAPU8.set(src, srcPtr);
  const doc = p.FPDF_LoadMemDocument(srcPtr, src.length, '');
  if (!doc) {
    m._free(srcPtr);
    throw new Error('Could not open the document for editing.');
  }
  let page = 0;
  let textPage = 0;
  try {
    page = p.FPDF_LoadPage(doc, pageIndex);
    if (!page) throw new Error(`Could not load page ${pageIndex + 1}.`);
    textPage = p.FPDFText_LoadPage(page);
    return await fn(p, doc, page, textPage); // await: keep the doc loaded across async font fetch
  } finally {
    if (textPage) p.FPDFText_ClosePage(textPage);
    if (page) p.FPDF_ClosePage(page);
    p.FPDF_CloseDocument(doc);
    m._free(srcPtr); // FPDF_LoadMemDocument keeps a reference until close
  }
}

/** Map PDFium font flags + name to a CSS font-family stack so the edit input
 *  renders in approximately the same typeface as the original PDF text. */
function cssFontFamily(flags: number, name: string): string {
  const n = name.toLowerCase();
  const mono = (flags & FLAG_FIXED_PITCH) !== 0 || /courier|mono|consol/.test(n);
  const serif = !mono && ((flags & FLAG_SERIF) !== 0 || /times|serif|georgia|roman|garamond|minion/.test(n));
  if (mono) return "'Courier New', Courier, monospace";
  if (serif) return "Georgia, 'Times New Roman', Times, serif";
  return "'Helvetica Neue', Helvetica, Arial, sans-serif";
}

/** A logical text run shown in the edit overlay (may span multiple raw PDFium
 *  text objects that were merged by proximity). */
export interface PdfTextRun {
  /** Primary object index (used for font/matrix info on edit). */
  index: number;
  /** All object indices in this run — the primary plus any adjacent objects
   *  that were merged with it. On edit, secondary objects are cleared. */
  indices: number[];
  text: string;
  /** Bounds in PDF user space (left, bottom, right, top). */
  left: number;
  bottom: number;
  right: number;
  top: number;
  /** Always true — every run is offered for editing; errors from the engine
   *  surface via the edit banner so the document stays unchanged on failure. */
  editable: boolean;
  /** CSS font-family stack matching the run's typeface (serif/sans/mono). */
  fontFamily: string;
  /** Font size in PDF user-space points (use × px/pt to get CSS pixels). */
  fontSizePt: number;
  /** CSS font-weight (100–900). */
  fontWeight: number;
  /** True if the run's font is italic/oblique. */
  fontItalic: boolean;
  /** CSS color string for the text fill (e.g. "rgb(0,0,0)"). */
  color: string;
  /**
   * True when the font name contains a subset tag (e.g. "ABCDEF+Arial" per
   * ISO 32000 §9.6.4). Subsetted fonts only carry glyphs already used in the
   * document, so editing may silently substitute a standard font even if no
   * visually new characters are introduced. Surfaced to the UI for a tooltip.
   */
  fontSubsetted: boolean;
  /** Base family name, subset tag stripped (e.g. "Arial"). Used to match a
   *  bundled metric-compatible font so an edit can keep the apparent typeface. */
  fontBaseName: string;
}

/** List the text runs on a page. Adjacent PDFium text objects (which can be
 *  per-character in many PDFs) are grouped into logical runs by proximity —
 *  objects on the same baseline within a small horizontal gap are merged into
 *  one editable box. */
export async function listTextRuns(src: Uint8Array, pageIndex: number): Promise<PdfTextRun[]> {
  return withPage(src, pageIndex, (p, _doc, page, textPage) => {
    const m = p.pdfium;
    type Obj = { index: number; text: string; left: number; bottom: number; right: number; top: number };
    const objs: Obj[] = [];
    const n = p.FPDFPage_CountObjects(page);
    for (let i = 0; i < n; i++) {
      const obj = p.FPDFPage_GetObject(page, i);
      if (p.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) continue;
      const text = readObjText(p, textPage, obj);
      if (!text) continue;
      const fl = m._malloc(16);
      p.FPDFPageObj_GetBounds(obj, fl, fl + 4, fl + 8, fl + 12);
      const f = new Float32Array(m.HEAPU8.buffer, fl, 4);
      const [left, bottom, right, top] = [f[0], f[1], f[2], f[3]];
      m._free(fl);
      if (right <= left || top <= bottom) continue;
      // Filter objects moved off-page as a suppress fallback (see suppress() below).
      if (left < -1000 || bottom < -1000) continue;
      objs.push({ index: i, text, left, bottom, right, top });
    }

    // Sort by baseline (bottom coordinate) descending — higher on page first.
    // Baseline is stable across mixed-height characters on the same line
    // (capitals, descenders, accents all differ in top but share the baseline).
    // Within the same baseline (tolerance 3pt), sort left→right.
    objs.sort((a, b) => {
      const dy = b.bottom - a.bottom;
      if (Math.abs(dy) > 3) return dy;
      return a.left - b.left;
    });

    // Group adjacent objects into logical runs (line level). Many PDFs split a
    // sentence into per-word or per-glyph objects; be generous about normal word
    // spacing, but still avoid jumping across columns.
    // Two objects merge when:
    //  • their baselines are within ~35% of the taller character's height (same line)
    //  • the horizontal gap is within a line-scale threshold, capped at 240pt to
    //    handle large title/heading word spacing without merging columns
    //  • overlap ≤ 50% of height (tolerate kerning but not two separate words)
    const groups: Obj[][] = [];
    for (const o of objs) {
      const h = o.top - o.bottom;
      const last = groups.length ? groups[groups.length - 1] : null;
      if (last) {
        const prev = last[last.length - 1];
        const prevH = prev.top - prev.bottom;
        const sameLine = Math.abs(prev.bottom - o.bottom) < Math.max(prevH, h) * 0.35;
        const hGap = o.left - prev.right;
        const maxGap = Math.min(Math.max(Math.max(prevH, h) * 10, 48), 240);
        if (sameLine && hGap < maxGap && hGap >= -h * 0.5) {
          last.push(o);
          continue;
        }
      }
      groups.push([o]);
    }

    const logicalGroups = groups.filter((g) => g.some((o) => o.text.length > 0));

    const groupText = (g: Obj[]) =>
      g.map((o, i) => {
        if (i === 0) return o.text;
        const prev = g[i - 1];
        const h = Math.max(prev.top - prev.bottom, o.top - o.bottom);
        const gap = o.left - prev.right;
        const needsSpace = gap > h * 0.45 && !/\s$/.test(prev.text) && !/^\s/.test(o.text);
        return `${needsSpace ? ' ' : ''}${o.text}`;
      }).join('');

    return logicalGroups.map((g) => {
      // Extract font metadata from the primary (first) object for display.
      const primaryObj = p.FPDFPage_GetObject(page, g[0].index);
      const font = primaryObj ? p.FPDFTextObj_GetFont(primaryObj) : 0;
      const flags = font ? p.FPDFFont_GetFlags(font) : 0;
      const rawWeight = font ? p.FPDFFont_GetWeight(font) : 400;
      const name = font ? readFontName(p, font) : '';
      const designSizePt = primaryObj ? (readFontSize(p, primaryObj) || 0) : 0;
      const [cr, cg, cb] = primaryObj ? readFillColor(p, primaryObj) : [0, 0, 0, 255];
      const italic = (flags & FLAG_ITALIC) !== 0 || /italic|oblique/i.test(name);
      const fontWeight = Math.min(900, Math.max(100, rawWeight > 0 ? rawWeight : 400));

      // FPDFTextObj_GetFontSize returns the *design* font size (before the text
      // matrix scale). Rendered size = designSizePt × |matrix.d|. Use the primary
      // object's bounding-box height as a sanity fallback when the matrix-corrected
      // value is out of a plausible reading range (4–200pt).
      const primaryH = g[0].top - g[0].bottom;
      let fontSizePt = primaryH; // safe default = actual bounding box height
      if (primaryObj && designSizePt > 0) {
        const mtx = readMatrix(p, primaryObj); // [a b c d e f]
        const matD = Math.abs(mtx[3]);
        const rendered = designSizePt * (matD > 0.001 ? matD : 1);
        // Accept only plausible rendered sizes; fall back to bbox height otherwise.
        if (rendered >= 3 && rendered <= 500) fontSizePt = rendered;
      }

      // Subset fonts: base name has a 6-uppercase-letter prefix e.g. "ABCDEF+Arial"
      // (ISO 32000 §9.6.4 Table 122). They only carry glyphs already in the doc.
      const fontSubsetted = /^[A-Z]{6}\+/.test(name);
      return {
        index: g[0].index,
        indices: g.map((o) => o.index),
        text: groupText(g),
        left: Math.min(...g.map((o) => o.left)),
        bottom: Math.min(...g.map((o) => o.bottom)),
        right: Math.max(...g.map((o) => o.right)),
        top: Math.max(...g.map((o) => o.top)),
        editable: true,
        fontFamily: cssFontFamily(flags, name),
        fontSizePt,
        fontWeight,
        fontItalic: italic,
        color: `rgb(${cr}, ${cg}, ${cb})`,
        fontSubsetted,
        // Base family name with any subset tag stripped ("ABCDEF+Arial" → "Arial"),
        // used to match a bundled metric-compatible font (see textedit-fonts.ts).
        fontBaseName: name.replace(/^[A-Z]{6}\+/, ''),
      };
    });
  });
}

/* ── Font substitution ───────────────────────────────────────────────────────
   Embedded fonts are subsetted — they only carry the glyphs already used — so an
   edit that introduces a new character would render as .notdef. When that
   happens we swap the run to a standard PDF font (Helvetica / Times / Courier
   family, chosen by the original font's flags and name). Standard fonts are
   required by ISO 32000 §9.6.2 and built into every viewer; no external fetch
   or font data embedding is needed. The original object is emptied and a new
   object with the standard font is inserted (FPDFPage_RemoveObject crashes on
   these builds so we zero-out the original instead). */
// The standard-14 fonts render via WinAnsi/CP1252 encoding only. When we
// substitute a subset/embedded font with a standard one, any character outside
// this repertoire (CJK, Arabic, Hebrew, most symbols/box-drawing) can't be shown
// — PDFium encodes it as .notdef (tofu) or drops it, silently. These are the
// codepoints CP1252 CAN represent beyond Latin-1 (smart quotes, dashes, euro, …).
const WINANSI_HIGH = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);
/** First character of `text` that a standard-14 (WinAnsi) font can't render, or null. */
export function firstUnencodable(text: string): string | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const ok =
      cp === 0x09 || cp === 0x0a || cp === 0x0d ||
      (cp >= 0x20 && cp <= 0x7e) ||
      (cp >= 0xa0 && cp <= 0xff) ||
      WINANSI_HIGH.has(cp);
    if (!ok) return ch;
  }
  return null;
}
function pickStandardFont(flags: number, weight: number, name: string): string {
  const n = name.toLowerCase();
  const mono = (flags & FLAG_FIXED_PITCH) !== 0 || /courier|mono|consol/.test(n);
  const serif = !mono && ((flags & FLAG_SERIF) !== 0 || /times|serif|georgia|roman|garamond|minion/.test(n));
  const bold = weight >= 600 || /bold|black|heavy|semibold/.test(n);
  const italic = (flags & FLAG_ITALIC) !== 0 || /italic|oblique/.test(n);
  if (mono) return bold ? (italic ? 'Courier-BoldOblique' : 'Courier-Bold') : (italic ? 'Courier-Oblique' : 'Courier');
  if (serif) return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : (italic ? 'Times-Italic' : 'Times-Roman');
  return bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (italic ? 'Helvetica-Oblique' : 'Helvetica');
}
function readFontName(p: Pdfium, font: number): string {
  const m = p.pdfium;
  const buf = m._malloc(256);
  try {
    const len = p.FPDFFont_GetBaseFontName(font, buf, 256);
    let s = '';
    for (let i = 0; i < Math.min(Math.max(len - 1, 0), 255); i++) s += String.fromCharCode(m.HEAPU8[buf + i]);
    return s;
  } finally {
    m._free(buf);
  }
}
function readMatrix(p: Pdfium, obj: number): Float32Array {
  const buf = p.pdfium._malloc(24);
  try {
    p.FPDFPageObj_GetMatrix(obj, buf);
    return new Float32Array(p.pdfium.HEAPU8.buffer, buf, 6).slice();
  } finally {
    p.pdfium._free(buf);
  }
}
function setMatrix(p: Pdfium, obj: number, mtx: Float32Array): void {
  const buf = p.pdfium._malloc(24);
  try {
    new Float32Array(p.pdfium.HEAPU8.buffer, buf, 6).set(mtx);
    p.FPDFPageObj_SetMatrix(obj, buf);
  } finally {
    p.pdfium._free(buf);
  }
}
function readFontSize(p: Pdfium, obj: number): number {
  const buf = p.pdfium._malloc(4);
  try {
    p.FPDFTextObj_GetFontSize(obj, buf);
    return new Float32Array(p.pdfium.HEAPU8.buffer, buf, 1)[0];
  } finally {
    p.pdfium._free(buf);
  }
}
function readFillColor(p: Pdfium, obj: number): [number, number, number, number] {
  const m = p.pdfium;
  const buf = m._malloc(16);
  try {
    if (!p.FPDFPageObj_GetFillColor(obj, buf, buf + 4, buf + 8, buf + 12)) return [0, 0, 0, 255];
    const u = new Uint32Array(m.HEAPU8.buffer, buf, 4);
    return [u[0], u[1], u[2], u[3]];
  } finally {
    m._free(buf);
  }
}

/** Replace the logical text run starting at `objectIndex` on `pageIndex` with
 *  `newText`; returns updated document bytes and a flag indicating whether the
 *  engine fell back to a standard PDF font.
 *
 *  `objectIndices` lists all PDFium object indices grouped into this run
 *  (secondary objects are zeroed out after the primary is edited).
 *
 *  Font strategy (fail-closed):
 *  - No new glyphs AND font is non-subsetted → keep original font (safe).
 *  - Any new glyph OR font has a subset tag (ISO 32000 §9.6.4 "ABCDEF+Name")
 *    → substitute Helvetica/Times/Courier (standard fonts: every viewer has
 *    them, no embedding required). Subsetted fonts are treated as unreliable
 *    even for same-char edits because their glyph-id encoding may not match
 *    the Unicode PDFium returns via FPDFTextObj_GetText. */
export async function editTextRun(
  src: Uint8Array,
  pageIndex: number,
  objectIndex: number,
  objectIndices: number[],
  newText: string,
): Promise<{ bytes: Uint8Array; substituted: boolean; residual: boolean }> {
  try {
    return await withPage(src, pageIndex, (p, doc, page, textPage) => {
      const m = p.pdfium;
      const obj = p.FPDFPage_GetObject(page, objectIndex);
      if (!obj || p.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) throw new Error('Selected object is not editable text.');
      const origText = readObjText(p, textPage, obj);
      // A logical run can span multiple text objects (objectIndices). Compare the
      // new text against the WHOLE run's characters, not just the primary object,
      // so a char that already exists elsewhere in the run isn't flagged "new" and
      // needlessly forces a standard-font substitution (fidelity loss).
      const runText =
        objectIndices.length > 1
          ? objectIndices
              .map((oi) => {
                const o = p.FPDFPage_GetObject(page, oi);
                return o && p.FPDFPageObj_GetType(o) === FPDF_PAGEOBJ_TEXT ? readObjText(p, textPage, o) : '';
              })
              .join('')
          : origText;
      const newChars = [...newText].filter((c) => !runText.includes(c));

      const font = p.FPDFTextObj_GetFont(obj);
      const flags = font ? p.FPDFFont_GetFlags(font) : 0;
      const weight = font ? p.FPDFFont_GetWeight(font) : 400;
      const name = font ? readFontName(p, font) : '';
      // Subsetted font: base name starts with 6 uppercase letters + "+" per
      // ISO 32000 §9.6.4. Even for same-char edits, glyph-id mapping is
      // unreliable → always substitute a standard font.
      const isSubset = /^[A-Z]{6}\+/.test(name);
      const needsSubstitution = newChars.length > 0 || isSubset;

      // Fail closed BEFORE mutating: if we'll substitute a standard font but the
      // new text contains a character WinAnsi can't encode, PDFium would silently
      // render tofu / drop it yet still report success. Refuse instead — nothing
      // is saved (we throw before saveDoc), so the document is unchanged. (Pure
      // deletion doesn't add characters, so it's exempt.)
      if (needsSubstitution && newText.length > 0) {
        const bad = firstUnencodable(newText);
        if (bad) {
          throw new Error(
            `"${bad}" can't be shown in a substitute font, and the original font is embedded as a subset (its glyphs can't be extended here). The edit was not applied.`,
          );
        }
      }

      // True if any object was hidden by moving it off-page rather than truly
      // cleared — its original glyphs remain in the output bytes (the space-clear
      // path removes them; the off-page fallback does not). Surfaced so the UI can
      // warn that text edit is NOT a secure removal tool — use Redaction for that.
      let residual = false;

      // Suppress an object by replacing its text with a single space.
      // FPDFText_SetText("") aborts in the WASM build; a space is invisible but
      // keeps the object valid in the content stream.
      // For subsetted fonts the space glyph is often absent → SetText returns
      // false. Fallback: move the object far off-page so it never appears in
      // listTextRuns (filtered by the `left < -1000` guard) and isn't rendered.
      const moveOffPage = (o: number) => {
        residual = true;
        const mtx = readMatrix(p, o);
        mtx[4] = -99999; // x translation
        mtx[5] = -99999; // y translation
        setMatrix(p, o, mtx);
      };
      const suppressObj = (o: number) => {
        if (!o || p.FPDFPageObj_GetType(o) !== FPDF_PAGEOBJ_TEXT) return;
        const sp = allocUtf16(p, ' ');
        const ok = p.FPDFText_SetText(o, sp);
        m._free(sp);
        if (!ok) moveOffPage(o);
      };
      const suppress = (idx: number) => {
        if (idx === objectIndex) return;
        const o = p.FPDFPage_GetObject(page, idx);
        if (!o || p.FPDFPageObj_GetType(o) !== FPDF_PAGEOBJ_TEXT) return;
        suppressObj(o);
      };

      // Zero out every secondary object in the group first so no ghost text
      // from per-character objects lingers after the primary is replaced.
      for (const idx of objectIndices) suppress(idx);

      if (newText.length === 0) {
        // Deleting all text in the run: suppress the primary too. Calling
        // FPDFText_SetText("") is not reliable in this WASM build.
        suppressObj(obj);
      } else if (!needsSubstitution) {
        // Keep original font — all chars already present and font is not subsetted.
        const wide = allocUtf16(p, newText);
        try {
          if (!p.FPDFText_SetText(obj, wide)) throw new Error('FPDFText_SetText failed.');
        } finally {
          m._free(wide);
        }
      } else {
        // Substitute a standard PDF font so all characters render correctly
        // (ISO 32000 §9.6.2 — every conforming viewer includes the 14 standard fonts).
        const size = readFontSize(p, obj) || 12;
        const matrix = readMatrix(p, obj);
        const color = readFillColor(p, obj);
        const stdFontName = pickStandardFont(flags, weight, name);
        const subFont = p.FPDFText_LoadStandardFont(doc, stdFontName);
        if (!subFont) throw new Error(`Could not load standard font "${stdFontName}".`);
        // Blank the primary (secondaries already suppressed above).
        // Same fallback as suppress(): move off-page if space glyph is absent.
        const space = allocUtf16(p, ' ');
        const primaryOk = p.FPDFText_SetText(obj, space);
        m._free(space);
        if (!primaryOk) moveOffPage(obj);
        // `matrix` was captured before this — newObj is still placed correctly.
        const newObj = p.FPDFPageObj_CreateTextObj(doc, subFont, size);
        const wide = allocUtf16(p, newText);
        try {
          // Check the result (was ignored) — with the encodability guard above a
          // false here means a genuine engine failure, not a silent bad glyph.
          if (!p.FPDFText_SetText(newObj, wide)) throw new Error('Could not set the substituted text.');
        } finally {
          m._free(wide);
        }
        setMatrix(p, newObj, matrix);
        p.FPDFPageObj_SetFillColor(newObj, color[0], color[1], color[2], color[3]);
        p.FPDFPage_InsertObject(page, newObj);
      }

      if (!p.FPDFPage_GenerateContent(page)) throw new Error('FPDFPage_GenerateContent failed.');
      return { bytes: saveDoc(p, doc), substituted: needsSubstitution, residual };
    });
  } catch (e) {
    // If the WASM module aborted, its heap is unknown — reset the singleton so
    // the next call gets a fresh instance. Document unchanged (error propagates).
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'unreachable' || e instanceof WebAssembly.RuntimeError) {
      modulePromise = null;
      throw new Error('A PDFium internal error occurred — the document is unchanged. Try again.');
    }
    throw e;
  }
}

/** Spike/diagnostic: replace every occurrence of `find` with `replace` in the
 *  text objects on `pageIndex`. Mirrors the native edit_text example so the web
 *  path can be verified the same way. */
export async function replaceTextOnPage(src: Uint8Array, pageIndex: number, find: string, replace: string): Promise<Uint8Array> {
  return withPage(src, pageIndex, (p, doc, page, textPage) => {
    let edited = 0;
    const n = p.FPDFPage_CountObjects(page);
    for (let i = 0; i < n; i++) {
      const obj = p.FPDFPage_GetObject(page, i);
      if (p.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) continue;
      const cur = readObjText(p, textPage, obj);
      if (!cur.includes(find)) continue;
      const wide = allocUtf16(p, cur.split(find).join(replace));
      try {
        p.FPDFText_SetText(obj, wide);
        edited++;
      } finally {
        p.pdfium._free(wide);
      }
    }
    if (edited > 0 && !p.FPDFPage_GenerateContent(page)) throw new Error('FPDFPage_GenerateContent failed.');
    return saveDoc(p, doc);
  });
}

/** A redaction region in PDF user space (bottom-left origin, points). */
export interface RedactUserRect {
  pageIndex: number;
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/**
 * SURGICAL text redaction (user decision 2026-07-06): remove the text objects
 * that fall within the marked regions from the page content stream, keeping the
 * rest of the page as real, selectable text. PDFium rebuilds the content stream
 * (FPDFPage_GenerateContent) and saves NON-INCREMENTAL, so cleared text is gone
 * from the output bytes — NOT hidden.
 *
 * Caveat handled by the caller via verification + fallback: on subsetted fonts
 * `FPDFText_SetText(' ')` can fail; we then move the object off-page (its glyphs
 * REMAIN in the bytes) and flag that page in `residualPages`. The caller must
 * treat a residual page as NOT securely redacted and fall back to flattening it.
 * Object-level granularity: a text object overlapping a region is removed whole.
 */
export async function redactTextInRegion(
  src: Uint8Array,
  rects: RedactUserRect[],
): Promise<{ bytes: Uint8Array; residualPages: number[]; suppressed: number; removedBounds: RedactUserRect[] }> {
  const p = await ensurePdfium();
  const m = p.pdfium;
  const srcPtr = m._malloc(src.length);
  m.HEAPU8.set(src, srcPtr);
  const doc = p.FPDF_LoadMemDocument(srcPtr, src.length, '');
  if (!doc) {
    m._free(srcPtr);
    throw new Error('Could not open the document for redaction.');
  }
  const residual = new Set<number>();
  const removedBounds: RedactUserRect[] = [];
  let suppressed = 0;
  const byPage = new Map<number, RedactUserRect[]>();
  for (const r of rects) {
    const a = byPage.get(r.pageIndex);
    if (a) a.push(r);
    else byPage.set(r.pageIndex, [r]);
  }
  const fl = m._malloc(16);
  try {
    for (const [pi, prs] of byPage) {
      const page = p.FPDF_LoadPage(doc, pi);
      if (!page) continue;
      try {
        const n = p.FPDFPage_CountObjects(page);
        for (let i = 0; i < n; i++) {
          const obj = p.FPDFPage_GetObject(page, i);
          if (!obj || p.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) continue;
          if (!p.FPDFPageObj_GetBounds(obj, fl, fl + 4, fl + 8, fl + 12)) continue;
          const f = new Float32Array(m.HEAPU8.buffer, fl, 4);
          const [ol, ob, or_, ot] = [f[0], f[1], f[2], f[3]];
          // Overlap the object bbox with any region rect (both PDF user space).
          if (!prs.some((r) => ol < r.right && or_ > r.left && ob < r.top && ot > r.bottom)) continue;
          suppressed += 1;
          // Record the removed object's bounds so the caller can box the ACTUAL
          // removed text (often a whole line), not just the marked sub-region —
          // otherwise removed neighbours would vanish with no black box over them.
          removedBounds.push({ pageIndex: pi, left: ol, bottom: ob, right: or_, top: ot });
          const sp = allocUtf16(p, ' ');
          const ok = p.FPDFText_SetText(obj, sp);
          m._free(sp);
          if (!ok) {
            // Space-clear failed (subsetted font) → hide off-page, but the glyphs
            // stay in the bytes: mark this page residual so the caller flattens it.
            const mtx = readMatrix(p, obj);
            mtx[4] = -99999;
            mtx[5] = -99999;
            setMatrix(p, obj, mtx);
            residual.add(pi);
          }
        }
        p.FPDFPage_GenerateContent(page);
      } finally {
        p.FPDF_ClosePage(page);
      }
    }
    const bytes = saveDoc(p, doc);
    return { bytes, residualPages: [...residual], suppressed, removedBounds };
  } finally {
    m._free(fl);
    p.FPDF_CloseDocument(doc);
    m._free(srcPtr);
  }
}
