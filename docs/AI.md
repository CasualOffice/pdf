# AI.md — Casual PDF AI (MCP · RAG · Agentic)

**Status: design/architecture (2026-07-05).** Reuse-first plan for the AI layer, grounded in the *actual* source of `services/collab`, `services/desktop`, and `packages/pdf-sdk` (every claim cites `file:line`; produced by a multi-agent, adversarially license-verified research pass). No AI code yet.

> **Overriding goal (user direction):** the AI must feel like **one native product, all made to work together — not stitched-together pieces.** The good news, confirmed from source: both runtimes already exist and Docs/Sheets use them today. Casual PDF adds only its own tool catalog, bridge, RAG, and MCP surface on top.

---

## 0. TL;DR

Casual PDF's AI job is **four small things on top of infrastructure that already ships**:

1. Author a **PDF DocOps tool catalog** (Anthropic `input_schema`).
2. Write **`PdfOpsBridge.callTool`** against the pdf-sdk (thickened `CasualPdfApi` + EmbedPDF/PDFium + Yjs overlay).
3. Port the existing **4-part DocOps client** (`transport.ts` / `catalog.ts` / `bridge.ts` / `AiPanel.tsx`) from Sheets/Docs into `packages/pdf-sdk/src/ai/`, with `MODEL='claude-opus-4-8'`.
4. Expose the **same catalog** through an MCP server/client surface.

