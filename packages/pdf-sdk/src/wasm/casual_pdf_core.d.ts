/* tslint:disable */
/* eslint-disable */

/**
 * Build identifier — proves the same crate compiles to wasm32. The PDFium
 * render path (mirroring the native module) is wired through a wasm PDFium
 * build in Phase 0.5.
 */
export function core_version(): string;

/**
 * Replace run `run_id`'s text on `page_index`; returns new PDF bytes.
 */
export function edit_text_run_wasm(pdf: Uint8Array, page_index: number, run_id: number, new_text: string): Uint8Array;

/**
 * JSON array of the editable text runs on `page_index` (for the edit overlay).
 */
export function list_text_runs_wasm(pdf: Uint8Array, page_index: number): string;

/**
 * Move run `run_id` by (dx, dy) in user space; returns new PDF bytes.
 */
export function move_text_run_wasm(pdf: Uint8Array, page_index: number, run_id: number, dx: number, dy: number): Uint8Array;

/**
 * Surgically redact `pdf` (true byte removal, surrounding text preserved),
 * returning the new PDF bytes. `spec` is the flat array from `parse_spec`.
 */
export function redact_pdf_wasm(pdf: Uint8Array, spec: Float64Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly core_version: () => [number, number];
    readonly edit_text_run_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly list_text_runs_wasm: (a: number, b: number, c: number) => [number, number, number, number];
    readonly move_text_run_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly redact_pdf_wasm: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
