# Contributing to Casual PDF

Casual PDF is a production-grade PDF viewer + editor shipped across **three surfaces** (desktop, web app, embeddable SDK), in **three modes** (view / edit / suggest), **with or without** a collab server. Read this before opening a PR.

## Required reading

- [`docs/OVERVIEW.md`](docs/OVERVIEW.md) — repo map.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design + the surfaces × modes × collab matrix.
- [`docs/BENCHMARK.md`](docs/BENCHMARK.md) — the quality bar; every feature ships against its **UX-\*** gate.
- [`CLAUDE.md`](CLAUDE.md) — locked decisions (don't relitigate without explicit direction).

## Non-negotiables

1. **One engine: PDFium** everywhere (EmbedPDF/WASM on web, `pdfium-render` native on desktop, shared Rust core). No second renderer.
2. **Licenses: MIT / Apache-2.0 / BSD only. No (A)GPL.** (MuPDF/mupdf-rs are excluded.) New deps must be checked against [`docs/RESEARCH.md`](docs/RESEARCH.md) §6.
3. **CRDT overlay (Yjs) over immutable PDF bytes.** Never CRDT-merge raw PDF.
4. **Modes and collab are orthogonal flags on the same core** — never fork the codebase per surface or per mode. See ARCHITECTURE §"Modes & surfaces".
5. **Rights are enforced server-side** at the collab room, not just hidden in the UI (gate UX-S4).
6. **A feature isn't done until its referenced UX-\* gate passes** — automate the test where possible.

## Ship gates (from BENCHMARK.md)

| Prefix | Domain | Examples |
|---|---|---|
| UX-P | Performance | 60fps virtualized scroll, flat memory, <30ms ink latency |
| UX-I | Interaction | contextual toolbar, undo/redo, no data-loss |
| UX-C | Collaboration | presence <200ms, conflict-free, offline merge |
| UX-S | Signing & rights | validates in Acrobat, redaction truly removes, rights enforced |
| UX-F | Fidelity | web == desktop render (screenshot diff), round-trip safe |

## Workflow

1. Branch off `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep PRs scoped. Reference the relevant `UX-*` gate(s) and roadmap phase.
3. CI must be green: `docs` (markdown lint + link check) now; `web` + `rust` jobs auto-activate once code lands.
4. Update docs in the **same** PR when a doc-tracked fact changes (a locked decision, status, gate, phase state). Stale docs poison future work.
5. Fill in the PR template.

## Commit & PR conventions

- Clear, imperative commit subjects. No AI/assistant attribution or co-author trailers on commits or PRs.
- Squash-merge to `main`.

## Local toolchain (once code lands)

- **Web/SDK:** pnpm + Node 22. `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm test`.
- **Rust core:** stable toolchain + `wasm32-unknown-unknown`. `cargo fmt`, `cargo clippy -D warnings`, `cargo test`, `cargo build --target wasm32-unknown-unknown`.
- **Desktop:** Tauri 2 (via the `services/desktop` shell).
- Don't install software via `curl | bash` from a remote URL without consent — prefer Homebrew / npm / cargo.
