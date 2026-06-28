# CLAUDE.md — Casual PDF

## What this repo is

Solo / personal project named **Casual PDF** — a production-grade, high-fidelity **PDF viewer + editor** with real-time co-editing, e-signing, public share links, and granular reading/editing rights. Web, desktop, and embeddable. The path contains `melp/` as a **folder name only** — not a company or product. Do not call this project "melp" or imply organizational context.

**As of 2026-06-27 this repo holds design/planning docs only — no code yet, intentionally.** The plan is reuse-first: lean on existing sibling repos (`collab`, `desktop`, `design-system`) and MIT/Apache/BSD open source, not a from-scratch PDF engine.

## Required reading before substantive work

1. [`README.md`](./README.md) — vision + the single engine decision.
2. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system design, document model, Rust core, collab/desktop wiring.
3. [`docs/RESEARCH.md`](./docs/RESEARCH.md) — OSS building blocks + license table + competitive landscape.
4. [`docs/BENCHMARK.md`](./docs/BENCHMARK.md) — the competitive bar + testable UX/perf acceptance gates (UX-*).
5. [`docs/FEATURES.md`](./docs/FEATURES.md) — every must-have mapped to reuse / OSS / build.
6. [`docs/ROADMAP.md`](./docs/ROADMAP.md) — phased plan; Phase 0 is the first concrete step.

## Architecture in one breath

```
UI (React 18 + Vite + TS, @schnsrw/design-system)
  └─ @casualoffice/pdf SDK
       ├─ Viewer: EmbedPDF headless (PDFium-WASM)   ← render/scroll/zoom/search
       ├─ Document model: Yjs (annotations/forms/comments/signing) over immutable base bytes
       ├─ Write-side: pdf-lib + @signpdf/signpdf (stamp/forms/PKCS#7)
       └─ Heavy ops: crates/casual-pdf-core (Rust) → WASM (web worker) + native (desktop)
  ⇄ services/collab (Yjs/Hocuspocus) — co-editing, presence, public links, rights, blob host
  ⇄ services/desktop (Tauri 2) — offline, chunked atomic save, crash recovery, native print-to-PDF
```

## Locked decisions (do not relitigate without explicit user direction)

1. **PDFium is the single engine everywhere.** Web = PDFium-WASM via **EmbedPDF** (MIT, headless). Desktop = same PDFium native via **`pdfium-render`** (Apache/MIT). Heavy worker = one Rust crate (`crates/casual-pdf-core`) compiling to **both** `wasm32` and native. Identical fidelity → gate **UX-F1**. Don't introduce a second renderer (no PDF.js as the primary engine; it's a reference/fallback only).
2. **CRDT overlay, immutable base.** Editable state (annotations, form values, comments, signing) lives in a **Yjs** doc; the PDF page bytes for a version are immutable, content-addressed blobs. **Never try to CRDT-merge raw PDF bytes.**
3. **Yjs is the chosen CRDT.** Do not propose Automerge / Loro / custom alternatives.
4. **MIT / Apache-2.0 / BSD only. No (A)GPL anywhere in the shipped artifact.** Specifically **MuPDF / mupdf-rs are excluded (AGPL).** Approved: EmbedPDF, PDFium, pdf-lib, pdfme, lopdf, pdfium-render, @signpdf/signpdf, node-forge (use under BSD-3), Yjs, Hocuspocus, PDF.js (Apache, reference only).
5. **Reuse `services/collab` as-is.** It's document-agnostic Yjs/Hocuspocus already powering Docs/Sheets. New sync/presence/share-link/persistence work goes there, not a new server. Set `CASUAL_FILE_EXT=.pdf`; extend the role set to `{viewer, commenter, editor, signer}`.
6. **Reuse `services/desktop` (Tauri 2).** Adding this app is the documented convention: extend `DocKind` with `Pdf`, mount `/pdf/index.html`, ship a `desk-bridge-bootstrap.ts`, and expose native Rust-core commands via Tauri `invoke`. Don't rebuild file I/O — chunked atomic save + recovery already exist in the shell.
7. **Standalone repo, built-in to desktop.** `casual_pdf` stays its own repo (like `document`/`sheet`); the desktop shell's `copy-editors.sh` pulls its `dist/` into `public/pdf/`. Mirror the `@casualoffice/sheets` SDK pattern → publish `@casualoffice/pdf` with subpath exports (`/viewer`, `/collab`, `/embed`).
8. **v1 = Tier 1 full editor.** Annotate, forms, e-sign + certified PKCS#7, redaction (true byte-level removal), page ops, co-editing, public links, rights. **Tier 2** (true body-text editing with reflow) is a later stretch — PDF isn't a reflowable format; it's Adobe's moat. Do **not** market or scope Tier 1 as Tier 2.
9. **One core × 3 surfaces × 3 modes × collab on/off — same codebase.** Surfaces = desktop / web / SDK. Modes = **View** (read-only) / **Edit** (direct) / **Suggest** (proposals an owner accepts/rejects, Google-Docs-style). Collab **off** = solo with local persistence (`y-indexeddb` / desktop sidecar); collab **on** = co-editing via `services/collab`. Mode and collab are **independent runtime flags on the same `@casualoffice/pdf` core** — never separate builds or per-mode forks. Suggest = Yjs entries tagged `state: suggested` reviewed to `applied`/removed. Rights map to modes and are server-enforced. See `docs/ARCHITECTURE.md` §2b.

