// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the "Ask this PDF" engine: catalog, bridge, and the agent loop
// (streaming + processing-indicator state + tool execution) — deterministic, no
// network or browser, driven by a fake transport + mock CasualPdfApi.
//
//   node --experimental-transform-types --test tools/render-parity/verify-ai-engine.test.ts
//
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDF_CATALOG, PDF_SYSTEM_PROMPT } from '../../packages/pdf-sdk/src/ai/catalog.ts';
import { PdfOpsBridge } from '../../packages/pdf-sdk/src/ai/bridge.ts';
import { chunkPages, rankChunks, cosineSimilarity, reciprocalRankFusion, hybridRankChunks } from '../../packages/pdf-sdk/src/ai/retrieve.ts';
import { toAnnotationRect, findRunsForText } from '../../packages/pdf-sdk/src/ai/highlight.ts';
import { luhnValid, verhoeffValid, ibanValid, abaValid, nhsValid, cpfValid, spainDniValid, isinValid, detectPii, PII_TYPES } from '../../packages/pdf-sdk/src/ai/pii.ts';
import { listFormFields, fillFormFields } from '../../packages/pdf-sdk/src/ai/form.ts';
import { linkifyCitations } from '../../packages/pdf-sdk/src/ai/cite.ts';
import { runDocOpsTurn } from '../../packages/pdf-sdk/src/ai/loop.ts';
import { DesktopTransport, CollabTransport } from '../../packages/pdf-sdk/src/ai/transport.ts';
import type { DocOpsTransport, LlmCallPayload, LlmCallResult } from '../../packages/pdf-sdk/src/ai/transport.ts';

// ── mock CasualPdfApi (only the methods the bridge uses) ─────────────────────
function mockApi(over: Record<string, unknown> = {}) {
  const gotos: number[] = [];
  const highlights: { page: number; rects: unknown[] }[] = [];
  const redactions: { page: number; rects: unknown[] }[] = [];
  const api = {
    pageCount: () => 3,
    getOutline: async () => [{ title: 'Intro', pageIndex: 0, children: [] }],
    extractText: async (page: number) => ({
      pageIndex: page,
      width: 612,
      height: 792,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      text: `Mitochondria produce ATP on page ${page}.`,
      runs: [
        { text: 'Mitochondria produce ATP', charStart: 0, charEnd: 24, userSpace: { left: 72, bottom: 700, right: 300, top: 712 }, frac: { x: 0, y: 0, w: 0, h: 0 }, fontSizePt: 12, fontWeight: 400, fontItalic: false, fontBaseName: 'Arial', fontSubsetted: false, color: 'rgb(0,0,0)' },
      ],
    }),
    gotoPage: (p: number) => gotos.push(p),
    highlightRegion: (page: number, rects: unknown[]) => highlights.push({ page, rects }),
    addRedactionMarks: (page: number, rects: unknown[]) => redactions.push({ page, rects }),
    listFormFields: async () => [{ name: 'fullName', type: 'text', value: null }],
    fillForm: async (values: { name: string; value: unknown }[]) => ({ filled: values.map((v) => v.name), skipped: [] }),
    extractAllText: async () =>
      [
        'The mitochondria is the powerhouse of the cell and produces ATP energy.',
        'Photosynthesis in plants converts sunlight into chemical energy in chloroplasts.',
        'The invoice total is $4,200 due on receipt to Acme Corporation.',
      ].map((text, i) => ({ pageIndex: i, width: 612, height: 792, mediaBox: { x: 0, y: 0, width: 612, height: 792 }, text, runs: [] })),
    ...over,
  };
  return { api: api as any, gotos, highlights, redactions };
}

/** A run covering a whole page-text string, for PII/redaction tests. */
function oneRun(text: string) {
  return { text, charStart: 0, charEnd: text.length, userSpace: { left: 72, bottom: 700, right: 500, top: 712 }, frac: { x: 0.12, y: 0.1, w: 0.6, h: 0.02 }, fontSizePt: 12, fontWeight: 400, fontItalic: false, fontBaseName: 'Arial', fontSubsetted: false, color: 'rgb(0,0,0)' };
}
function piiApi(text: string) {
  return { extractText: async (page: number) => ({ pageIndex: page, width: 612, height: 792, mediaBox: { x: 0, y: 0, width: 612, height: 792 }, text, runs: [oneRun(text)] }) };
}
const bridge_ = (api: unknown) => new PdfOpsBridge(() => api as never);

