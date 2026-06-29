// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Tier-2 text editing via the Rust core (casual-pdf-core, wasm).
 *
 * `listTextRuns` enumerates a page's editable text runs (position/size/colour
 * for an edit overlay); `editTextRun` replaces a run's string; `moveTextRun`
 * shifts a run. All operate on PDF bytes and return new bytes — no reflow
 * (neighbours stay put), matching the honest scope in docs/ARCHITECTURE.md §2.
 */
import init, {
  list_text_runs_wasm,
  edit_text_run_wasm,
  move_text_run_wasm,
} from './wasm/casual_pdf_core.js';
import wasmUrl from './wasm/casual_pdf_core_bg.wasm?url';

let ready: Promise<unknown> | null = null;
function ensureInit(): Promise<unknown> {
  if (!ready) ready = init({ module_or_path: wasmUrl });
  return ready;
}

export interface TextRun {
  /** Stable index of the run on the page (target for edit/move). */
  id: number;
  text: string;
  /** Baseline origin in PDF user space (bottom-left origin). */
  x: number;
  y: number;
  /** Approximate rendered size in user space (overlay hint). */
  width: number;
  height: number;
  fontSize: number;
  /** Fill colour RGB 0..1. */
  color: [number, number, number];
}

/** Editable text runs on `pageIndex` (0-based). */
export async function listTextRuns(pdf: Uint8Array, pageIndex: number): Promise<TextRun[]> {
  await ensureInit();
  return JSON.parse(list_text_runs_wasm(pdf, pageIndex)) as TextRun[];
}

/** Replace run `runId`'s text; returns new PDF bytes. */
export async function editTextRun(pdf: Uint8Array, pageIndex: number, runId: number, newText: string): Promise<Uint8Array> {
  await ensureInit();
  return edit_text_run_wasm(pdf, pageIndex, runId, newText);
}

/** Move run `runId` by (dx, dy) in user space; returns new PDF bytes. */
export async function moveTextRun(pdf: Uint8Array, pageIndex: number, runId: number, dx: number, dy: number): Promise<Uint8Array> {
  await ensureInit();
  return move_text_run_wasm(pdf, pageIndex, runId, dx, dy);
}
