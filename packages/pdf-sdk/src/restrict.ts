// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF permission restriction via the Rust core (casual-pdf-core → wasm), using
 * AES-256 encryption with an EMPTY open password and an owner password that gates
 * the permission flags (print / copy / modify / annotate).
 *
 * IMPORTANT — this restricts *actions*, not *access*: the file opens without a
 * prompt, and the permission flags are honored by *compliant* readers (Acrobat,
 * Preview, Chrome) — a non-compliant tool can ignore them. Because there's no open
 * password, the content is not confidential. (Decision #4: lopdf/AES-256 are
 * in-policy.) The wasm is lazy-loaded on first use.
 */
import init, { restrict_pdf_wasm } from './wasm/casual_pdf_core.js';
import wasmUrl from './wasm/casual_pdf_core_bg.wasm?url';

let ready: Promise<unknown> | null = null;
function ensureInit(): Promise<unknown> {
  if (!ready) ready = init({ module_or_path: wasmUrl });
  return ready;
}

/** Which actions the restricted PDF permits. Anything omitted/false is denied. */
export interface RestrictPermissions {
  print?: boolean;
  copy?: boolean;
  modify?: boolean;
  annotate?: boolean;
}

/**
 * Restrict `pdf`'s permissions. `ownerPassword` is required (it gates changing the
 * permissions). Returns the AES-256-encrypted PDF bytes. Throws if the document is
 * already encrypted or the owner password is empty.
 */
export async function restrictPdf(
  pdf: Uint8Array,
  ownerPassword: string,
  allow: RestrictPermissions,
): Promise<Uint8Array> {
  if (!ownerPassword) throw new Error('An owner password is required to restrict permissions.');
  await ensureInit();
  const perms =
    (allow.print ? 1 : 0) | (allow.copy ? 2 : 0) | (allow.modify ? 4 : 0) | (allow.annotate ? 8 : 0);
  return restrict_pdf_wasm(pdf, ownerPassword, perms);
}