// ── catalog ──────────────────────────────────────────────────────────────────
test('PDF_CATALOG is well-formed and sorted by name (prompt-cache stability)', () => {
  assert.ok(PDF_CATALOG.length >= 3);
  const names = PDF_CATALOG.map((t) => t.name);
  assert.deepEqual([...names].sort(), names);
  for (const t of PDF_CATALOG) {
    assert.equal(t.input_schema.type, 'object');
    assert.equal(typeof t.description, 'string');
  }
  assert.ok(PDF_SYSTEM_PROMPT.includes('get_document_info'));
  assert.ok(PDF_CATALOG.some((t) => t.name === 'search_document'));
});

// ── retrieval (RAG-lite) ─────────────────────────────────────────────────────
test('chunkPages splits page text into passages tagged with their page', () => {
  const chunks = chunkPages([
    { pageIndex: 0, text: 'Para one.\n\nPara two.' },
    { pageIndex: 1, text: 'Second page.' },
  ]);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => typeof c.page === 'number' && c.text.length > 0));
  assert.ok(chunks.some((c) => c.page === 1 && /Second page/.test(c.text)));
});

test('cosineSimilarity: identical=1, orthogonal=0, degenerate=0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test('reciprocalRankFusion: an item in both lists beats one in a single list', () => {
  const fused = reciprocalRankFusion(
    [[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]],
    (t) => t.id,
  );
  assert.equal(fused[0].id, 'b'); // b appears in both → highest fused score
  assert.deepEqual(fused.map((f) => f.id).sort(), ['a', 'b', 'c']); // all present
});

test('hybridRankChunks: dense surfaces a semantic match BM25 misses; BM25 fallback without an embedder', async () => {
  const chunks = [
    { page: 0, text: 'The capital of France is Paris.' },
    { page: 1, text: 'Mitochondria are the powerhouse of the cell.' }, // answers the query semantically, no keyword overlap
    { page: 2, text: 'Quarterly revenue grew ten percent.' },
  ];
  const query = 'how do cells produce energy';
  // No embedder → pure BM25 (does NOT rank the mitochondria passage first).
  const bm25 = await hybridRankChunks(chunks, query, 3);
  assert.notEqual(bm25[0]?.page, 1);
  // A fake embedder that scores by topic — the query lands in the biology bucket.
  const vec = (t: string): number[] => {
    const s = t.toLowerCase();
    return [/cell|mitochondria|energy|powerhouse|produce/.test(s) ? 1 : 0, /france|paris|capital/.test(s) ? 1 : 0, /revenue|percent|quarter/.test(s) ? 1 : 0];
  };
  const embedder = async (texts: string[]) => texts.map(vec);
  const hybrid = await hybridRankChunks(chunks, query, 3, embedder);
  assert.equal(hybrid[0].page, 1); // dense retrieval surfaces the semantic answer
});

test('rankChunks (BM25) ranks the passage matching the query first', () => {
  const chunks = [
    { page: 0, text: 'The mitochondria is the powerhouse of the cell and produces ATP energy.' },
    { page: 1, text: 'Photosynthesis in plants converts sunlight into chemical energy.' },
    { page: 2, text: 'The invoice total is $4,200 due to Acme Corporation.' },
  ];
  const top = rankChunks(chunks, 'how much is the invoice total', 2);
  assert.ok(top.length >= 1);
  assert.equal(top[0].page, 2); // the invoice passage wins
  assert.deepEqual(rankChunks(chunks, 'xyzzy nothingmatches', 3), []); // no match → empty
});

