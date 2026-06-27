# Feature Map — must-haves → building blocks

Every required feature mapped to **what we reuse / which OSS provides it / what we build**. "Build" means glue + UI, not a new engine. Licenses are MIT/Apache/BSD only (see `RESEARCH.md`).

---

## Must-haves (from the brief)

### Modes: View / Edit / Suggest (all surfaces, collab optional)
- **One core, configured.** Every surface (desktop / web / SDK) runs **View** (read-only), **Edit** (direct), and **Suggest** (proposals accepted/rejected by an owner), **with or without** collab. See `ARCHITECTURE.md` §2b.
- **Build:** a `mode` flag on the SDK; the Yjs overlay tags entries `state: applied | suggested` (Suggest writes `suggested`; Accept → `applied`; Reject → remove); View renders read-only.
- **Reuse:** `services/collab` for the collab-on path (multiplayer + shared suggestions); `y-indexeddb` / desktop sidecar for collab-off (solo) persistence.
- **Rights → mode** server-enforced: `viewer→View`, `commenter/suggester→Suggest`, `editor→Edit`, `signer→sign`.
- **Gates:** UX-S4 (mode can't be escalated client-side), UX-C* (when collab on).

### Co-editing (real-time collaborative editing)
- **Reuse:** `services/collab` (Yjs + Hocuspocus + WS) — unchanged.
- **Build:** bind our `Y.Doc` model (annotations/forms/comments/signing) to `HocuspocusProvider`; awareness for cursors/avatars/selection.
- **Gates:** UX-C1..C4. **Differentiator** — competitors charge for this or lack it.

### Public links (shareable view/comment/sign links)
- **Reuse:** collab share tokens + `resolveJoinRole()` (role + expiry + room binding + optional password) + share-link REST APIs.
- **Build:** role set `{viewer, commenter, editor, signer}`; share dialog UI; per-role server-side enforcement (read-only Yjs for viewer/commenter).
- **Gates:** UX-S4.

### Document signing — e-signature (visible)
- **OSS:** drawn/typed/uploaded signature → annotation; flatten via `pdf-lib` / `pdfium-render`.
- **Build:** signature pad UI (draw/type/upload), placement, flatten-on-finalize.
- **Gates:** UX-S1.

### Document signing — certified digital signature (PKCS#7)
- **OSS:** `@signpdf/signpdf` + `node-forge` (BSD-3) for detached CMS over ByteRange via incremental update; `pdf-lib` for placeholder + appearance; native path via Rust `cms`/`rsa`/`p256`. `pdfium-render` verifies on read.
- **Build:** cert/key management UI, visible signature appearance, sign-and-seal flow.
- **Gates:** UX-S2 (validates in Acrobat), UX-S3 (tamper-evident).

### Signing workflows (request to sign, signing order, audit)
- **Reuse:** collab rooms + share tokens (one signer = one scoped link) + SQLite for state/audit.
- **Build:** `signing` Yjs map (fields, assignees, order, status, audit trail); request-signature flow; email/notification hook; completion → finalize + lock.
- **Gates:** UX-S1..S3.

### Reading rights / permissions ("reading reigns")
- **Two layers:**
  1. **App/room rights** — role-based access via collab (`viewer/commenter/editor/signer`), enforced server-side.
  2. **PDF-level permissions/encryption** — owner/user password, print/copy/edit flags, AES encryption via `lopdf` / `pdfium-render`.
- **Build:** permissions dialog; apply encryption on export; honor flags on open.
- **Gates:** UX-S4.

---

## Other essentials for production-grade PDF editing

### Viewing (the foundation)
- **OSS:** EmbedPDF (PDFium-WASM) — high-fidelity render, **virtualized** scroll, zoom/pan, rotate, fit modes, thumbnails, outline/bookmarks, text search + selection.
- **Gates:** UX-P1..P5, UX-F1.

### Annotations
- **OSS:** EmbedPDF annotation plugins (highlight, ink, note, shapes, text, stamp); persist into binary via `pdf-lib`.
- **Build:** contextual property bar (color/width/font), direct manipulation (drag/resize/rotate/snap/multi-select), our toolbar UX.
- **Gates:** UX-I1..I4, UX-P4.

### Forms (AcroForm)
- **OSS:** EmbedPDF form fill; `pdf-lib` read/fill/flatten fields (text/checkbox/radio/dropdown).
- **Build:** form field UI, validation, flatten-on-export.

### Page operations
- **OSS:** `lopdf` / `pdfium-render` — reorder, rotate, insert, delete, merge, split, extract; `casual-pdf-core` worker runs these off-thread.
- **Build:** thumbnail page manager (drag to reorder), merge/split UI.

### Redaction (true removal)
- **OSS/Build:** mark regions in UI → `casual-pdf-core` (Rust) physically removes content streams + text runs + images, then re-rasterizes.
- **Gates:** UX-S5 (verified by text-extraction assertion).

### Comments & review
- **Build on collab:** threaded comments anchored to page regions, replies, @-mentions, resolve; survive page reorder (anchored to annotation id, not page index).
- **Gates:** UX-C4.

### Watermark / header / footer / Bates numbering
- **OSS:** `pdf-lib` / `pdfium-render` stamping.
- **Build:** templating UI.

### Export / print / download
- **Reuse:** desktop native webview print-to-PDF (`export_pdf` in shell). Web: worker flatten + download.
- **Gates:** UX-F2, UX-F3.

### Versioning & autosave / recovery
- **Reuse:** collab blob host stores immutable versions; desktop crash-recovery sidecars + chunked atomic save.
- **Gates:** UX-I5.

---

## Later / stretch (not v1)

| Feature | Why deferred | Path |
|---|---|---|
| **True body-text editing + reflow (Tier 2)** | PDF isn't reflowable; Adobe's moat | `document`-style hidden-model + repaint, scoped to simple text |
| **OCR (scanned → searchable)** | Heavy; needs an OSS OCR (e.g. Tesseract WASM) | Phase 4+; runs in `casual-pdf-core` worker |
| **PDF/A & PDF/UA compliance** | Specialized validation | Post-v1, via `pdfium`/validators |
| **AI assist (summarize, extract, ask)** | Additive | Later; Claude API over extracted text layer |

---

## Build-vs-reuse summary

| Layer | Source | Net new work |
|---|---|---|
| Render/view engine | EmbedPDF + PDFium (MIT/Apache) | config + UI |
| Binary write-side | pdf-lib + signpdf (MIT) | glue |
| Heavy ops (redact/merge/sign/extract) | Rust: pdfium-render + lopdf (MIT/Apache) | the crate |
| Co-editing / presence | `services/collab` (reuse) | Y.Doc binding |
| Public links / rights / auth | `services/collab` (reuse) | role extension |
| Desktop shell / offline / recovery | `services/desktop` (reuse) | DocKind + bridge |
| UI components | `@schnsrw/design-system` (reuse) | the app UX |
| **Genuinely new** | — | **app UX, Yjs PDF model, Rust core, signing/redaction flows** |
