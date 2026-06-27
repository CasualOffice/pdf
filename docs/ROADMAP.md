# Roadmap

Phased build, reuse-first. Each phase lists scope, what it reuses, and the **ship gates** (from `BENCHMARK.md`) it must clear. Phases are sequenced so each produces something usable.

---

## Phase 0 — Scaffold & spike (foundation)
**Goal:** prove the engine + the reuse points before committing to UX.
- [x] Scaffold repo (mirror `document`/`sheet`): `apps/web` (Vite+React+TS), `packages/pdf-sdk`, `crates/casual-pdf-core`, `CLAUDE.md`, pnpm workspace + root Cargo workspace.
- [x] EmbedPDF wired in React (PDFium-WASM viewer: render/scroll plugins) — renders live at pdf.casualoffice.org; first page paints (verified headless), multi-page virtualized scroll works. *Zoom/text-search land in Phase 1.*
- [x] `casual-pdf-core`: PDFium via `pdfium-render` (native render + page-count) compiling to **both** `wasm32` + native — one crate, two targets, confirmed by `cargo build`/check on each.
- [x] Wire `@schnsrw/design-system` (tokens + `Button`) — `vendor/` submodule + `link:` override; App toolbar uses it.
- [x] **UX-F1** web-vs-native render-diff harness stood up (`tools/render-parity/`) + CI job — web (PDFium-WASM) vs native (pdfium-render) on a fixture page **diff 0.217%**, well under the 2% threshold (residual is glyph-edge antialiasing only).
**Gates:** UX-P1, UX-P2 (basic) ✅ (render + scroll); **UX-F1 ✅ passing**. Zoom/search → Phase 1.

## Phase 1 — Production viewer
**Goal:** a viewer that beats OSS baselines on polish.
- Virtualized rendering, fit modes, rotate, thumbnails, outline/bookmarks, search+selection, continuous & page modes.
- Toolbar + responsive layout via design-system; light/dark.
- Desktop integration MVP: add `DocKind::Pdf` to shell, `desk-bridge-bootstrap`, open `.pdf` from disk, native print-to-PDF export.
**Reuse:** EmbedPDF, design-system, desktop shell.
**Gates:** UX-P1..P5, UX-I2, UX-I6, UX-F1, UX-F3.

## Phase 2 — Annotation editor (single-user)
**Goal:** Tier-1 editing, Apryse-class feel.
- Annotations: highlight, ink, note, shapes, text, stamp; contextual property bar; direct manipulation (drag/resize/rotate/snap/multi-select); undo/redo.
- Form fill (AcroForm) + flatten.
- Write-side: bake annotations/forms into binary via `pdf-lib` (incremental update); autosave + desktop recovery.
- Define the **Yjs document model** (even single-user, so collab drops in cleanly).
**Reuse:** pdf-lib, desktop recovery/save.
**Gates:** UX-I1..I5, UX-P4, UX-F2.

## Phase 3 — Co-editing, comments, public links
**Goal:** the differentiator.
- Bind Y.Doc to `services/collab` (`HocuspocusProvider`); presence (cursors/avatars/selection).
- Threaded comments anchored to regions; resolve; @-mention.
- Public share links with roles `{viewer, commenter, editor, signer}`, **server-side enforced** (read-only Yjs for view/comment).
- Store base PDF as immutable versions in collab host (`CASUAL_FILE_EXT=.pdf`).
**Reuse:** `services/collab` end-to-end.
**Gates:** UX-C1..C4, UX-S4.

## Phase 4 — Signing & rights
**Goal:** production-grade signing.
- E-signature (draw/type/upload → flatten).
- Certified digital signature (PKCS#7) via `@signpdf/signpdf` + `node-forge` (web) / native Rust path (desktop); visible appearance; verify on read.
- Signing workflows: request-to-sign, signing order, audit trail (Yjs `signing` map + collab tokens).
- PDF-level permissions/encryption (`lopdf`/`pdfium-render`).
**Reuse:** collab tokens/rooms for per-signer links + audit.
**Gates:** UX-S1..S5 (incl. validates in Acrobat; redaction truly removes).

## Phase 5 — Heavy ops & page management
**Goal:** full document manipulation, off-thread.
- Page manager: reorder/rotate/insert/delete/merge/split/extract via `casual-pdf-core` worker (web) / native (desktop).
- **True redaction** (byte-level removal) in the Rust core.
- Watermark/header/footer/Bates; thumbnail generation.
**Reuse:** the Rust core from Phase 0, now load-bearing.
**Gates:** UX-S5, UX-P5, UX-F2.

## Phase 6 — Polish, embed, hardening
**Goal:** ship quality.
- Publish `@casualoffice/pdf` SDK with subpath exports (`/viewer`, `/collab`, `/embed`) — embed in `drive`/`site`. Before publishing: emit a real `dist` (e.g. tsup) and move `yjs` + `@hocuspocus/provider` to `peerDependencies` (optional) so a host embedding the SDK can't end up with a duplicate Yjs (CRDT identity breaks). Phase 0 keeps them as direct deps since the SDK is consumed as workspace source.
- Performance budgets in CI; screenshot-diff (UX-F1); Acrobat-validation fixture (UX-S2); text-extract redaction test (UX-S5).
- Accessibility, keyboard map, i18n, error/empty states.
**Gates:** all UX-* gates green in CI.

---

## Stretch (post-v1)
- **Tier 2** true body-text editing + reflow (scoped).
- OCR (Tesseract-WASM in the core).
- PDF/A & PDF/UA compliance.
- AI assist (summarize/extract/ask) over the text layer via Claude API.

---

## Sequencing rationale
- **Viewer first** — fidelity + perf is the foundation everything paints on.
- **Single-user editing before collab** — get interaction/UX right, then make it multiplayer (the Y.Doc model is defined in Phase 2 so Phase 3 is a binding, not a rewrite).
- **Signing after collab** — signing workflows lean on the same rooms/tokens/links.
- **Heavy Rust ops can parallelize** — the crate exists from Phase 0; redaction/merge land when UX needs them, and the desktop native path comes "for free" since it's the same crate.

## First concrete steps (Phase 0 checklist)
1. `pnpm` workspace + `apps/web` Vite React TS app; copy `CLAUDE.md` conventions from `services/document`.
2. EmbedPDF render spike in `apps/web`.
3. `crates/casual-pdf-core` with `pdfium-render`; build native + `wasm-pack`; render one tile each side; stand up the screenshot-diff harness (UX-F1).
4. Add `DocKind::Pdf` + `/pdf/index.html` mount in `services/desktop` shell; open a `.pdf`.
5. Confirm design-system tokens render; lock the toolbar layout.
