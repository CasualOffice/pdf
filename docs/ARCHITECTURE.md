# Architecture

High-fidelity PDF viewer/editor across **web, desktop, and embed**, reusing internal infra (`collab`, `desktop`, `design-system`) and MIT/Apache OSS. This doc is the system design; feature-to-block mapping is in `FEATURES.md`, the bar is in `BENCHMARK.md`.

---

## 1. Guiding principles

1. **One engine: PDFium, everywhere.** Web = PDFium-WASM (via EmbedPDF). Desktop = PDFium native (via `pdfium-render`). Heavy worker = a Rust crate that targets both. → identical fidelity (gate UX-F1), one set of bugs.
2. **CRDT overlay, immutable base.** The PDF page content for a given version is immutable, content-addressed bytes. Everything *editable collaboratively* (annotations, comments, form values, signing state) lives in a **Yjs document**. We never try to CRDT-merge raw PDF bytes.
3. **Reuse before build.** `collab` (Yjs/Hocuspocus), `desktop` (Tauri), `design-system` (UI) are taken as-is. We add a PDF app + a Rust crate, nothing more at the platform layer.
4. **Headless core, swappable UI.** EmbedPDF headless gives us the engine + interaction primitives; our UI is ours (design-system), so we own the "polished" UX bar.
5. **Incremental update on write.** Edits append (incremental update) rather than rewriting — preserves originals, enables signatures, satisfies round-trip safety (UX-F2).

---

## 2. The two tiers of "editing" (scope honesty)

| Tier | What it means | Difficulty | Plan |
|---|---|---|---|
| **Tier 1 — Overlay/structure editing** | Annotate, comment, fill forms, sign, redact, page ops (reorder/rotate/insert/delete/merge/split), header/footer/watermark, flatten | Tractable with EmbedPDF + pdf-lib + pdfium-render | **This is v1 "full-featured editor."** |
| **Tier 2 — Body-text editing w/ reflow** | Edit existing paragraph text and reflow layout like a word processor | Adobe's moat; PDF isn't a reflowable format | **Stretch.** Approach later via a `document`-style hidden-model + repaint, scoped to simple cases. Not v1. |

We will **not** market Tier 1 as Tier 2. v1 is a best-in-class annotate/forms/sign/page editor.

---

## 3. System layers

```
┌───────────────────────────────────────────────────────────────┐
│  UI  (React 18 + Vite + TS)   — @schnsrw/design-system          │
│  toolbar · thumbnails · property bars · comments · sign panel   │
├───────────────────────────────────────────────────────────────┤
│  PDF App Core  (@casualoffice/pdf SDK)                          │
│  • Viewer: EmbedPDF headless (PDFium-WASM) — render/scroll/zoom │
│  • Interaction: annotation/select/redaction/form plugins        │
│  • Document model: AnnotationStore, FormStore, SignStore        │
│  • Collab binding: Yjs <-> stores (y-* observers)               │
│  • Write-side: pdf-lib (stamp/flatten/forms) + signpdf (PKCS#7) │
├──────────────┬────────────────────────────────────────────────┤
│ Heavy worker │  casual-pdf-core (Rust)                          │
│ (WASM in web │  binds PDFium (pdfium-render) + lopdf            │
│  Web Worker; │  render tiles · text extract · redaction apply  │
│  native on   │  · merge/split/encrypt/permissions · sign       │
│  desktop)    │                                                  │
├──────────────┴────────────────────────────────────────────────┤
│  Collab backend  (services/collab — reused as-is)               │
│  Yjs/Hocuspocus over WS · rooms · share tokens · personal auth  │
│  blob host (S3/Postgres/local) for immutable PDF versions       │
├───────────────────────────────────────────────────────────────┤
│  Runtimes:   Web (browser)   ·   Desktop (Tauri 2 shell)        │
└───────────────────────────────────────────────────────────────┘
```

---

## 4. Document model (the editable overlay)

A PDF session = **immutable base bytes** + a **Yjs doc** describing edits.

