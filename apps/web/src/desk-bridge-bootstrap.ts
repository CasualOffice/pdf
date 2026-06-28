// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * deskApp host bridge — Casual PDF edition.
 *
 * Desktop mode is opt-in and default-OFF: it activates only when the page is
 * loaded with `?desk=1`, which the Casual Office Tauri shell appends when it
 * spawns the PDF window (mounted at `/pdf/index.html`). In a plain browser the
 * flag is absent, `isDesktop()` is false, and this module is a no-op.
 *
 * Phase 0 establishes detection only. File I/O (chunked atomic save, crash
 * recovery), native PDFium heavy-ops, and print-to-PDF are wired to Tauri
 * `invoke()` in Phase 1, mirroring services/desktop's docx/sheets bridges.
 */

/** True only inside the Casual Office desktop shell (signalled by `?desk=1`). */
export function isDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URL(window.location.href).searchParams.get('desk') === '1';
  } catch {
    return false;
  }
}
