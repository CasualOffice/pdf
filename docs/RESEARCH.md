# Research: Competitive Landscape & Open-Source Building Blocks

Goal: build a production-grade PDF editor/viewer by **assembling permissively-licensed OSS + internal infra**, not by writing a PDF engine from scratch. This doc records what exists, what's reusable, and the licensing constraints.

---

## 1. Competitive landscape (what "good" looks like)

| Product | Model | Strengths | Notes for us |
|---|---|---|---|
| **Adobe Acrobat** | Proprietary | Reference for fidelity, true content editing w/ reflow, certified digital signatures, redaction | The fidelity bar. True body-text editing is their moat — hard. |
| **Apryse (PDFTron)** | Commercial SDK | Best-in-class web SDK, full annotation/forms/signing/redaction | What we approximate with EmbedPDF + custom layers, minus the license fee. |
| **Nutrient (PSPDFKit)** | Commercial SDK | Polished web/native, collaboration add-on, signing | UX reference for toolbars, annotation interactions. |
| **PDF Expert / Xodo / Foxit** | Proprietary | Fast viewers, annotation, sign | UX reference for "clean and polished." |
| **Stirling-PDF** | **OSS (MIT)** | Self-host toolbox: merge/split/OCR/convert/sign/redact | Great reference + potential backend helper for batch ops. |
| **iLovePDF** | Freemium SaaS + REST API | Broad task-suite (convert/compress/merge/split/OCR/sign/redact), polished per-tool UX, mature API w/ SDKs, eIDAS-compliant e-sign | Utility suite, **not a live editor**: no real-time co-editing/rights, server-side processing (upload→process→download). Reference for tool discoverability + batch/conversion breadth; we win on fidelity, co-editing, privacy. |
| **SimplePDF / PDF.js viewer** | OSS | Form fill, basic annotation, signatures | Baseline; we exceed via headless EmbedPDF. |