The single unifier: the **same `PdfOpsBridge` + `PDF_CATALOG`** feed the collab server loop (cloud, provider via server env) and the desktop `docops_llm_call` (local llama.cpp, model chosen in the desktop app), **and** the MCP surface — so "which runtime" is a factory/config choice at runtime, **never a second build or a second product** (locked decision #9). Provider/model configuration is NOT a casual_pdf concern: desktop mode uses the shell's local-model settings, collab mode uses the server's env.

Separately, the **signing identity** moves from browser `localStorage` (`sign.ts:92`) to a **native OS-keychain vault** (Rust `keyring`, MIT/Apache) that also holds AI/MCP tokens, mirroring the existing `fonts.rs` Tauri-command bridge.

**Two hard prerequisites before shipping any AI *write*:** (a) add auth to the currently-unauthenticated `/api/ai` upgrade (`ai.ts:326` checks only the URL path); (b) export one canonical text-with-coordinates primitive for citation grounding. Keep destructive ops (redact/sign/flatten) human-confirmed.

---

## 1. What already exists (reuse anchors, from source)

### 1a. Docker-via-collab — server-held agentic loop
`services/collab/src/ai.ts` — `attachAiWs()` attaches a WebSocket server at `/api/ai` on the same Fastify+Hocuspocus process (`src/index.ts:497`). `runLlmLoop` (`ai.ts:205-300`) **holds the entire tool loop server-side**: calls the LLM, streams `text` blocks, and for every `tool_use` block emits `{type:'tool_call'}` to the **originating** client, blocks on the matching `{type:'tool_result'}` (routed via the `pendingToolResults` map), feeds it back, up to `MAX_TOOL_ROUNDS=12` (`ai.ts:48`; `capHit` surfaced in the `done` frame). Tool execution is **client-side** — the room only ever sees the resulting Yjs edits. Presence via `broadcastAiStatus` → Hocuspocus `broadcastStateless` (`ai.ts:136`). Provider-agnostic env config: `LLM_ENDPOINT` (default `https://api.anthropic.com/v1/messages`), `LLM_API_KEY`/`ANTHROPIC_API_KEY`, `LLM_API_KEY_HEADER`, `LLM_EXTRA_HEADERS` (`ai.ts:37-46`).

**Wire protocol** (`ai.ts:10-20`): Client→Server `{type:'chat', model, max_tokens, system, messages, tools, apiKey?, roomName?, maxToolRounds?}` and `{type:'tool_result', id, result, error?}`; Server→Client `{type:'tool_call', id, toolName, args}`, `{type:'text', text}`, `{type:'done', history, capHit?}`, `{type:'error', message}`. Only the `tools` array and `system` prompt are document-specific.

### 1b. Desktop-native — offline llama.cpp worker
`services/desktop/apps/shell/src-tauri/src/lib.rs:1905` `docops_llm_call` routes to the local `llama.cpp` `ai-worker` GGUF via `ai_local.rs:589 run_local_infer` (else HTTP-proxies cloud). `build_qwen_prompt` (`ai_local.rs:699`) renders the **Anthropic tools array into Qwen ChatML**; `extract_tool_call` parses `tool_use` back. The worker runs as an isolated OS process (`bin/ai_worker.rs`), streams tokens via `ai:stream-token`, GPU auto (Metal `Cargo.toml:62`, CUDA opt-in). Crucially it **returns Anthropic-format responses** — so the same client drives cloud or local. `llama-cpp-2` is MIT. **Zero new Rust needed** for the generation path.

### 1c. The DocOps client (Sheets/Docs) — copy-portable
Docs/Sheets consume both transports through one 4-part client (`services/sheet/apps/web/src/ai/`, `services/document/.../docops/`): a **`Transport` interface** with Direct/Collab/Desktop impls + a factory (`document/.../docops/transport.ts:458 createDocOpsTransport`), a shared **tool catalog**, a client-side **Bridge executor** (`sheet/.../ai/bridge.ts:46`), and a **panel** that branches on `transport.drivesLoop`. Casual PDF ports this near-verbatim.

### 1d. PDF SDK action surface (tool material)
`listTextRuns` (`textedit-pdfium.ts:246`, per-run bbox + `fontSizePt`/weight), reading-order `getPageGeometry`/`getTextSlices` (`CasualPdf.tsx:54`, currently private — **must be exported**), `buildRedactedPdf` (`redact.ts:42`), `buildOverlayEdit`/`resolveEditFont` (`textedit-overlay.ts:75`, `textedit-fonts.ts:233`), `mergePdfs` (`merge.ts`), page-furniture, `signPdf`/`verifyPdfSignatures` (`sign.ts`/`verify.ts`), the imperative `CasualPdfApi` (`modes.ts:51`), Yjs `model.ts`.

---

## 2. Core architecture — one core × 2 runtimes × collab on/off

Client core in `packages/pdf-sdk/src/ai/` (subpath-exported `@casualoffice/pdf/ai`):

- **`transport.ts`** — `DocOpsTransport` interface + factory. **TWO modes only**, and the provider/model choice lives OUTSIDE this repo: **DesktopTransport** (Tauri `invoke('docops_llm_call', …)` → the shell's llama.cpp worker; the *desktop app* owns local-model settings) and **CollabTransport** (WS to `/api/ai`; the *collab server env* — `LLM_ENDPOINT`/`LLM_API_KEY` — picks Anthropic/Ollama/OpenAI). Both `drivesLoop=true`. Factory `auto`: desktop-in-shell → Desktop, else collab-URL → Collab. **No client-side provider config or API-key UI in casual_pdf.**
- **`catalog.ts`** — `PDF_CATALOG` (Anthropic `{name, description, input_schema}`), **sorted by name** for prompt-cache stability.
- **`bridge.ts`** — `PdfOpsBridge.callTool(name, args)` switch returning a discriminated `{ok:true, data|diffSummary} | {ok:false, code, message, retryable}` union.
- **`AiPanel.tsx`** — `@schnsrw/design-system` panel; `MODEL='claude-opus-4-8'`; branches on `transport.drivesLoop`; `runQuickAction` single-completion fallback for the weak offline model.

**Runtime (a) desktop-native offline:** DesktopTransport → `docops_llm_call` → `run_local_infer` over the GGUF worker. **Runtime (b) Docker-via-collab cloud:** CollabTransport → `runLlmLoop` (reused unchanged) → Anthropic Messages. **Collab on/off:** same bridge + catalog; off = solo/desktop + local persistence, on = server loop + presence. AI-authored edits land as **Yjs overlay updates** on `/yjs`, inheriting the server `connection.readOnly` gate (`yjs.ts:122,128`).

---

## 3. Feature tiers

**Must-have (Phase A):** Ask-with-citations doc-QA · Summarize (page/selection/document) · Explain-selection. Cloud path uses Opus 4.8 native PDF `{type:'document'}` input + `page_location` citations — **no client RAG needed for cloud**. Offline/large-corpus uses the RAG subsystem (§4). Summarize/explain are one-shot completions that work even on a weak offline model.

**Differentiators (Phase B):** AI **PII-detection redaction** (LLM over extracted text-with-coords → redaction marks → reuse secure `buildRedactedPdf` flatten, **mandatory human confirm**) · per-run overlay **Translate** (reuse `buildOverlayEdit` + Noto Unicode/CJK; honest scope: per-run, **not** reflow-preserving) · structured **extract→JSON**.

**Stretch (Phase C):** Agentic multi-step edit ("find every SSN, redact, then sign") over the existing server/desktop loop (cloud-reliable; offline capped) · AI form-fill (**blocked** by a real gap — `model.ts formValues` Y.Map has no writer; build `fillFormField` first) · compare/diff versions.

**Out of scope v1:** generate-presentation/podcast (Adobe moat), reflow-preserving translation (Tier-2, decision #8).

---

## 4. RAG subsystem (offline / large-corpus only)

Cloud path uses Opus 4.8's 1M context + native PDF citations, so **client RAG is only for offline and large corpora**.

- **Chunking (no new engine):** structure-aware chunks from the existing PDFium text layer — group `listTextRuns`/`getPageGeometry` runs→lines→blocks by baseline/x-gap, detect headings by relative `fontSizePt`/weight, emit ~512-token section-scoped chunks (~15% overlap, never crossing a heading), each carrying `{pageIndex, bbox, charStart}`. Hard layouts/tables: optional server-side **Docling** (MIT). Scanned pages: **Tesseract / tesseract.js** (Apache-2.0) → word bboxes into the same pipeline (surface lower citation confidence).
- **Embeddings** (Anthropic has **no** first-party embeddings API): self-hosted permissive open model — **bge-small-en-v1.5** (MIT, 384-dim) or **nomic-embed-text-v1.5** (Apache-2.0, 768-dim). Run in the **same llama.cpp worker** (offline; add one Tauri command returning vectors) / **Transformers.js + ONNX Runtime Web** (web) / GGUF-or-ONNX micro-service (server). Voyage is an *optional* paid cloud tier only.
  - **⚠ Cross-backend caveat (verify-flagged):** same model+dimension does **not** guarantee an interchangeable vector space across GGUF-quant vs ONNX-fp32/int8. Rule: for any **shared collab index**, embed corpus **and** query on the **same backend** (embed server-side; client sends text). Keep GGUF-on-device strictly for the solo/offline path with its **own** local index, never cross-queried.
- **Vector store:** desktop+web = **sqlite-vec** (Apache-2.0/MIT, WASM + native) with bbox/page/section metadata + **SQLite FTS5 BM25** (public domain) for hybrid. Server/Docker = **pgvector** or **Qdrant** (Apache-2.0) HNSW for large corpora.
- **Retrieval:** hybrid BM25 ∪ dense, fused by Reciprocal Rank Fusion. Exposed as a DocOps tool `search_pdf_semantic(query)`; only the fused top-k **text** reaches the LLM.
- **Citation grounding (the differentiator):** each chunk resolves to page+rects; highlight via `createAnnotation` segmentRects (same path search/redact use). **Persist one canonical coordinate** — fractional top-left + explicit page size + documented converter (the codebase mixes PDF user-space bottom-left with fractional top-left + ad-hoc Y-flip at `chrome.tsx:2464`). **Verify every LLM-cited span back to a real extracted run before rendering** (guards the 73–87% citation-precision ceiling seen across ChatPDF/Humata/AskYourPDF). **Re-index on every `openDocumentBuffer` swap** via `onDocumentReplaced` (the known text-search-returns-0 gap → stale offsets otherwise).

---

## 5. Agentic tool surface

`PdfOpsBridge.callTool(name, args)` switch (mirror `SheetsBridge`), driven by the server loop (CollabTransport, `drivesLoop=true`) or the JS loop (Direct/Desktop). Anthropic guidance: **a few high-leverage consolidated tools** with prescriptive "when to call" descriptions + a read-before-write system prompt — not 1:1 wrappers over every EmbedPDF capability.

- **Read tools (parallel-safe):** `find_in_pdf`, `get_page_text`, `extract_text_with_coords`, `get_outline`, `list_form_fields`, `list_signatures`, `search_pdf_semantic`.
- **Write tools (propose-by-default):** `add_highlight`, `add_comment`, `fill_form_field` (needs new writer), `add_redaction_mark`, `place_signature`, `reorder_pages`, `apply_watermark`/`header_footer`/`bates`, `merge_pdf`. AI writes author Yjs overlay entries as `state:'suggested'` by an "AI" identity → human accept/reject (`model.ts acceptSuggestion/rejectSuggestion`, decision #9).

**Guardrails:** promote destructive/irreversible ops to dedicated, **human-confirmed** tools. Redaction Apply/flatten (`redact.ts:42`; AI only adds marks), PKCS#7 sign (full-rewrite invalidates prior signatures — never auto-sign), Secure text-edit flatten — the model only **proposes**; byte-baking requires a client-side confirm. Surface `capHit` when the 12-round cap exhausts.

**Server-loop vs local-loop:** server-loop when a collab room is present (reuse `runLlmLoop` verbatim). Local-loop (Direct/Desktop) for human-in-the-loop confirmation gates. Offline llama.cpp: single no-tools `runQuickAction` completion (the small model ignores long catalogs) — **never promise agentic offline**.

**Cloud request surface:** `thinking:{type:'adaptive'}` + `output_config.effort`; `strict:true` tool defs; **never** send `temperature`/`top_p`/`top_k`/`budget_tokens` (all 400) or last-assistant prefill (400); parallel `tool_result` blocks in **one** user message.

---

## 6. MCP surface (two additive surfaces, not a replacement)

MCP is JSON-RPC 2.0 over **stdio** or **Streamable HTTP** — a new transport orthogonal to the `/api/ai` loop. Only the **tool definitions** (one shared `PDF_CATALOG`) are reused; not the wire (decision #5 — one AI orchestration).

- **Expose AS an MCP server** (in the desktop Tauri shell): (a) ✅ **SHIPPED — headless pure-bytes stdio server** (`packages/pdf-sdk/src/mcp/{server,handlers}.ts`) wrapping the already-permissive pdf-sdk modules — **9 tools**: `merge_pdfs`, `add_watermark`, `add_header_footer`, `add_bates`, `sign_pdf` (PKCS#7 incremental — supply a .p12 or mint a throwaway self-signed identity), `verify_signatures`, `detect_pii`, `list_form_fields`, `fill_form` — file-in/file-out, no server, no network. Ships as a **self-contained dist bin**: `pnpm --filter @casualoffice/pdf build:mcp` (esbuild bundle) → `dist/mcp/server.mjs`, exposed as the `casual-pdf-mcp` bin and spawnable with **plain `node`** (no flags) — so the desktop release can bundle + launch it. Dev: `pnpm mcp`. Claude Desktop: `{ "mcpServers": { "casual-pdf": { "command": "node", "args": ["/abs/.../dist/mcp/server.mjs"] } } }`. **CI-gated** (`unit-tests` job): the unit suite + the real stdio handshake against the built bin (`verify-mcp-stdio.mjs` with `CASUAL_MCP_BIN`); handler round-trips in `verify-mcp.test.ts`. Follow-ups: `redact` tool (needs the render/flatten runtime, so it stays in-app). (b) then a **"drive the open document"** server bridging Rust→webview via a new `fonts.rs`-style Tauri command + the `window.__deskApp__` bridge to reach `CasualPdfApi`. **Default transport = stdio** (Claude Desktop spawns the server as a subprocess — no listening port). Map read ops→MCP **resources**, mutating ops→MCP **tools** (least-privilege). Any HTTP endpoint requires **Origin allowlist + `127.0.0.1` bind + per-launch bearer token + crypto `Mcp-Session-Id`** (DNS-rebinding CVE-2025-66414/66416 baseline — reference SDKs shipped rebinding protection **off** by default). OAuth 2.1 is out of v1 (stdio needs none). **Do not copy collab's unauthenticated `/api/ai` upgrade as the template.**
- **Consume MCP servers** behind the same catalog/bridge: cloud = Anthropic MCP connector (beta `mcp-client-2025-11-20`) — requires extending collab `callLlm` to pass `mcp_servers` + the beta header and tolerating server-executed `mcp_tool_use` blocks it does **not** relay (mixed-mode caveat). Offline/desktop = host a Rust **`rmcp`** MCP client in the shell (browsers can't spawn stdio).
- **Licenses:** `@modelcontextprotocol/sdk` (TS) = MIT; **`rmcp` (Rust) = Apache-2.0** (verify-corrected — *not* MIT; pin + confirm the vendored version). Both inside decision #4.

---

## 7. Model strategy

**Cloud (default, decision #5):** `claude-opus-4-8` (no date suffix), $5/$25 per MTok, 1M context, 128K max output. Native PDF input `{type:'document'}` (32MB/600-page limits, non-issue at 1M) + `citations:{enabled:true}` → `page_location` (1-indexed) → per-page highlight. **⚠ Caveat:** citations are **incompatible** with `output_config.format` structured outputs (400) — use `tool_use strict:true` for JSON **XOR** a cited answer, not both. Prompt-cache the immutable PDF + system prefix (Opus 4.8 min cacheable prefix = 4096 tokens → small PDFs won't cache; verify `usage.cache_read_input_tokens`). Set the panel `MODEL` explicitly — Docs/Sheets hardcode `claude-haiku-4-5` (a divergence to avoid inheriting).

**Offline (desktop-native, graceful degradation):** the existing llama.cpp GGUF worker. **⚠ Licensing GO/NO-GO gate:** the current catalog tops out at **Qwen2.5-3B whose weight license is contested** (Qwen RESEARCH non-commercial per one primary source vs Apache-2.0 relicense 2025-01-02 per another) — pin the **exact** GGUF the worker loads and confirm **that artifact's** license before enabling the offline tier in a commercial build. **Recommended:** Qwen2.5-7B-Instruct (**verified Apache-2.0**, matches `build_qwen_prompt`'s ChatML with zero prompt work) + an Apache-2.0 low-RAM tier (Qwen2.5-0.5B/1.5B, or Phi-3.5-mini MIT). Avoid Llama-3.1 (Meta Community) and Gemma (custom) unless legal signs off. Even a 7B is far weaker than Opus 4.8 at orchestration → offline = summarize/extract/ask, never promised agentic. Perf: ~60–120 tok/s (7B Q4_K_M, M3/M4 Metal), ~18 tok/s on 8GB; multi-second first-load Metal shader-compile stall → show a "loading model" state.

**Streaming:** the desktop local path emits `ai:stream-token` per token; collab streams text blocks over the WS. Both surface through the loop's `onText` callback so the panel renders live and shows the processing indicator.

---

## 8. Native identity/credential vault (the "cohesion" win)

**Goal:** move the PKCS#7 signing p12 + AI/MCP credentials from browser `localStorage` (`sign.ts:92-107`, hardcoded non-secret passphrase `casual-pdf` at `sign.ts:31`) to a **native encrypted-at-rest vault** on desktop, with a clean web fallback and one-time migration.

- **Store choice:** OS keychain via the Rust **`keyring` crate v4.x** (`MIT OR Apache-2.0`, all backends verified in-policy). OS-managed at-rest encryption, no app master password on macOS/Windows. **Rejected:** `tauri-plugin-stronghold` (in-policy but maintainer-**deprecated**, removed in Tauri v3); rolling age/ring encryption kept **only** as a Linux-headless fallback when Secret Service is absent.
- **⚠ Windows caveat (verify-refuted "stores p12 directly everywhere"):** Windows Credential Manager caps a blob at **2560 bytes**; a base64 RSA-2048 PKCS#12 (~3.3–4.7 KB) **exceeds it** ("CredWrite: bad data"). Required before ship: prefer an **ECDSA P-256** identity (p12 well under 2560B), or split across credential attributes (confirm `windows-native-keyring-store` supports it), or a DPAPI-encrypted-file fallback. **CI must round-trip a real RSA-2048 p12 through `identity_set/get` on Windows** (macOS/Linux pass and mask it).
- **Wiring (mirror the `fonts.rs` bridge triad exactly):** new `src-tauri/src/vault.rs` with `#[tauri::command] identity_get/identity_set` (+ `token_get/token_set`) returning/accepting base64 (like `fonts.rs:23`), backed by `keyring::Entry::set_secret/get_secret` → register in `lib.rs generate_handler![]` next to `casual_store` (`lib.rs:2118`) → add `identityGet/identitySet/tokenGet/tokenSet` to the `DeskApp` interface + `desk-bridge-bootstrap.ts` (mirror `resolveSystemFont`) → change **only** `sign.ts getIdentityP12` (`sign.ts:92`) to prefer `window.__deskApp__` on desktop, fall back to `localStorage` on web (same `isDesktop` switch `textedit-fonts.ts:243` uses). WebCrypto keygen + forge X.509/PKCS#12 + `@signpdf` incremental-update PKCS#7 stay **verbatim** (UX-F2/decision #5 unaffected).
- **Migration:** first desktop launch reads the existing `localStorage` p12, writes it to the keychain, then `removeItem` (idempotent, and **must** clear localStorage or the key stays plaintext on disk). Also the home for the deferred **import-your-own `.p12/.pfx`** item and the AI/MCP tokens.
- **Web fallback (honest):** web **cannot** reach true "key never extractable" while node-forge/`@signpdf` build the CMS (they need `extractable:true`, `sign.ts:55`). Interim win: move the p12 from `localStorage` to **IndexedDB**. True non-extractable requires refactoring signing to build the CMS with `crypto.subtle.sign` directly (a later item). **Do not market web as encrypted-at-rest/non-extractable — that guarantee is desktop-only.**

---

## 9. Data, privacy, security

- **CRITICAL PREREQUISITE (blocks all AI writes):** the `/api/ai` upgrade is **unauthenticated** — `attachAiWs` checks only `req.url.startsWith('/api/ai')` (`ai.ts:326`), unlike the `/yjs onAuthenticate` role gate (`yjs.ts:101`). Any client reaching the port can drive the loop and spend the server `LLM_API_KEY`; `broadcastAiStatus` trusts client-supplied `roomName`. Validate the same share-token/role as `/yjs` on the AI upgrade **first**. This is the UX-S4 enforcement point for AI.
- **Rights:** AI edits landing as Yjs overlay updates inherit `connection.readOnly` automatically. But byte-level pure ops (sign/redact/merge) bypass the room model → restrict to editor/signer at the tool-authorization layer. The `{viewer,commenter,editor,signer}` role set + signer write-gating is still deferred (Phase 3/4) — extend `resolveJoinRole` in `yjs.ts`, not `ai.ts`.
- **Destructive-op safety:** redaction Apply (true flatten via `redact.ts:42`, never the shelved surgical wasm), PKCS#7 sign, Secure flatten are irreversible → AI only proposes; byte-baking stays behind human-confirm.
- **Data residency:** cloud content goes only to the configured `LLM_ENDPOINT` (Anthropic default; content never used to train); provider-agnostic env config supports self-hosted/on-prem. Offline path keeps **all** inference + embeddings + retrieval on-device (air-gap capable). RAG embeddings/retrieval stay local; only fused top-k text reaches the LLM.

---

## 10. Licensing compliance

All **code** deps MIT/Apache/BSD (decision #4); no (A)GPL; MuPDF excluded. Model/font/embedding **weights** are runtime downloads reviewed for commercial/redistribution terms.

| Dependency | Role | License | Verdict |
|---|---|---|---|
| ws, fastify, @hocuspocus/* | collab `/api/ai` loop (reuse) | MIT | OK |
| llama-cpp-2 / llama.cpp | desktop worker (reuse) | MIT | OK |
| tauri 2 + plugins | shell (reuse) | MIT/Apache-2.0 | OK |
| EmbedPDF / PDFium | render (reuse) | MIT / BSD-3+Apache | OK |
| pdf-lib, @signpdf/*, node-forge, Yjs | pure ops/sign/CRDT (reuse) | MIT / MIT / BSD-3 / MIT | OK |
| @modelcontextprotocol/sdk (TS) | MCP | MIT | OK |
| **rmcp (Rust MCP SDK)** | MCP in shell | **Apache-2.0** (not MIT) | OK — pin+confirm |
| **keyring (Rust v4.x)** + backends | native vault | **MIT OR Apache-2.0** | OK — cargo-deny before merge |
| age / ring | Linux-headless vault fallback | MIT-Apache / Apache+ISC | OK (fallback only) |
| tauri-plugin-stronghold | (rejected) | MIT-Apache | in-policy but **rejected** (deprecated) |
| sqlite-vec + SQLite FTS5 | vector + sparse | Apache-2.0/MIT + public domain | OK |
| pgvector / Qdrant | server vector | PostgreSQL Lic / Apache-2.0 | OK |
| Transformers.js / ONNX Runtime Web | web embeddings | Apache-2.0 / MIT | OK |
| Docling / Tesseract / tesseract.js | layout/OCR | MIT / Apache-2.0 | OK |
| **Marker / MinerU** | parsers | GPL+non-commercial / custom (was AGPL) | **EXCLUDED** |
| Voyage AI | embeddings | closed paid API | optional cloud tier only |

**Weights (review before default):** Qwen2.5-0.5B/1.5B/7B = Apache-2.0 (**recommended offline**); **Qwen2.5-3B = contested → GO/NO-GO gate**; Llama-3.1/Gemma = avoid unless legal signs off; Phi-3.5-mini = MIT. Embeddings: bge-* & bge-m3 = MIT; nomic-embed / all-MiniLM / arctic / gte / mxbai = Apache-2.0; **exclude jina-v3 (CC-BY-NC), EmbeddingGemma (custom)**.

---

## 11. Roadmap (fits the existing ROADMAP)

- **A0 — Foundations (unblocks everything):** export one canonical `extractPageText(pdf,page)->{text,runs,bbox}` (lift `getPageGeometry/getTextSlices`) with fractional-top-left + documented converter; thicken `CasualPdfApi` (`searchText/extractText/addAnnotation/fillFormField/redactRegion/gotoPage/pageCount/getOutline`); port `transport/catalog/bridge/AiPanel` into `pdf-sdk/src/ai/` with `MODEL='claude-opus-4-8'`. **No AI writes yet.**
- **A — Table-stakes:** Ask-with-citations, Summarize, Explain (one-shot offline). Ship the native vault + migration in parallel (independent of collab).
- **B — Differentiators:** AI PII-detect redaction (secure flatten, human-confirm), overlay Translate, structured extract. Add offline RAG (sqlite-vec + FTS5 + bge/nomic in the worker) with the server-embeds-shared-index rule.
- **C — Frontier:** AI-socket auth on `/api/ai` + extend `resolveJoinRole` for `signer` (hard prerequisite) → agentic multi-step; build the `fillFormField` writer; compare/diff. MCP: pure-bytes stdio server → webview-bridged server; MCP consume (cloud connector + offline `rmcp`).
- **D — Publish/harden:** subpath-export `@casualoffice/pdf/ai`; desktop mounts `/pdf` so DesktopTransport is reachable; bump offline catalog to Apache-2.0 Qwen2.5-7B after the license gate; optional Voyage/remote-MCP tiers; WebCrypto-native CMS for non-extractable web keys.

---

## 12. UX-* acceptance gates

Each capability ships against a testable gate, automated via `tools/render-parity/verify-*.mjs` (working-rule #2).

- **UX-AI1 (citation grounding):** every rendered citation resolves to a real extracted run+bbox; unverifiable citations refused. Coordinate = fractional top-left, one converter.
- **UX-AI2 (summarize offline):** summarize-page returns non-empty text on the offline Qwen worker via a single no-tools completion (`stop_reason!='tool_use'`).
- **UX-AI3 (PII redaction trust):** "redact all SSNs" → after Apply, search returns 0 for every detected token (extends `verify-redact-geom.mjs`, UX-S5); routes only through `buildRedactedPdf`; requires explicit confirm.
- **UX-AI4 (agentic + cap):** a 2-step task completes within `MAX_TOOL_ROUNDS`; `capHit` surfaced; each `tool_call` echoes its `id`.
- **UX-AI5 (rights):** AI under viewer/commenter produces no Yjs mutation; byte-level tools refused for non-editor roles; `/api/ai` rejects unauthenticated connection (UX-S4 for AI).
- **UX-AI6 (sign unaffected):** AI-triggered sign produces a verifiable PKCS#7 (reuses `verify-signature-details.mjs`, UX-S2); vault-backed identity verifies identically.
- **UX-AI7 (translate honesty):** overlay translation embeds a covering font; original disclosed as present unless Secure/flatten; not marketed as reflow-preserving.
- **UX-AI8 (cloud request correctness):** payload sends `claude-opus-4-8` + `thinking:{type:'adaptive'}` and omits `temperature/top_p/top_k/budget_tokens`.
- **UX-AI9 (vault migration/Windows):** first launch migrates localStorage p12 → keychain and clears localStorage (idempotent); a Windows CI job round-trips a real RSA-2048 p12 (or asserts the ECDSA/split/DPAPI fallback).
- **UX-AI10 (MCP security):** any HTTP MCP endpoint rejects a mismatched Origin and binds only `127.0.0.1`; stdio server writes only valid JSON-RPC to stdout.
- **UX-F1 (render parity):** any AI bake (overlay/redact/sign) passes the existing screenshot-diff <2% gate.

---

## 13. Open questions (need a decision)

1. **Offline model license gate** — pin the exact Qwen GGUF the `ai-worker` loads; default to Apache-2.0-confirmed Qwen2.5-7B-Instruct.
2. **Shared-index embedding compatibility** — embed shared corpora server-side only; keep on-device GGUF for the solo local index.
3. **Windows 2560-byte cap** — ECDSA P-256 vs credential-attribute split vs DPAPI-file; add Windows CI round-trip.
4. **`/api/ai` auth design** — reuse `/yjs` share-token/role validation, or a separate scheme? Blocks all AI writes.
5. **Cloud MCP connector** — extend collab `callLlm` to tolerate server-executed `mcp_tool_use` blocks without breaking `tool_call`/`tool_result` routing.
6. **Citations vs structured outputs (400)** — two separate calls, or drop one, when a task needs both.
7. **Form-fill writer** — build `fillFormField` over `model.ts formValues` (none exists) before the AI form-fill tool.
8. **RAG re-index gap** — rebuild the index on every `openDocumentBuffer` swap via `onDocumentReplaced`.
9. **Offline embedding command** — add a vectors-returning Tauri command; confirm the worker hosts an embedding GGUF alongside the generation model.
10. **Web non-extractable signing** — whether/when to refactor `sign.ts` to a WebCrypto-native CMS.