// ── source-span highlighting (coordinate conversion is the risk) ─────────────
test('toAnnotationRect maps user-space (bottom-left) to {origin,size} with no flip', () => {
  // left=10, bottom=20, right=110, top=32 → origin at (10,20), 100×12.
  assert.deepEqual(toAnnotationRect({ left: 10, bottom: 20, right: 110, top: 32 }), {
    origin: { x: 10, y: 20 },
    size: { width: 100, height: 12 },
  });
});

test('findRunsForText matches runs making up a cited passage', () => {
  const runs = [
    { text: 'Mitochondria produce', userSpace: { left: 0, bottom: 0, right: 1, top: 1 } },
    { text: 'ATP energy', userSpace: { left: 1, bottom: 0, right: 2, top: 1 } },
    { text: 'Unrelated caption', userSpace: { left: 0, bottom: 5, right: 1, top: 6 } },
  ];
  // A phrase spanning two runs highlights both, not the caption.
  const hit = findRunsForText(runs, 'mitochondria produce ATP energy');
  assert.deepEqual(hit.map((r) => r.text), ['Mitochondria produce', 'ATP energy']);
  // A keyword highlights the run it sits in.
  assert.deepEqual(findRunsForText(runs, 'energy').map((r) => r.text), ['ATP energy']);
  assert.deepEqual(findRunsForText(runs, 'nonexistent'), []);
});

test('bridge.highlight_source highlights the matching run with its real rect', async () => {
  const { api, highlights, gotos } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  const res = await bridge.callTool('highlight_source', { page: 1, text: 'Mitochondria produce ATP' });
  assert.equal(res.ok, true);
  assert.equal((res as { data: { highlighted: number } }).data.highlighted, 1);
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].page, 1);
  assert.deepEqual(highlights[0].rects, [{ left: 72, bottom: 700, right: 300, top: 712 }]); // the run's real user-space rect
  assert.deepEqual(gotos, []); // highlightRegion (not goto_page) drives the scroll
  // Text not on the page → ok, but nothing highlighted.
  const miss = await bridge.callTool('highlight_source', { page: 1, text: 'zzz not present' });
  assert.equal((miss as { data: { highlighted: number } }).data.highlighted, 0);
});

// ── PII detection (regex + checksums) ────────────────────────────────────────
test('checksums: Luhn, Verhoeff (Aadhaar), IBAN mod-97, ABA routing', () => {
  assert.equal(luhnValid('4111111111111111'), true); // Visa test card
  assert.equal(luhnValid('4111111111111112'), false); // bad check digit
  assert.equal(verhoeffValid('299556705675'), true); // valid Aadhaar (Verhoeff)
  assert.equal(verhoeffValid('299556705676'), false);
  assert.equal(ibanValid('GB82WEST12345698765432'), true); // canonical valid IBAN
  assert.equal(ibanValid('GB82WEST12345698765433'), false);
  assert.equal(abaValid('021000021'), true); // valid US routing
  assert.equal(abaValid('021000022'), false);
  assert.equal(nhsValid('943 476 5919'), true); // valid NHS (mod-11)
  assert.equal(nhsValid('943 476 5918'), false);
  assert.equal(cpfValid('529.982.247-25'), true); // valid Brazil CPF
  assert.equal(cpfValid('529.982.247-24'), false);
  assert.equal(spainDniValid('12345678Z'), true); // valid Spain DNI (mod-23)
  assert.equal(spainDniValid('12345678A'), false);
  assert.equal(isinValid('US0378331005'), true); // valid ISIN (Apple)
  assert.equal(isinValid('US0378331006'), false);
});

test('detectPii finds validated structured PII and skips non-checksum candidates', () => {
  const hits = detectPii('Card 4111 1111 1111 1111, SSN 123-45-6789, email a@b.com, Aadhaar 2995 5670 5675.');
  const types = new Set(hits.map((h) => h.type));
  assert.ok(types.has('credit-card'));
  assert.ok(types.has('ssn'));
  assert.ok(types.has('email'));
  assert.ok(types.has('aadhaar'));
  // A non-Luhn 16-digit number is NOT flagged as a card.
  assert.equal(detectPii('9999888877776665').some((h) => h.type === 'credit-card'), false);
  assert.ok(PII_TYPES.length >= 50, `registry covers ${PII_TYPES.length} structured types`);
  // A UUID's trailing 12 digits must not be mis-flagged as a shorter ID.
  const u = detectPii('ref 123e4567-e89b-42d3-a456-426614174000');
  assert.ok(u.some((h) => h.type === 'uuid') && !u.some((h) => h.type === 'aadhaar'));
});