**Repo license:** this repository is **Apache-2.0** (`LICENSE` + `NOTICE`). (Separately, decision #4 governs which *dependency* licenses may be bundled: MIT/Apache/BSD only.)

## Working rules

1. **Never write technical claims about external systems (collab/desktop/design-system, OSS libs) from memory.** Read the actual source first; cite file paths (`services/collab/src/...:LINE`).
2. **Every feature ships against its UX-* gate** in `docs/BENCHMARK.md`. A feature isn't "done" until its referenced gate passes — automate the test where possible (perf budget, screenshot-diff for UX-F1, Acrobat-validation fixture for UX-S2, text-extract assertion for UX-S5).
3. **Frontend stack is React 18 + Vite + TS**, matching `services/document` and `services/sheet`. UI from `@schnsrw/design-system` (tokens + components). Don't introduce a different framework.
4. **Rights are enforced server-side at the collab room**, not just hidden in the UI (gate UX-S4). Viewers/commenters get a read-only Yjs connection.
5. **Edits use incremental update** (append, don't rewrite) to preserve originals and enable signatures (gate UX-F2).
6. **Don't install software via `curl | bash` from a remote URL without explicit user consent.** Prefer Homebrew / npm / cargo; ask which install method first.
7. **Docs are first-class.** When a doc-tracked fact changes (a locked decision, status, gate, phase state), update the relevant doc in the same commit. Stale docs poison every future session.

## Where things will live (target layout — see ARCHITECTURE.md §8)

- `apps/web/` — Vite React SPA: viewer/editor UI + `desk-bridge-bootstrap.ts`.
- `packages/pdf-sdk/` — `@casualoffice/pdf` embeddable SDK (mirror `@casualoffice/sheets`).
- `crates/casual-pdf-core/` — Rust (pdfium-render + lopdf); `crate-type = ["cdylib","rlib"]`; wasm + native.
- `collab/` — thin config/override over `services/collab` (or import directly).
- `docs/` — the planning docs above; keep current.

## Status (2026-06-27)

- **Planning complete.** README + `docs/{RESEARCH,BENCHMARK,ARCHITECTURE,FEATURES,ROADMAP,OVERVIEW}.md` written.
- **Decisions locked** (see above): PDFium-everywhere, CRDT-overlay, reuse collab/desktop/design-system, standalone repo, v1 = Tier 1.
- **Phase 0 scaffold built & verified.** `apps/web` (Vite+React+TS), `packages/pdf-sdk` (`@casualoffice/pdf`), `crates/casual-pdf-core` are in place. Verified green: JS typecheck + web build (bundles real **PDFium-WASM** via EmbedPDF — engine spike compiles & bundles), Rust `fmt`/`clippy -D warnings`/`test`, and **one crate → both `wasm32` + native** targets. `@schnsrw/design-system` wired as a `vendor/` git submodule (`link:` pnpm override, like `sheet`); App toolbar uses its `Button` + `tokens.css`. Deploy is **live on push to `main`** at **pdf.casualoffice.org** (repo var `PAGES_CUSTOM_DOMAIN` set; CI checkout fetches submodules).
- **UX-F1 (render parity) green.** `tools/render-parity/` diffs a fixture page rendered by web PDFium-WASM (EmbedPDF, via the app's `?src=` override + Playwright) against native `pdfium-render` (`--example render_page`, libpdfium from bblanchon/pdfium-binaries); **diff 0.217% < 2%** threshold. Wired as a CI job (`render-parity`). Runtime web render also verified live (UX-P1/P2 basic).
- **Deferred (tracked in ROADMAP):** SDK `peerDependencies` for `yjs`/`@hocuspocus/provider` + `/viewer`,`/collab`,`/embed` subpath exports (Phase 6 publish); collab `signer` role + write-gating (Phase 3/4); desktop `DocKind::Pdf` + `copy-editors.sh` `/pdf` (Phase 1); outline/bookmarks panel + continuous/single scroll-mode toggle (Phase 1).
- **Phase 1 production viewer (in progress).** `packages/pdf-sdk` now layers a full viewer on the engine via EmbedPDF plugins: virtualized scroll + tiling, zoom/fit-width/fit-page, rotate, page nav, two-page spread, pan, fullscreen, text search + highlights, text selection, thumbnails — driven by a floating toolbar (`src/ui/chrome.tsx`, `icons.tsx`, `IconButton.tsx`, `viewer.css`). UI follows the design prefs: SVG icons (filled=active), WCAG 2.2, rounded/floating surfaces with color-separation (design-system tokens), light/dark. Verified headless (4-page nav, zoom 140%, 19 search matches, thumbnails, dark). Note: `@embedpdf/plugin-selection`/`-pan` require `@embedpdf/plugin-interaction-manager` registered. See [[feedback-ui-design-prefs]].
- **Layout = professional PDF editor (Acrobat/Nutrient-style), NOT Google Docs.** (User reversed off Docs on 2026-06-28; **fidelity + editing UX prioritized over collaboration**.) `apps/web` slim top bar: hamburger menu (Open/Download/Print/About) + logo + editable title + **View/Suggest/Edit segmented control** + theme + avatar. SDK `src/ui/chrome.tsx`: **left tool rail** (nav + annotation tools + undo/redo, Edit/Suggest only), **right contextual properties panel** (color/width/delete), **floating bottom view bar** (nav/zoom/fit/rotate/spread/scroll-dir/pan/fullscreen), max canvas, find fab top-right. Keyboard shortcuts (V/H/D/T/N/R/O/A, Esc, Delete) + crosshair cursor with a tool active. Brand **logo + favicon** from `apps/web/public/logo.svg`. iLovePDF added to `docs/RESEARCH.md`. See [[feedback-ui-design-prefs]].
- **App shell: File/View/Help menu bar + Open/Save (done).** `apps/web/src/Menu.tsx` (accessible Google-Docs menu bar) + `App.tsx`: **Open** a local PDF (file picker → object URL → `key`-remount the viewer), **Download**, **Print/open-in-tab**, ⌘O/⌘S, dark-theme (View menu, app-owned via `data-theme`), full screen, About dialog. **Outline/bookmarks** panel + **scroll-direction** toggle added to the SDK viewer (one left panel at a time). Theme moved out of the toolbar into the View menu.
- **Phase 2 annotation editor (in progress).** `@embedpdf/plugin-annotation` + `-history` + `-export` wired: tool palette (highlight, ink, free-text, note, rectangle, ellipse, arrow) in the toolbar (Edit/Suggest only) + the **Insert** menu; undo/redo (toolbar + Edit menu); File → Download bakes annotations (export plugin). Key gotchas: each page must wrap its layers in `PagePointerProvider` (pointer routing), the viewer must be wrapped in `AnnotationRendererProvider`, and `AnnotationLayer` needs an explicit fill `style` (`position:absolute; inset:0`) or it collapses to 0-height. SDK exposes an imperative `CasualPdfApi` via `apiRef` (download/undo/redo/deleteSelection/setTool) for host menus. Text `SelectionLayer` renders only in view mode (annotation tools own the pointer in edit mode). See [[feedback-ui-design-prefs]].
- **Tier-1 editor features shipped (Edit/Suggest, left rail + menus).** **Organize Pages** (reorder/delete via `engine.mergePages` → `openDocumentBuffer`); **Form filling** (`@embedpdf/plugin-form`, interactive AcroForm fields via `AnnotationLayer annotationRenderers={formRenderers}`); **E-signature** (`@embedpdf/plugin-signature`, SignatureOnly mode — a "Sign" rail tool opens a Draw/Type modal; "Add signature" arms placement, a banner prompts a page click; placements are signatureStamp/signatureInk annotations rendered by the AnnotationLayer and **baked into the PDF on Download** via appearance streams). All verified headless end-to-end (e-sign confirmed in the downloaded bytes by re-opening the file). **Note:** e-signature here is a *visible* signature stamp, **not** certified cryptographic PKCS#7 signing (that's still a v1 item per locked decision #8 — UX-S2).
- **Certified PKCS#7 digital signing shipped (UX-S2).** Distinct from the *visible* signature stamp: a real cryptographic signature. SDK subpath `@casualoffice/pdf/sign` (`packages/pdf-sdk/src/sign.ts`) wraps the in-policy write-side stack — `@signpdf/signpdf` + `@signpdf/placeholder-plain` + `@signpdf/signer-p12` + `node-forge` (decision #4) — applied as an **incremental update** (append-only, original bytes preserved → decision #5 / UX-F2). Two identities: a browser-minted **self-signed** cert (`generateSelfSignedP12`) or an uploaded **.p12/.pfx**. App: Menu → **Digitally sign…** (`apps/web/src/SignDialog.tsx`) → `api.getBytes()` (new `CasualPdfApi.getBytes()` via `exportCap.saveAsCopy()`) → `signPdf` → downloads `<name>-signed.pdf`. The crypto stack (~85 KB gz) is **lazy-loaded** via the `/sign` subpath (own async chunk; main bundle stays ~195 KB gz). Needs a `Buffer` global — the web app polyfills it in `main.tsx` (`buffer` pkg). Verified headless end-to-end through the UI: downloaded a signed PDF and **cryptographically verified** the embedded PKCS#7 (messageDigest matches the ByteRange content, signature valid under the cert pubkey, signer CN correct). Note: a self-signed signature is *valid* but the signer is "identity unverified" in a verifier's trust store — expected; a CA-issued .p12 gives verified identity.
- **Redaction is NOT shipped.** Built against `@embedpdf/plugin-redaction` but true byte-level removal did not work on this PDFium-WASM build (the red box persisted after apply+reload) — reverted entirely rather than ship a broken trust feature. Needs engine/Rust-core investigation (gate UX-S5).
- **Next (autonomous increments):** keep raising **fidelity + editing UX** — smoother selection/move/resize, text-annotation editing, image stamps, opacity/font controls, more polish; redaction true-removal (UX-S5) remains open (needs engine/Rust-core). Collaboration/Share is **deprioritized** per the user; revisit later (collab notes from the Phase-3 investigation are in git history / the `services/collab` audit).
