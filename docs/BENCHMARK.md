# Competitive Benchmark & UX Acceptance Bar

What are we up against, and what counts as "production-grade, high-fidelity, clean & polished"? This doc sets the **bar we measure ourselves against** — feature parity targets and concrete, testable UX/performance acceptance criteria. Everything here is the *standard*, not aspiration; ship gates in `ROADMAP.md` reference these IDs.

---

## 1. Who we're up against

| Competitor | What they nail (our benchmark) | Where they're weak (our opening) |
|---|---|---|
| **Adobe Acrobat** | Fidelity; true text editing + reflow; certified PKCS#7 signatures; redaction that truly removes data; PDF/A | Heavy, expensive, desktop-bound; no real-time co-editing |
| **Apryse / Nutrient (PSPDFKit)** | Polished web SDK; smooth annotation UX; forms; signing; fast WASM render | Commercial license; collaboration is a paid add-on |
| **PDF Expert / Xodo / Foxit** | Fast, fluid, *delightful* annotation; great touch/trackpad feel | Limited collaboration; weaker forms/signing depth |
| **Drawboard / GoodNotes-style** | Best-in-class ink latency, palm rejection | Not document-collaboration tools |
| **Stirling-PDF (OSS, MIT)** | Broad toolbox: merge/split/OCR/redact/convert/sign | No live editor UX; batch/server-flavored |

**Our wedge:** match Apryse/Nutrient-class *single-user* polish **+** add the thing none of them give for free — **real-time co-editing, public links, and signing workflows** — because we already own that infra (`collab`). That's the benchmark: *"Acrobat-grade output, Figma-grade collaboration."*

---

## 2. Feature parity matrix (target = our v1 must-reach)

Legend: ✅ table-stakes (v1) · ➕ differentiator · ⏳ later/stretch

