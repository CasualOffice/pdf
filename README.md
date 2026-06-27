# casual_pdf

Production-grade, high-fidelity **PDF viewer + editor** for the Casual Office suite — web, desktop, and embeddable. Co-editing, e-signing, public share links, granular reading/editing rights, and a clean, polished UX.

This repo currently holds **design & planning docs only**. No code yet — by design. The plan deliberately maximizes reuse of existing internal infrastructure (`collab`, `desktop`, `design-system`) and permissively-licensed (MIT / Apache-2.0 / BSD) open source, rather than building from the ground up.

## The one decision that shapes everything

**PDFium is the single rendering/editing engine across all three runtimes.**

| Runtime | How PDFium is used | License |
|---|---|---|
| Browser (web app) | `@embedpdf/pdfium` — PDFium compiled to **WASM**, driven by **EmbedPDF** (headless, MIT) | MIT (EmbedPDF) + Apache-2.0 (PDFium) |
| Desktop (Tauri/Rust) | `pdfium-render` — the **same** PDFium, called **natively** from Rust | Apache-2.0/MIT (binding) + Apache-2.0 (PDFium) |
| Heavy worker | A shared **Rust crate** that compiles to **WASM** (browser worker) *and* native (desktop), both binding PDFium | MIT (our crate) |

One engine → identical rendering fidelity everywhere, one set of bugs, one mental model. We never reconcile "the web renderer vs the desktop renderer."

## What we reuse (do not rebuild)

- **Co-editing & presence** → `services/collab` (Yjs + Hocuspocus + WebSocket). Document-agnostic; takes PDF as opaque bytes today. Reused essentially as-is.
- **Public links, share tokens, rooms, personal-mode auth** → already in `services/collab` (`resolveJoinRole`, share-link APIs, SQLite sessions).
- **Desktop shell** → `services/desktop` (Tauri 2, per-document webview, chunked atomic save, crash recovery, native print-to-PDF). Adding `casual_pdf` is a known, documented convention (extend `DocKind`, mount `/pdf/index.html`).
- **UI** → `@schnsrw/design-system` (React components + tokens) for toolbar/dialogs/menus.
- **App skeleton & SDK pattern** → mirror `services/document` and `services/sheet` (React 18 + Vite + TS, publishable SDK package `@casualoffice/pdf`).

## Docs

- [`docs/RESEARCH.md`](docs/RESEARCH.md) — competitive landscape + OSS building-block survey with a license table.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design: PDFium-everywhere, the document model, collab layer, desktop integration, Rust/WASM worker, repo layout.
- [`docs/FEATURES.md`](docs/FEATURES.md) — every must-have feature mapped to its building block (co-editing, signing, public links, rights, redaction, …).
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased build plan from viewer → editor → signing → desktop.

## Status

Planning. See `docs/ROADMAP.md` Phase 0 for the first concrete steps.