test('bridge.detect_pii marks structured PII and returns counts by type (no values)', async () => {
  const { api, redactions } = mockApi({ ...piiApi('Pay to card 4111 1111 1111 1111 or email me at x@y.com.') });
  const res = await bridge_(api).callTool('detect_pii', { page: 0 });
  assert.equal(res.ok, true);
  const data = (res as { data: { found: Record<string, number>; marked: number } }).data;
  assert.ok(data.found['credit-card'] >= 1 && data.found['email'] >= 1);
  assert.equal(redactions.length >= 1, true);
  // The PII VALUE must not be echoed back to the model.
  assert.ok(!JSON.stringify(res).includes('4111'));
});

test('bridge.detect_pii with no page scans the WHOLE document and marks each page', async () => {
  const mb = { x: 0, y: 0, width: 612, height: 792 };
  const pages = [
    { pageIndex: 0, width: 612, height: 792, mediaBox: mb, text: 'nothing sensitive here', runs: [oneRun('nothing sensitive here')] },
    { pageIndex: 1, width: 612, height: 792, mediaBox: mb, text: 'Card 4111 1111 1111 1111', runs: [oneRun('Card 4111 1111 1111 1111')] },
    { pageIndex: 2, width: 612, height: 792, mediaBox: mb, text: 'SSN 123-45-6789', runs: [oneRun('SSN 123-45-6789')] },
  ];
  const { api, redactions } = mockApi({ extractAllText: async () => pages });
  const res = await bridge_(api).callTool('detect_pii', {}); // no page → whole doc
  assert.equal(res.ok, true);
  const data = (res as { data: { pages: number; found: Record<string, number>; marked: number } }).data;
  assert.equal(data.pages, 3);
  assert.ok(data.found['credit-card'] >= 1 && data.found['ssn'] >= 1);
  assert.equal(data.marked, 2); // pages 1 and 2 have PII; page 0 doesn't
  assert.deepEqual(redactions.map((r) => r.page).sort(), [1, 2]);
  assert.ok(!JSON.stringify(res).includes('4111')); // values never echoed
});

test('bridge.detect_pii with a types filter scopes to requested PII (e.g. "redact all SSNs")', async () => {
  const { api } = mockApi({ ...piiApi('Card 4111 1111 1111 1111, SSN 123-45-6789, email a@b.com') });
  const res = await bridge_(api).callTool('detect_pii', { page: 0, types: ['ssn'] });
  const data = (res as { data: { found: Record<string, number> } }).data;
  assert.ok(data.found['ssn'] >= 1); // SSN marked
  assert.equal(data.found['credit-card'], undefined); // card NOT over-redacted
  assert.equal(data.found['email'], undefined); // email NOT over-redacted
});

test('bridge.mark_redaction marks a specific phrase (contextual PII)', async () => {
  const { api, redactions } = mockApi({ ...piiApi('Signed by Jane Doe of Acme Corp.') });
  const res = await bridge_(api).callTool('mark_redaction', { page: 0, text: 'Jane Doe' });
  assert.equal(res.ok, true);
  assert.equal((res as { data: { marked: number } }).data.marked, 1);
  assert.equal(redactions.length, 1);
});