**Takeaways**
- "Full-featured editor" splits into two very different tiers (see Architecture §2): **Tier 1 = annotate/forms/page-ops/sign** (achievable, production-grade with OSS) and **Tier 2 = true body-text editing with reflow** (Adobe's moat; treat as a later, scoped stretch).
- Co-editing on PDF is rare in the market — it's our differentiator, and we already own the infra (`collab`). The big **tool-suites (iLovePDF, Smallpdf, Stirling-PDF)** have *none* — their "collaboration" is cloud-storage sync + sequential sign requests, not live multi-cursor editing with rights.
- The **tool-suite pattern is iLovePDF's moat and a gap for us**: discrete one-click utilities (convert PDF↔Office/JPG, compress, OCR, merge/split) drive their traffic. Worth borrowing as a UX layer (discoverable tools) alongside our live editor — `casual-pdf-core` (pdfium-render + lopdf) and Stirling-PDF as a backend helper can cover the high-value ones.
- **Privacy is a wedge**: iLovePDF uploads every file to its servers (auto-deleted ~2h, but off-device). Our client-WASM + desktop-native PDFium keeps sensitive docs on-device — a real selling point for legal/finance that a server-side suite structurally can't match.
- Certified/PKCS#7 **digital signatures** + **redaction** are table-stakes for "production grade" but most OSS viewers skip them. We'll build these explicitly. Note iLovePDF already ships multi-signer ordering + audit trail + eIDAS-compliant certified signatures, so our edge there is **combining** certified signing with high-fidelity in-app editing + co-review + an embeddable SDK, not signing alone.

---

## 2. Web rendering / editing engines

| Library | License | Engine | Renders | Edits | WASM | Verdict |
|---|---|---|---|---|---|---|
| **EmbedPDF** | **MIT** | PDFium-WASM | ✅ high-fidelity | annotation, forms, redaction, export | ✅ | **Primary base.** Headless + framework hooks (React/Vue/Svelte), plugin architecture, text search/selection, signature *verification*. Full code ownership, no vendor lock-in. |
| **PDF.js** | Apache-2.0 | own (JS) | ✅ | basic annotation editor (freetext/ink/stamp/highlight/signature), form fill | partial | Solid fallback/reference. Annotations are HTML overlays — saving back into the binary is weak; no shapes/arrows; no multi-user; no PKCS#7. |
| **pdf-lib** | **MIT** | own (JS) | ❌ (no render) | create/modify, fill forms, draw, **incremental update** | ✅ | **Use for write-side**: stamping annotations into the binary, form flattening, page ops, **embedding signature placeholders**. Pairs with a signer. |
| **pdfme** | MIT | — | template viewer | generation/forms (JSON templates) | ✅ | Optional, for templated PDF generation (not core). |
| **MuPDF** | **AGPL-3.0** | own | ✅ excellent | full | ✅ | ❌ **Avoid** — AGPL is incompatible with our distribution model. |

**Decision:** **EmbedPDF (render + interactive layer) + pdf-lib (binary write-side).** Both MIT. PDFium under the hood is Apache-2.0.

---

## 3. Rust crates (desktop-native + WASM worker)

| Crate | License | Use | Notes |
|---|---|---|---|
| **pdfium-render** | Apache-2.0 / MIT | Render, text/image extract, doc/page/text **create & edit**, save | Binds PDFium **at runtime** → the *same* engine as the web. Explicitly supports compiling to **WASM** alongside a WASM PDFium build. Native on desktop. |
| **lopdf** | **MIT** | Structural ops: merge/split/encrypt/permissions/watermark/strip-metadata | Pure Rust, zero C deps. Fast for structure-only work that doesn't need rendering. |
| **pdf / pdf-rs** | MIT | Low-level parse/inspect | Optional, for analysis. |
| **printpdf** | MIT | Generate PDFs | Optional. |
| ~~mupdf-rs~~ | AGPL | — | ❌ Avoid (license). |

**Decision:** `pdfium-render` for the heavy-duty render/extract/edit crate (shared web-WASM + desktop-native); `lopdf` for pure-structure ops (merge/split/encrypt/permissions) where we don't want to ship PDFium.

---

## 4. Signing stack (e-sign + certified digital signatures)

PDF signing has two distinct meanings — we need **both**:

1. **E-signature (visible mark):** drawn/typed/uploaded signature → placed as an annotation, then **flattened** into the page. Just rendering + `pdf-lib`/`pdfium-render` stamping. Easy.
2. **Digital signature (cryptographic, PKCS#7/CAdES):** detached CMS signature over a byte-range, embedded via **incremental update**; verifiable in Acrobat. This is the "production grade" part.

| Library | License | Role |
|---|---|---|
| **@signpdf/signpdf** (+ `placeholder-plain`/`placeholder-pdf-lib`) | **MIT** | Insert signature placeholder + apply detached **PKCS#7** signature over the ByteRange (JS/Node). |
| **node-forge** | BSD-3 / GPL (dual) | Build the PKCS#7/CMS, hash, cert handling — pair with signpdf. Use under BSD-3. |
| **pdf-lib** | MIT | Create the incremental-update placeholder + visible appearance stream. |
| **pdfium-render** | Apache/MIT | **Verify** existing signatures on read; render signature appearance. |
| **Rust:** `rcgen`, `rsa`, `p256`, `cms`/`rasn-cms` | MIT/Apache | Native (desktop) signing path if we want signing without Node. |

**Signing workflows** (request-to-sign, signing order, public signing links, audit trail) are **our own orchestration** on top of the `collab` backend (rooms + share tokens + SQLite) — no OSS product needed, just glue. See `FEATURES.md`.

---

## 5. Collaboration / CRDT

- **Yjs** (MIT) — fastest CRDT; battle-tested (Tiptap, Excalidraw, custom editors); awareness/presence/cursors, offline, snapshots, undo/redo. **Already deployed** in `services/collab` via **Hocuspocus** (MIT) over WebSocket.
- For PDF we model **annotations/comments/signing-state** as Yjs shared types (a `Y.Array` of annotation objects keyed by id), while the **base PDF bytes are immutable** per version (stored via collab's host backend: S3/Postgres/local). This is the clean split: CRDT for the editable overlay, content-addressed blobs for the page content.

---

## 6. Licensing summary (everything below is shippable)

| Component | License | OK to ship |
|---|---|---|
| EmbedPDF | MIT | ✅ |
| PDFium | Apache-2.0 / BSD-3 | ✅ |
| pdf-lib, pdfme, lopdf, pdf-rs, printpdf | MIT | ✅ |
| pdfium-render | Apache-2.0 / MIT | ✅ |
| @signpdf/signpdf | MIT | ✅ |
| node-forge | BSD-3 (use this option) | ✅ |
| Yjs, Hocuspocus | MIT | ✅ |
| PDF.js | Apache-2.0 | ✅ (fallback/reference) |
| **MuPDF / mupdf-rs** | **AGPL-3.0** | ❌ **excluded** |

**Rule:** MIT / Apache-2.0 / BSD only. **No (A)GPL** anywhere in the shipped artifact.

---

## Sources

- [EmbedPDF (MIT, PDFium-WASM, headless)](https://www.embedpdf.com) · [GitHub](https://github.com/embedpdf/embed-pdf-viewer) · [PDFium engine docs](https://www.embedpdf.com/docs/react/engine)
- [pdf-lib (MIT)](https://github.com/Hopding/pdf-lib) · [pdfme (MIT)](https://pdfme.com/)
- [PDF.js (Apache-2.0)](https://github.com/mozilla/pdf.js) · [PDF.js annotation editor types](https://github.com/mozilla/pdf.js/issues/16883)
- [pdfium-render (Rust, WASM-capable)](https://github.com/ajrcarey/pdfium-render) · [crates.io](https://crates.io/crates/pdfium-render)
- [lopdf vs pdfium writeup](https://dev.to/hiyoyok/lopdf-vs-pdfium-in-rust-what-i-learned-building-a-pdf-app-233b)
- [Chromium PDFium](https://github.com/chromium/pdfium) · [MuPDF (AGPL — excluded)](https://mupdf.com/)
- [PDFA survey of open-source PDF solutions](https://pdfa.org/wp-content/uploads/2021/06/Survey-of-OpenSource-Solutions.pdf)
- [Yjs (MIT)](https://github.com/yjs/yjs) · [Nutrient: top JS PDF viewers 2026](https://www.nutrient.io/blog/top-5-javascript-pdf-viewers/)
- [Open-source PDF editor comparison](https://www.softwaretestinghelp.com/open-source-pdf-editors/) · [Stirling-PDF style toolbox reference](https://ironpdf.com/blog/pdf-tools/open-source-pdf-editor/)