```
Y.Doc
 ├─ meta            Y.Map     { title, baseVersionId, pageOrder: Y.Array }
 ├─ annotations     Y.Array<Y.Map>   each: {id, type, page, rect, props, author, createdAt}
 ├─ formValues      Y.Map     fieldName -> value
 ├─ comments        Y.Array<Y.Map>   threads anchored to {page, rect}; replies; resolved
 ├─ signing         Y.Map     { fields: Y.Array, status, order, audit: Y.Array }
 └─ awareness (transient)     cursors, selection, viewport, user identity/color
```

- **Render** = PDFium rasterizes base page; UI paints the annotation/comment/form layers from the Yjs stores on top.
- **Commit / export** = worker bakes the overlay into the bytes via incremental update (pdf-lib for forms/annotations, signpdf for signatures, lopdf/pdfium for structure), producing a **new immutable version** stored in the collab blob host. The Yjs annotation history is preserved separately.
- **Page ops** mutate `meta.pageOrder` (CRDT-safe); the actual page-tree rewrite happens at export in the worker.

This split is what makes co-editing tractable: merging two `Y.Array` annotation inserts is conflict-free; merging two raw PDF byte streams is not.

---

## 5. The Rust core (`casual-pdf-core`)

A single crate, two compile targets — the heavy-duty insight from the brief.

- **Targets:** `wasm32-unknown-unknown` (web, runs in a Web Worker; PDFium also shipped as WASM) **and** native (linked directly into the desktop Tauri binary).
- **Binds:** `pdfium-render` (Apache/MIT) for render/extract/edit/sign-verify; `lopdf` (MIT) for pure-structure merge/split/encrypt/permissions (no PDFium needed).
- **Responsibilities (CPU-heavy, off the main thread):**
  - Tile/page rasterization at target zoom (feeds virtualized viewer, gate UX-P2/P3).
  - Text extraction + search index; selection geometry.
  - **Redaction apply** — physically remove content + text runs (gate UX-S5).
  - Merge/split/rotate/insert/delete, encryption + permission flags.
  - Flatten annotations/forms; bake signatures (native signing path).
  - Thumbnail generation.
- **Why one crate:** desktop calls it natively (no IPC marshaling cost); web calls it in a worker via wasm-bindgen. Same code → fidelity parity (UX-F1) for free.

> On web, EmbedPDF already ships its own PDFium-WASM for the *interactive viewer*; `casual-pdf-core` WASM is for the *heavy batch ops* (redaction bake, merge, export) we want off the UI thread and shared with desktop. On desktop, EmbedPDF still renders the viewport in the webview, but heavy ops route to the **native** Rust core via Tauri `invoke` for speed.

---

## 6. Collaboration (reuse `services/collab`)

`collab` is document-agnostic Yjs/Hocuspocus. We use it directly:

- **Transport:** `HocuspocusProvider` in the web app connects to the collab WS (`/yjs?room=…`), binding our `Y.Doc` (model above).
- **Presence/cursors:** Yjs awareness (already supported) → live cursors/avatars/selection (gates UX-C1).
- **Base PDF bytes:** stored via collab's host backend (`HostIntegration`: S3/Postgres/local) as immutable versions; the room references `baseVersionId`. Set `CASUAL_FILE_EXT=.pdf` + `application/pdf` MIME.
- **Public links & rights:** collab's share tokens + `resolveJoinRole()` already encode role + expiry + room binding. We extend the role set to `{viewer, commenter, editor, signer}` and enforce **server-side** (gate UX-S4) — viewers/commenters get a read-only Yjs connection.
- **Auth:** collab personal mode (SQLite sessions, single/multi) covers ownership; anonymous rooms + password covers quick public sharing.

No new collab server — at most a thin PDF-specific config + a couple of role/host hooks.

---

## 7. Desktop integration (reuse `services/desktop`)

Follows the documented convention for adding an app to the Tauri shell:

