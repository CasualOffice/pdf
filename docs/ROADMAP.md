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

## Phase 1 — Production viewer (in progress)
**Goal:** a viewer that beats OSS baselines on polish.
- [x] Virtualized rendering (EmbedPDF scroll + tiling), fit modes (fit-width/fit-page), zoom (+ a 50–400% preset menu on the level indicator), rotate, page nav, two-page spread, pan, fullscreen, thumbnails, text search + highlights, text selection — all wired via EmbedPDF plugins in `packages/pdf-sdk` and driven by a floating toolbar (`src/ui/chrome.tsx`).
- [x] **Professional editor layout** (current; superseded an earlier Google-Docs-style attempt per user direction 2026-06-28): slim top bar (hamburger menu + logo + editable title + **View/Suggest/Edit segmented control** + theme + avatar), **labelled left tool rail**, **contextual right properties panel**, max canvas (grey well + white page cards), **floating bottom view-bar**, top-center find. Design-system tokens; light/dark; SVG icons (filled = active) + WCAG 2.2 (accessible names at all widths, `aria-pressed`/`menuitemradio`, visible focus, ≥36px targets, contrast pass). Brand **logo + favicon** (`apps/web/public/`).
- [x] **Open / Download / Print** via the hamburger menu (file picker → object URL; Download bakes annotations via the export plugin; ⌘O/⌘S). Web open/save story; desktop file I/O comes via Tauri.
- [x] **Outline/bookmarks panel** (`@embedpdf/plugin-bookmark` → `getBookmarks` → tree; click navigates; verified against a bookmarked fixture). One left panel at a time (thumbnails ↔ outline).
- [x] Scroll-direction toggle (vertical ↔ horizontal, `setScrollStrategy`). *(Note: EmbedPDF's scroll plugin offers vertical/horizontal, not a single-page snap mode.)*
- [ ] Desktop integration MVP: add `DocKind::Pdf` to shell, `desk-bridge-bootstrap`, open `.pdf` from disk, native print-to-PDF export. *(Lives in the separate `services/desktop` repo.)*
**Reuse:** EmbedPDF, design-system, desktop shell.
**Gates:** UX-P1..P5, UX-I2, UX-I6, UX-F1, UX-F3. *(UX-F1 ✅ kept green; UX-P/I verified by headless drive: 4-page nav, zoom→140%, search 19 matches, thumbnails, light/dark.)*

## Phase 2 — Annotation editor (single-user) (in progress)
**Goal:** Tier-1 editing, Apryse-class feel.
- [x] Annotations via `@embedpdf/plugin-annotation`: highlight, ink/draw, free-text, note/comment, rectangle, ellipse, arrow — tool palette in the toolbar (Edit/Suggest modes only), plus the **Insert** menu. Direct manipulation (select/resize/rotate) and selection handles come from the plugin. **undo/redo** via `@embedpdf/plugin-history` (toolbar + Edit menu). Each page wraps layers in `PagePointerProvider`; the SDK exposes an imperative `CasualPdfApi` (download/undo/redo/deleteSelection/setTool) on `apiRef` for host menus.
- [x] Write-side **save** via `@embedpdf/plugin-export` (`download`/`saveAsCopy`) — File → Download now bakes annotations into the PDF bytes.
- [x] Contextual **property bar** (color swatches + stroke width) — appears when a tool is active or annotation(s) selected; applies via `setToolDefaults` (active tool) / `updateAnnotations` (selection).
- [x] Property panel: color + stroke width + **opacity**. (Font size done. Stamp/image, multi-select marquee + snap still to come.)
- [x] Editing UX: labelled tool rail + contextual properties panel; keyboard shortcuts (V/H/D/T/N/R/O/A, Esc, Delete, ⌘D duplicate, ⌘C/⌘V copy-paste, ⌘A select-all, ⌘Z / ⌘⇧Z undo-redo, arrow-key nudge of the selection — ⇧ for a 10pt step). Duplicate/paste place an offset copy (fresh id, own history entry); ⌘A enables bulk move/style/delete on the whole selection; crosshair cursor with a tool active; in-place free-text editing; move/resize/rotate handles; auto-revert to Select after placing a one-shot shape; text selection/copy in all modes; full screen = clean presentation view; Ctrl/⌘+wheel & pinch zoom.
- [x] Form fill (AcroForm) + flatten.
- [x] **Multi-select marquee** (UX-I3) — rubber-band drag selects enclosed annotations (`MarqueeSelect`); yields to text selection on glyph-start. *(Snap-to-align during move stays a later polish item — EmbedPDF owns the drag.)*
- [x] **Autosave + crash recovery** (UX-I5) — web app snapshots exported bytes to IndexedDB on a debounce; reload offers Restore/Discard (`apps/web/src/recovery.ts`). The **Yjs document model** is *defined* (`model.ts`); the source-of-truth *binding* is deferred to Phase 3 (collab, deprioritized). Desktop recovery rides the Tauri sidecar (separate repo).
**Reuse:** EmbedPDF annotation/history/export, pdf-lib (later), desktop recovery/save.
**Gates:** UX-I1..I5, UX-P4, UX-F2.

## Phase 3 — Co-editing, comments, public links
**Goal:** the differentiator.
- Bind Y.Doc to `services/collab` (`HocuspocusProvider`); presence (cursors/avatars/selection).
- [~] Threaded comments anchored to regions; resolve; @-mention. **Panel + model shipped (2026-07-08):** page-anchored threads, replies, resolve/reopen, @-mentions; syncs over the shared Yjs doc (collab) or a local doc (solo). Text-selection anchoring shipped (2026-07-08): select text → Comment → the thread anchors to that region (chip in the compose box). On-page comment markers (visualising the anchor) are the remaining polish.
- Public share links with roles `{viewer, commenter, editor, signer}`, **server-side enforced** (read-only Yjs for view/comment).
- Store base PDF as immutable versions in collab host (`CASUAL_FILE_EXT=.pdf`).
**Reuse:** `services/collab` end-to-end.
**Gates:** UX-C1..C4, UX-S4.

## Phase 4 — Signing & rights
**Goal:** production-grade signing.
- E-signature (draw/type/upload → flatten).
- Certified digital signature (PKCS#7) via `@signpdf/signpdf` + `node-forge` (web) / native Rust path (desktop); visible appearance; verify on read. **Own-cert signing shipped (2026-07-08):** the Sign dialog can use your own .p12/.pfx (+ passphrase) for a CA-issued (verified) identity, signed locally in-browser via `signPdfWithP12` — never uploaded; else a self-signed identity.
- [~] Signing workflows: request-to-sign, signing order, audit trail. **Design decided (2026-07-08, competitive research: DocuSign/Adobe/Dropbox/PandaDoc + ESIGN/eIDAS) + model shipped:** recipients by name+email (roles signer/cc), order toggle default-parallel or sequential (whose-turn gating), DocuSign-style audit trail (envelope GUID + SHA-256 hash + per-signer Sent/Viewed/Signed + consent event), status draft→sent→viewed→partially_signed→completed(+declined/voided); honest scope = ESIGN/eIDAS-SES + integrity (existing PKCS#7 seal), NOT AES/QES. `signing.ts` model over the Yjs `signing` map (co-signing syncs). Certificate-page render + request-to-sign UI are the next slices.
- [x] **PDF permission restriction shipped (2026-07-08)** — AES-256 (lopdf V5/R6, in the Rust core → wasm) with an empty open password + owner password + permission flags (print/copy/modify/annotate). Menu → 'Restrict permissions…' → protected download. Honest scope: restricts *actions* (compliant readers), not *access* (no open password → not confidential).
**Reuse:** collab tokens/rooms for per-signer links + audit.
**Gates:** UX-S1..S5 (incl. validates in Acrobat; redaction truly removes).

## Phase 5 — Heavy ops & page management
**Goal:** full document manipulation, off-thread.
- Page manager: reorder/rotate/insert/delete/merge/split/extract via `casual-pdf-core` worker (web) / native (desktop). *(Reorder/delete shipped via Organize Pages.)*
- [x] **True redaction (flatten, geometry-preserving)** — rasterize each marked page, paint opaque boxes, rebuild **inheriting the source MediaBox/CropBox/Rotate** (`packages/pdf-sdk/src/redact.ts`); untouched pages kept verbatim. This is the *secure* method (research-backed: immune to de-redaction attacks). UX-S5 verified on a rotated + offset fixture. The surgical byte-level path (Rust core, keeps text selectable) was attempted but **reverted as unsafe** (under-redacts XObjects/Type3; advance-width leak) — a fail-closed surgical engine is a later opt-in.
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
