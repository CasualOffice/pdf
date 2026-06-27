# Repository Overview

A map of this repo: what's here, how it's organized, how it builds and ships. Start here, then read the deeper docs.

## What this is

**Casual PDF** — a production-grade, high-fidelity PDF **viewer + editor** with real-time co-editing, e-signing, public links, and granular reading/editing rights. Targets **web, desktop (Tauri), and embed**. Reuse-first: built on internal infra (`collab`, `desktop`, `design-system`) and MIT/Apache/BSD open source — not a from-scratch PDF engine.

> Status: **planning docs only** (no app code yet, by design). See [`ROADMAP.md`](./ROADMAP.md) Phase 0 for the first build step.

## The one decision

**PDFium is the single rendering/editing engine across every runtime** — web (EmbedPDF, PDFium-WASM), desktop (`pdfium-render`, native), and a shared Rust core (`casual-pdf-core`, compiles to both). One engine → identical fidelity everywhere. Editable state is a **Yjs CRDT overlay** on top of **immutable PDF bytes**.

## Directory map

```
casual_pdf/
├── README.md               # vision + the engine decision + quick links
├── CLAUDE.md               # working rules + locked decisions (for AI/contributors)
├── CONTRIBUTING.md         # how to work in this repo, gates, conventions
├── LICENSE                 # Apache-2.0
├── NOTICE                  # Apache attribution + third-party inventory
├── docs/
│   ├── OVERVIEW.md         # ← you are here
│   ├── RESEARCH.md         # OSS survey + license table + competitive landscape
│   ├── BENCHMARK.md        # competitive bar + testable UX/perf gates (UX-*)
│   ├── ARCHITECTURE.md     # system design, document model, Rust core, wiring
│   ├── FEATURES.md         # every must-have → reuse / OSS / build
│   └── ROADMAP.md          # phased plan, each phase lists its ship gates
├── .github/
│   ├── workflows/
│   │   ├── ci.yml          # lint docs now; full web + Rust pipeline once code lands
│   │   └── deploy-pages.yml# GitHub Pages deploy (manual until Phase 1; custom-domain ready)
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── CODEOWNERS
│   └── ISSUE_TEMPLATE/
└── (planned — see ARCHITECTURE.md §8)
    ├── apps/web/           # Vite + React + TS viewer/editor UI + desk-bridge
    ├── packages/pdf-sdk/   # @casualoffice/pdf embeddable SDK
    └── crates/casual-pdf-core/  # Rust: pdfium-render + lopdf → wasm + native
```

## Reading order

1. [`README.md`](../README.md) — the pitch + engine decision.
2. **This file** — the map.
3. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how it all fits.
4. [`RESEARCH.md`](./RESEARCH.md) — why these libraries (with licenses).
5. [`BENCHMARK.md`](./BENCHMARK.md) — the quality bar (UX-* gates).
6. [`FEATURES.md`](./FEATURES.md) — feature → building block.
7. [`ROADMAP.md`](./ROADMAP.md) — the build sequence.
8. [`CLAUDE.md`](../CLAUDE.md) — locked decisions + working rules.

## Modes & surfaces

One core, shipped three ways, run three modes, with collab optional — all from the **same codebase**.

- **Surfaces:** desktop (Tauri) · web app · embeddable SDK (`@casualoffice/pdf`).
- **Modes:** **View** (read-only) · **Edit** (direct changes) · **Suggest** (proposals an owner accepts/rejects — like Google Docs suggesting).
- **Collab:** **off** = solo single-user with local persistence · **on** = co-editing via `services/collab`.

Mode and collab are **independent runtime flags**, not separate builds. Full detail in [`ARCHITECTURE.md`](./ARCHITECTURE.md) §"Modes & surfaces".

## Locked decisions (at a glance)

| # | Decision |
|---|---|
| 1 | PDFium is the single engine (web WASM / desktop native / shared Rust core) |
| 2 | CRDT overlay (Yjs) over immutable base bytes — never CRDT-merge raw PDF |
| 3 | Yjs is the CRDT (no Automerge/Loro/custom) |
| 4 | MIT / Apache-2.0 / BSD only — **no (A)GPL** (MuPDF excluded) |
| 5 | Reuse `services/collab` as-is for co-editing / links / rights |
| 6 | Reuse `services/desktop` (Tauri 2) — add `DocKind::Pdf` |
| 7 | Standalone repo, built into the desktop shell; publish `@casualoffice/pdf` |
| 8 | v1 = Tier 1 full editor (annotate/forms/sign/redact/page-ops); Tier 2 reflow later |
| 9 | One core × 3 surfaces × 3 modes (view/edit/suggest) × collab on/off — same codebase |

## CI & deployment

- **CI** (`.github/workflows/ci.yml`) runs on every push/PR to `main`:
  - **docs** — markdown lint + relative-link check (active now).
  - **web** — install / lint / typecheck / build / test (auto-activates when `apps/web/` lands).
  - **rust** — `fmt` / `clippy -D warnings` / `test` / `wasm32` build (auto-activates when `crates/` lands).
  - Each future feature must also pass its referenced **UX-\*** gate from [`BENCHMARK.md`](./BENCHMARK.md).
- **Deploy** (`.github/workflows/deploy-pages.yml`) → GitHub Pages. **Manual-only (`workflow_dispatch`) until Phase 1.** To go live after Phase 1:
  1. Repo **Settings → Pages → Source: GitHub Actions**.
  2. Set repo variable **`PAGES_CUSTOM_DOMAIN`** to your domain → the workflow writes a `CNAME` so DNS/SSL bind automatically.
  3. Point the domain's DNS (CNAME → `casualoffice.github.io`, or A/AAAA to GitHub Pages IPs) and enable **Enforce HTTPS**.
  4. Uncomment the `push:` trigger in `deploy-pages.yml` for auto-deploy on merge.
  - Set the Vite `base` to `/` for a custom domain (or `/pdf/` for the default `*.github.io/pdf` path).