1. **App build** → `casual_pdf/apps/web` (Vite) builds to `dist/`, copied into `desktop/apps/shell/public/pdf/` by an extended `copy-editors.sh`; mounted at `/pdf/index.html`.
2. **`desk-bridge-bootstrap.ts`** in our app detects `?desk=1`, defines `window.__deskApp__`, and wires file I/O to Tauri `invoke` (chunked atomic save, recovery sidecars — gate UX-I5 for free).
3. **Shell changes** (`apps/shell/src-tauri/src/lib.rs`): extend `DocKind` with `Pdf` (subpath `pdf/index.html`, title "PDF", `.pdf` association); update `tauri.conf.json` file associations.
4. **Native Rust core:** add `casual-pdf-core` as a dependency of the shell's `Cargo.toml`; expose Tauri commands (`pdf_render_tile`, `pdf_redact_apply`, `pdf_merge`, `pdf_sign`, …). Web build calls the WASM version of the *same* crate.
5. **Export/print:** the shell already has native webview **print-to-PDF** (`export_pdf`) per platform — reuse for "Export/Print" (gate UX-F3).

Offline desktop = local files + local Rust core; collaboration optional (connect to collab when online). Crash recovery + dirty guard already exist in the shell.

---

## 8. Repo layout (mirror `document` / `sheet`)

```
services/casual_pdf/
├── README.md  ·  docs/{RESEARCH,BENCHMARK,ARCHITECTURE,FEATURES,ROADMAP}.md
├── CLAUDE.md                      # working rules (copy document/CLAUDE.md as template)
├── package.json                  # pnpm workspace root
├── pnpm-workspace.yaml
├── apps/
│   └── web/                       # Vite React SPA — the viewer/editor UI + desk-bridge
│       └── src/{shell,viewer,annotate,forms,sign,collab,comments,auth}/
├── packages/
│   └── pdf-sdk/                   # @casualoffice/pdf — embeddable SDK (mirror @casualoffice/sheets)
│       └── src/{viewer,model,collab,write,sign,embed}/
├── crates/
│   └── casual-pdf-core/           # Rust: pdfium-render + lopdf; wasm + native targets
│       ├── Cargo.toml             # crate-type = ["cdylib","rlib"]
│       └── src/{render,text,redact,structure,sign}.rs
└── collab/                        # thin config/override over services/collab (or import directly)
```

- **Frontend stack:** React 18 + Vite + TS (matches `document`/`sheet`), `@schnsrw/design-system` for UI.
- **SDK pattern:** publish `@casualoffice/pdf` with subpath exports (`/viewer`, `/collab`, `/embed`) exactly like `@casualoffice/sheets` — so it embeds in `drive`, `site`, etc.

---

## 9. Data & control flow (open → edit → sign → export)

```
Open:   base bytes (collab host) ──▶ PDFium-WASM render viewport
        Y.Doc (collab WS) ─────────▶ paint annotations/forms/comments overlay
Edit:   user action ──▶ mutate Yjs store ──▶ broadcast (Hocuspocus) ──▶ peers repaint
Sign:   place field ──▶ signing.fields (Yjs) ──▶ on finalize: worker/native bakes
        PKCS#7 (signpdf/native) via incremental update ──▶ new immutable version
Export: worker/native (casual-pdf-core) flattens overlay ──▶ new version ──▶ download/print
```

---

## 10. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| WASM cold-start (UX-P1) | Cache engine; progressive first-page paint; preload PDFium on app boot |
| Two PDFium copies on web (EmbedPDF + core) | Core WASM only loaded lazily for heavy ops; share if EmbedPDF exposes its engine handle |
| Redaction that doesn't truly remove (UX-S5) | Do it in the Rust core at byte level, assert via text-extract test |
| Signature interop (UX-S2) | Validate against real Acrobat fixture in CI, not our own validator |
| Tier-2 scope creep | Explicitly out of v1; gated behind a separate later phase |
| Rights enforced only in UI | Enforce at collab room (read-only Yjs) server-side (UX-S4) |