// ── form fill (pdf-lib, real bytes) ──────────────────────────────────────────
test('form.ts lists and fills AcroForm fields (real pdf-lib round-trip)', async () => {
  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.create();
  const pageEl = doc.addPage([300, 200]);
  const form = doc.getForm();
  const name = form.createTextField('fullName');
  name.addToPage(pageEl, { x: 20, y: 150, width: 200, height: 20 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(pageEl, { x: 20, y: 120, width: 15, height: 15 });
  const bytes = await doc.save();

  const fields = await listFormFields(bytes);
  assert.ok(fields.some((f) => f.name === 'fullName' && f.type === 'text'));
  assert.ok(fields.some((f) => f.name === 'agree' && f.type === 'checkbox'));

  const res = await fillFormFields(bytes, [
    { name: 'fullName', value: 'Ada Lovelace' },
    { name: 'agree', value: true },
    { name: 'missing', value: 'x' },
  ]);
  assert.deepEqual(res.filled.sort(), ['agree', 'fullName']);
  assert.deepEqual(res.skipped, ['missing']);
  // Reload the filled bytes → the values persisted.
  const after = await listFormFields(res.bytes);
  assert.equal(after.find((f) => f.name === 'fullName')?.value, 'Ada Lovelace');
  assert.equal(after.find((f) => f.name === 'agree')?.value, true);
});

test('bridge.list_form_fields and fill_form route through the API', async () => {
  const { api } = mockApi();
  const b = new PdfOpsBridge(() => api);
  const list = await b.callTool('list_form_fields', {});
  assert.equal((list as { data: { fields: unknown[] } }).data.fields.length, 1);
  const fill = await b.callTool('fill_form', { fields: [{ name: 'fullName', value: 'Ada' }] });
  assert.deepEqual((fill as { data: { filled: string[] } }).data.filled, ['fullName']);
  assert.equal((await b.callTool('fill_form', { fields: [] })).ok, false); // empty → BAD_ARGS
});

// ── transport availability (honest "AI unavailable" state) ───────────────────
test('transport.available() reflects whether a backend is really reachable', () => {
  assert.equal(new DesktopTransport().available(), false); // no Tauri shell in Node/web
  assert.equal(new CollabTransport('ws://host/api/ai').available(), true); // collab configured
  assert.equal(new CollabTransport('').available(), false); // no URL → unavailable
});

test('CollabTransport rejects on server inactivity (no eternal "Thinking…")', async () => {
  // Fake WS that connects but never sends a frame → the idle watchdog must fire.
  class FakeWS {
    private listeners: Record<string, ((ev: unknown) => void)[]> = {};
    constructor() {
      queueMicrotask(() => (this.listeners['open'] ?? []).forEach((cb) => cb({})));
    }
    addEventListener(type: string, cb: (ev: unknown) => void) {
      (this.listeners[type] ??= []).push(cb);
    }
    removeEventListener() {}
    send() {}
    close() {}
  }
  const orig = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS;
  try {
    const t = new CollabTransport('ws://x/api/ai', undefined, 40); // 40ms idle timeout
    await assert.rejects(
      t.call({ model: 'm', system: 's', messages: [], tools: [], max_tokens: 10 } as never),
      /timed out/,
    );
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = orig;
  }
});

// ── citations ────────────────────────────────────────────────────────────────
test('linkifyCitations turns page mentions into clickable page segments', () => {
  const segs = linkifyCitations('See page 3 and pages 5 for details.');
  const pages = segs.filter((s) => s.type === 'page') as { type: 'page'; page: number; label: string }[];
  assert.deepEqual(pages.map((p) => p.page), [3, 5]);
  // plain text → a single text segment
  assert.deepEqual(linkifyCitations('no refs here'), [{ type: 'text', text: 'no refs here' }]);
  // a number BEFORE the word ("3 pages") is not a citation
  assert.ok(linkifyCitations('has 3 pages total').every((s) => s.type === 'text'));
  // a range "pages 3-5" is one clickable segment to the first page (no stray "-5")
  const range = linkifyCitations('see pages 3-5 here');
  const rp = range.filter((s) => s.type === 'page') as { type: 'page'; page: number; label: string }[];
  assert.equal(rp.length, 1);
  assert.equal(rp[0].page, 3);
  assert.equal(rp[0].label, 'pages 3-5');
  assert.ok(!range.some((s) => s.type === 'text' && /-5/.test(s.text))); // range fully consumed
});

// ── bridge ────────────────────────────────────────────────────────────────────
test('bridge.search_document retrieves relevant passages with page numbers', async () => {
  const { api } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  const res = await bridge.callTool('search_document', { query: 'invoice total for Acme' });
  assert.equal(res.ok, true);
  const data = (res as { data: { results: { page: number; text: string }[]; retrieval: string } }).data;
  assert.ok(data.results.length >= 1);
  assert.equal(data.results[0].page, 2); // the invoice page ranks first
  assert.equal(data.retrieval, 'bm25'); // no embedder on the mock → lexical
  assert.equal((await bridge.callTool('search_document', {})).ok, false); // missing query
  // With an embedder, the bridge reports hybrid retrieval.
  const withEmb = mockApi({ embedTexts: async (t: string[]) => t.map(() => [1, 0]) });
  const hy = await new PdfOpsBridge(() => withEmb.api).callTool('search_document', { query: 'invoice' });
  assert.equal((hy as { data: { retrieval: string } }).data.retrieval, 'hybrid');
});

// ── bridge ────────────────────────────────────────────────────────────────────
test('bridge.get_document_info returns page count + outline', async () => {
  const { api } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  const res = await bridge.callTool('get_document_info', {});
  assert.deepEqual(res, { ok: true, data: { pageCount: 3, outline: [{ title: 'Intro', pageIndex: 0, children: [] }] } });
});

test('bridge.get_document_text returns whole-doc text with page markers (summaries) + truncates', async () => {
  const { api } = mockApi();
  const res = await new PdfOpsBridge(() => api).callTool('get_document_text', {});
  assert.equal(res.ok, true);
  const data = (res as { data: { pages: number; pagesIncluded: number; truncated: boolean; text: string } }).data;
  assert.equal(data.pages, 3);
  assert.ok(/\[Page 1\]/.test(data.text) && /\[Page 3\]/.test(data.text)); // page markers
  assert.ok(/mitochondria/i.test(data.text)); // ACTUAL content, not just structure
  assert.equal(data.truncated, false);
  // Long pages + a tight budget → truncates and includes fewer pages.
  const long = 'x'.repeat(700);
  const big = mockApi({
    extractAllText: async () => [0, 1, 2].map((i) => ({ pageIndex: i, width: 612, height: 792, mediaBox: { x: 0, y: 0, width: 612, height: 792 }, text: long, runs: [] })),
  });
  const r2 = await new PdfOpsBridge(() => big.api).callTool('get_document_text', { maxChars: 1000 });
  const d2 = (r2 as { data: { truncated: boolean; pagesIncluded: number } }).data;
  assert.equal(d2.truncated, true);
  assert.ok(d2.pagesIncluded < 3);
});

test('bridge.get_page_text reads a page', async () => {
  const { api } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  const res = await bridge.callTool('get_page_text', { page: 1 });
  assert.deepEqual(res, { ok: true, data: { page: 1, text: 'Mitochondria produce ATP on page 1.', width: 612, height: 792 } });
});

test('bridge.get_page_text rejects out-of-range and bad args', async () => {
  const { api } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  assert.equal((await bridge.callTool('get_page_text', { page: 9 })).ok, false);
  assert.equal((await bridge.callTool('get_page_text', { page: -1 })).ok, false);
  assert.equal((await bridge.callTool('get_page_text', {})).ok, false);
});

test('bridge.goto_page navigates', async () => {
  const { api, gotos } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  const res = await bridge.callTool('goto_page', { page: 2 });
  assert.deepEqual(res, { ok: true, data: { page: 2 } });
  assert.deepEqual(gotos, [2]);
});

test('bridge rejects unknown tool and no-document', async () => {
  const { api } = mockApi();
  assert.equal((await new PdfOpsBridge(() => api).callTool('frobnicate', {})).ok, false);
  const none = await new PdfOpsBridge(() => null).callTool('get_document_info', {});
  assert.equal(none.ok, false);
});

// ── agent loop: streaming + processing indicator + tool execution ────────────

/** Fake transport (drivesLoop=false) scripted to: round 1 → stream text + a
 *  tool_use(get_document_info); round 2 → stream the final answer + end_turn. */
class FakeTransport implements DocOpsTransport {
  readonly requiresApiKey = false;
  readonly drivesLoop = false;
  readonly label = 'Fake';
  calls = 0;
  async call(payload: LlmCallPayload): Promise<LlmCallResult> {
    this.calls += 1;
    if (this.calls === 1) {
      payload.onText?.('Let me check. ');
      return {
        data: {
          content: [
            { type: 'text', text: 'Let me check. ' },
            { type: 'tool_use', id: 'tu1', name: 'get_document_info', input: {} },
          ],
          stop_reason: 'tool_use',
        },
        status: 200,
      };
    }
    // Round 2: the tool_result is now in payload.messages — assert the loop fed it back.
    const lastUser = payload.messages[payload.messages.length - 1];
    assert.equal(lastUser.role, 'user');
    assert.equal(lastUser.content[0].type, 'tool_result');
    payload.onText?.('You have 3 pages.');
    return { data: { content: [{ type: 'text', text: 'You have 3 pages.' }], stop_reason: 'end_turn' }, status: 200 };
  }
}

test('runDocOpsTurn streams, toggles the processing indicator, and runs the tool', async () => {
  const { api } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  const transport = new FakeTransport();

  const busy: boolean[] = [];
  const streamed: string[] = [];
  const toolsCalled: string[] = [];

  const result = await runDocOpsTurn({
    transport,
    model: 'claude-opus-4-8',
    system: PDF_SYSTEM_PROMPT,
    userText: 'How many pages?',
    tools: PDF_CATALOG,
    bridge,
    callbacks: {
      onBusy: (b) => busy.push(b),
      onText: (t) => streamed.push(t),
      onToolStart: (n) => toolsCalled.push(n),
    },
  });

  // Processing indicator: on, then off exactly once.
  assert.deepEqual(busy, [true, false]);
  // Streaming: both text chunks arrived live, in order.
  assert.deepEqual(streamed, ['Let me check. ', 'You have 3 pages.']);
  // The tool actually ran through the bridge.
  assert.deepEqual(toolsCalled, ['get_document_info']);
  // Final answer + two model rounds.
  assert.equal(result.answer, 'Let me check. You have 3 pages.');
  assert.equal(transport.calls, 2);
  // History ends with the final assistant answer.
  const last = result.history[result.history.length - 1];
  assert.equal(last.role, 'assistant');
  assert.equal(last.content[0].text, 'You have 3 pages.');
});

test('runDocOpsTurn rejects on abort and still clears the processing indicator', async () => {
  const { api } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  const controller = new AbortController();
  const abortTransport = {
    drivesLoop: true,
    label: 'Abort',
    async call(payload: LlmCallPayload): Promise<LlmCallResult> {
      controller.abort(); // user hit Stop mid-turn
      if (payload.signal?.aborted) throw Object.assign(new Error('AbortError'), { name: 'AbortError' });
      return { data: { ok: true }, status: 200, updatedHistory: [] };
    },
  } as DocOpsTransport;
  const busy: boolean[] = [];
  await assert.rejects(
    runDocOpsTurn({
      transport: abortTransport,
      model: 'm',
      system: 's',
      userText: 'hi',
      tools: PDF_CATALOG,
      bridge,
      signal: controller.signal,
      callbacks: { onBusy: (b) => busy.push(b) },
    }),
    /AbortError/,
  );
  assert.deepEqual(busy, [true, false]); // indicator cleared on abort
});

test('runDocOpsTurn clears the processing indicator even on transport error', async () => {
  const { api } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  const errTransport: DocOpsTransport = {
    requiresApiKey: false,
    drivesLoop: false,
    label: 'Err',
    async call() {
      return { data: { error: { message: 'boom' } }, status: 500 };
    },
  };
  const busy: boolean[] = [];
  let errMsg = '';
  await assert.rejects(
    runDocOpsTurn({
      transport: errTransport,
      model: 'm',
      system: 's',
      userText: 'hi',
      tools: PDF_CATALOG,
      bridge,
      callbacks: { onBusy: (b) => busy.push(b), onError: (m) => (errMsg = m) },
    }),
    /boom/,
  );
  assert.deepEqual(busy, [true, false]); // indicator cleared despite the error
  assert.equal(errMsg, 'boom');
});
