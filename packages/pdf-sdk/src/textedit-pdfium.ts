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
import { init, DEFAULT_PDFIUM_WASM_URL } from '@embedpdf/pdfium';

const FPDF_PAGEOBJ_TEXT = 1;
// Full rewrite (not FPDF_INCREMENTAL): the edited text replaces the original in
// the output rather than appending a superseding update, so the old text isn't
// left buried in the bytes (matches the native save_to_bytes() behaviour).
const FPDF_NO_INCREMENTAL = 2;

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
    modulePromise = (async () => {
      const wasmBinary = new Uint8Array(await (await fetch(DEFAULT_PDFIUM_WASM_URL)).arrayBuffer());
      const wrapped = (await init({ wasmBinary } as Parameters<typeof init>[0])) as unknown as Pdfium;
      wrapped.PDFiumExt_Init();
      return wrapped;
    })();
  }
  return modulePromise;
}

/** Read a text object's current text (UTF-16LE) via a text page. */
function readObjText(p: Pdfium, textPage: number, obj: number): string {
  const m = p.pdfium;
  const need = p.FPDFTextObj_GetText(obj, textPage, 0, 0); // count incl. terminator
  if (need <= 0) return '';
  const buf = m._malloc(need * 2);
  try {
    p.FPDFTextObj_GetText(obj, textPage, buf, need);
    const u16 = new Uint16Array(m.HEAPU8.buffer, buf, need);
    let s = '';
    for (let i = 0; i < need - 1; i++) s += String.fromCharCode(u16[i]);
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
  fn: (p: Pdfium, doc: number, page: number, textPage: number) => T,
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
    return fn(p, doc, page, textPage);
  } finally {
    if (textPage) p.FPDFText_ClosePage(textPage);
    if (page) p.FPDF_ClosePage(page);
    p.FPDF_CloseDocument(doc);
    m._free(srcPtr); // FPDF_LoadMemDocument keeps a reference until close
  }
}

/** A text run on a page (one text object), for hit-testing + the edit overlay. */
export interface PdfTextRun {
  /** Index of the object on the page (target for an edit). */
  index: number;
  text: string;
  /** Bounds in PDF user space (left, bottom, right, top). */
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/** List the editable text runs (text objects) on a page. */
export async function listTextRuns(src: Uint8Array, pageIndex: number): Promise<PdfTextRun[]> {
  return withPage(src, pageIndex, (p, _doc, page, textPage) => {
    const m = p.pdfium;
    const runs: PdfTextRun[] = [];
    const n = p.FPDFPage_CountObjects(page);
    for (let i = 0; i < n; i++) {
      const obj = p.FPDFPage_GetObject(page, i);
      if (p.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) continue;
      const text = readObjText(p, textPage, obj);
      if (!text) continue;
      const fl = m._malloc(16); // 4 × float out-params
      p.FPDFPageObj_GetBounds(obj, fl, fl + 4, fl + 8, fl + 12);
      const f = new Float32Array(m.HEAPU8.buffer, fl, 4);
      const [left, bottom, right, top] = [f[0], f[1], f[2], f[3]];
      m._free(fl);
      runs.push({ index: i, text, left, bottom, right, top });
    }
    return runs;
  });
}

/** Replace text object `objectIndex` on `pageIndex` with `newText`; new bytes. */
export async function editTextRun(src: Uint8Array, pageIndex: number, objectIndex: number, newText: string): Promise<Uint8Array> {
  return withPage(src, pageIndex, (p, doc, page) => {
    const obj = p.FPDFPage_GetObject(page, objectIndex);
    if (!obj || p.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) throw new Error('Selected object is not editable text.');
    const wide = allocUtf16(p, newText);
    try {
      if (!p.FPDFText_SetText(obj, wide)) throw new Error('FPDFText_SetText failed.');
    } finally {
      p.pdfium._free(wide);
    }
    if (!p.FPDFPage_GenerateContent(page)) throw new Error('FPDFPage_GenerateContent failed.');
    return saveDoc(p, doc);
  });
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