| Capability | Acrobat | Apryse/Nutrient | PDF Expert | **casual_pdf target** |
|---|:--:|:--:|:--:|:--:|
| High-fidelity render (PDFium) | ✅ | ✅ | ✅ | ✅ |
| Smooth virtualized scroll, large docs | ✅ | ✅ | ✅ | ✅ |
| Text search + selection | ✅ | ✅ | ✅ | ✅ |
| Annotations (highlight/ink/note/shape/text) | ✅ | ✅ | ✅ | ✅ |
| Form fill (AcroForm) | ✅ | ✅ | ✅ | ✅ |
| Page ops (reorder/rotate/insert/delete/merge/split) | ✅ | ✅ | ✅ | ✅ |
| E-signature (draw/type/upload) | ✅ | ✅ | ✅ | ✅ |
| **Certified digital signature (PKCS#7)** | ✅ | ✅ | ⏳ | ✅ |
| **True redaction (removes data)** | ✅ | ✅ | ⏳ | ✅ |
| Reading rights / permissions / encryption | ✅ | ✅ | ✅ | ✅ |
| **Real-time co-editing + presence** | ❌ | ➕(paid) | ❌ | ➕ ✅ |
| **Public share links (view/comment/sign)** | partial | ➕ | partial | ➕ ✅ |
| **Signing workflows (request, order, audit)** | ✅ | ➕ | ❌ | ➕ ✅ |
| Comments & threaded replies | ✅ | ✅ | ✅ | ✅ |
| Desktop app (offline) | ✅ | native SDK | ✅ | ✅ (Tauri) |
| True body-text editing + reflow | ✅ | partial | partial | ⏳ Tier 2 stretch |
| OCR (scanned → searchable) | ✅ | ✅ | ✅ | ⏳ Phase 4+ |

---

## 3. UX acceptance criteria (the "polished" bar — testable)

These are **gates**, each with a measurable target. A feature isn't "done" until it passes its UX gate.

### Performance (UX-P)
- **UX-P1 — First page paint:** ≤ 1.5s warm / ≤ 4s cold (WASM init) on a mid laptop. *(Industry WASM viewers sit at 3–9s cold; we beat the low end via cached engine + progressive first-page render.)*
- **UX-P2 — Scrolling:** 60fps, no white flashes. **Virtualized**: only viewport (±1) pages held in memory; memory stays flat regardless of doc length (1 page or 1,000).
- **UX-P3 — Zoom/pan:** continuous, no re-layout jank; re-rasterize at target zoom progressively (blurry → sharp), never blank.
- **UX-P4 — Ink latency:** annotation stroke follows pointer at < 30ms perceived lag; pointer-events + requestAnimationFrame batching.
- **UX-P5 — Big-doc open:** a 1,000-page / 100MB PDF opens to interactive first page without freezing the tab (stream + worker).

### Interaction (UX-I)
- **UX-I1 — Contextual toolbar:** selecting/creating an object surfaces a floating property bar *at the object* (color, width, font), not a hunt across a global ribbon.
- **UX-I2 — Tool discoverability:** primary tools (select, hand, highlight, note, draw, text, shapes, sign, redact) one click away; responsive layout collapses gracefully on narrow widths; toolbar can be hidden for max canvas.
- **UX-I3 — Direct manipulation:** annotations are drag/resize/rotate with snapping; multi-select; copy/paste; keyboard nudge.
- **UX-I4 — Undo/redo:** unlimited, instantaneous, and **collaboration-aware** (undo only *my* changes — Yjs UndoManager scoped to origin).
- **UX-I5 — No data-loss:** autosave + crash recovery (desktop sidecar; web via collab persistence). Dirty-state guard on close.
- **UX-I6 — Visual language:** consistent color/type palette via `@schnsrw/design-system`; standardized annotation colors; light/dark parity.

### Collaboration (UX-C)
- **UX-C1 — Presence:** live cursors + avatars + selection highlights within < 200ms of peer action; named, colored per user.
- **UX-C2 — Conflict-free:** two users annotating the same region never lose work or corrupt the doc (CRDT guarantee).
- **UX-C3 — Offline → online:** edit offline, reconnect, auto-merge with no manual conflict resolution.
- **UX-C4 — Comments:** threaded, resolvable, @-mention, anchored to a page region; survive page reorder.

### Signing & rights (UX-S)
- **UX-S1 — Sign in ≤ 3 clicks:** place signature → confirm → done; visible appearance + (for digital) embedded PKCS#7.
- **UX-S2 — Verifiable:** a digitally-signed PDF validates in Adobe Acrobat (interop is the test, not our own validator).
- **UX-S3 — Tamper-evident:** post-signature edits invalidate the signature and the UI says so clearly.
- **UX-S4 — Rights honored:** a "view-only" or "comment-only" link/role physically cannot edit/export beyond its grant (enforced server-side at the room, not just hidden in UI).
- **UX-S5 — Redaction is real:** redacted content is removed from the byte stream + text layer, not just black-boxed (verified by extracting text from the output).

### Fidelity (UX-F)
- **UX-F1 — Render parity:** a page rendered in the **web (PDFium-WASM)** is pixel-equivalent to the **desktop (pdfium-render native)** — same engine, enforced by a screenshot-diff test in CI.
- **UX-F2 — Round-trip safety:** open → save with no edits produces a structurally-equivalent PDF (no fidelity loss, no dropped objects); edits use **incremental update** so originals are never rewritten lossily.
- **UX-F3 — Print/export:** exported/printed output matches on-screen exactly (desktop uses native webview print-to-PDF already in the shell).

---

## 4. How we hold the bar

- Every gate above maps to an automated test where possible (perf budgets in CI, screenshot diffs for UX-F1, Acrobat-validation fixture for UX-S2, text-extraction assertion for UX-S5).
- A feature PR is **not mergeable** until its referenced UX-* gates pass.
- `ROADMAP.md` phases each list which gates they must clear to ship.

---

## Sources

- [Nutrient: PDF SDK performance benchmark 2026 (3,157 docs)](https://www.nutrient.io/blog/pdf-sdk-performance-benchmark/) · [PSPDFKit web performance best practices](https://pspdfkit.com/guides/web/best-practices/performance/)
- [Optimizing in-browser PDF rendering (virtualization)](https://joyfill.io/blog/optimizing-in-browser-pdf-rendering-viewing) · [react-pdf large-doc perf discussion](https://github.com/wojtekmaj/react-pdf/discussions/1691)
- [Nutrient: PDF annotations complete overview](https://www.nutrient.io/blog/pdf-annotations-with-javascript-a-complete-overview/) · [Drawboard: top PDF annotation apps 2026](https://www.drawboard.com/blog/top-pdf-annotation-apps)
- [PDF Annotator toolbar/UX manual](https://www.pdfannotator.com/en/help/opttoolbars)
