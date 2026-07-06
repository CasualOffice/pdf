// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Surgical redaction via the Rust core (casual-pdf-core, compiled to wasm).
 *
 * Unlike the rasterize-and-flatten path (`./redact`), this removes only the
 * glyphs inside each mark at the byte level, so the rest of the page's text
 * stays selectable and searchable (gate UX-S5, the "real" version). The wasm
 * (~250 KB gz) is lazy-loaded the first time a redaction is applied.
 *
 * Marks are the SDK's native fractional top-left rects; the Rust side converts
 * them to user space per page using the MediaBox.
 */
import init, { redact_pdf_wasm } from './wasm/casual_pdf_core.js';
import wasmUrl from './wasm/casual_pdf_core_bg.wasm?url';

let ready: Promise<unknown> | null = null;
function ensureInit(): Promise<unknown> {
  if (!ready) ready = init({ module_or_path: wasmUrl });
  return ready;
}

export interface SurgicalMark {
  pageIndex: number;
  /** Fractional, top-left page coordinates (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pack marks into the flat `Float64Array` the wasm entry point expects:
 *  `[ nPages, (pageIndex, nRects, x,y,w,h × nRects) × nPages ]`. */
function packSpec(marks: SurgicalMark[]): Float64Array {
  const byPage = new Map<number, SurgicalMark[]>();
  for (const m of marks) {
    const arr = byPage.get(m.pageIndex);
    if (arr) arr.push(m);
    else byPage.set(m.pageIndex, [m]);
  }
  const spec: number[] = [byPage.size];
  for (const [pageIndex, rs] of byPage) {
    spec.push(pageIndex, rs.length);
    for (const r of rs) spec.push(r.x, r.y, r.w, r.h);
  }
  return new Float64Array(spec);
}

export interface SurgicalResult {
  /** New PDF bytes: text under the marks removed, surrounding text preserved. */
  bytes: Uint8Array;
  /** 0-based pages the core could NOT redact confidently (a font/CMap it can't
   *  decode, or a Form XObject it doesn't descend into) — the caller should
   *  flatten these so nothing is left behind. */
  lowConfidencePages: number[];
}

/** Surgically redact. Throws if the core can't process the document at all —
 *  callers should fall back to the flatten path so a redaction never silently
 *  no-ops. */
export async function redactSurgical(pdf: Uint8Array, marks: SurgicalMark[]): Promise<SurgicalResult> {
  await ensureInit();
  const r = redact_pdf_wasm(pdf, packSpec(marks));
  const result = { bytes: r.bytes, lowConfidencePages: Array.from(r.low_confidence_pages) };
  r.free();
  return result;
}
