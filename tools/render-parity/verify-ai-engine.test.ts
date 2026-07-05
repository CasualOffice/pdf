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
import { chunkPages, rankChunks } from '../../packages/pdf-sdk/src/ai/retrieve.ts';
import { toAnnotationRect, findRunsForText } from '../../packages/pdf-sdk/src/ai/highlight.ts';
import { linkifyCitations } from '../../packages/pdf-sdk/src/ai/cite.ts';
import { runDocOpsTurn } from '../../packages/pdf-sdk/src/ai/loop.ts';
import type { DocOpsTransport, LlmCallPayload, LlmCallResult } from '../../packages/pdf-sdk/src/ai/transport.ts';

// ── mock CasualPdfApi (only the methods the bridge uses) ─────────────────────
function mockApi(over: Record<string, unknown> = {}) {
  const gotos: number[] = [];
  const highlights: { page: number; rects: unknown[] }[] = [];
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
    extractAllText: async () =>
      [
        'The mitochondria is the powerhouse of the cell and produces ATP energy.',
        'Photosynthesis in plants converts sunlight into chemical energy in chloroplasts.',
        'The invoice total is $4,200 due on receipt to Acme Corporation.',
      ].map((text, i) => ({ pageIndex: i, width: 612, height: 792, mediaBox: { x: 0, y: 0, width: 612, height: 792 }, text, runs: [] })),
    ...over,
  };
  return { api: api as any, gotos, highlights };
}

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

// ── citations ────────────────────────────────────────────────────────────────
test('linkifyCitations turns page mentions into clickable page segments', () => {
  const segs = linkifyCitations('See page 3 and pages 5 for details.');
  const pages = segs.filter((s) => s.type === 'page') as { type: 'page'; page: number; label: string }[];
  assert.deepEqual(pages.map((p) => p.page), [3, 5]);
  // plain text → a single text segment
  assert.deepEqual(linkifyCitations('no refs here'), [{ type: 'text', text: 'no refs here' }]);
  // a number BEFORE the word ("3 pages") is not a citation
  assert.ok(linkifyCitations('has 3 pages total').every((s) => s.type === 'text'));
});

// ── bridge ────────────────────────────────────────────────────────────────────
test('bridge.search_document retrieves relevant passages with page numbers', async () => {
  const { api } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  const res = await bridge.callTool('search_document', { query: 'invoice total for Acme' });
  assert.equal(res.ok, true);
  const data = (res as { data: { results: { page: number; text: string }[] } }).data;
  assert.ok(data.results.length >= 1);
  assert.equal(data.results[0].page, 2); // the invoice page ranks first
  assert.equal((await bridge.callTool('search_document', {})).ok, false); // missing query
});

// ── bridge ────────────────────────────────────────────────────────────────────
test('bridge.get_document_info returns page count + outline', async () => {
  const { api } = mockApi();
  const bridge = new PdfOpsBridge(() => api);
  const res = await bridge.callTool('get_document_info', {});
  assert.deepEqual(res, { ok: true, data: { pageCount: 3, outline: [{ title: 'Intro', pageIndex: 0, children: [] }] } });
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
