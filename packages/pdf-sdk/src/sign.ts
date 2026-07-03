// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Certified PDF signing via the Rust core (casual-pdf-core, wasm).
 *
 * The browser asks the wasm signer to build a detached CMS / PKCS#7 signature
 * and append it as an incremental PDF update. This keeps the original bytes
 * intact and produces a real signed file that external tools can verify.
 */
import { initSync, sign_pdf_wasm } from './wasm/casual_pdf_core.js';
import wasmUrl from './wasm/casual_pdf_core_bg.wasm?url';

let ready: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const wasmBinary = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
      initSync(wasmBinary);
    })();
  }
  return ready;
}

export interface SignPdfOptions {
  pdf: Uint8Array;
  signerName?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
}

/** Sign a PDF and return the signed bytes. */
export async function signPdf({
  pdf,
  signerName = 'Casual PDF Signer',
  reason = 'Signed in Casual PDF',
  location,
  contactInfo,
}: SignPdfOptions): Promise<Uint8Array> {
  await ensureInit();
  return sign_pdf_wasm(pdf, signerName, reason, location ?? null, contactInfo ?? null);
}
