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
import { runDocOpsTurn } from '../../packages/pdf-sdk/src/ai/loop.ts';
import type { DocOpsTransport, LlmCallPayload, LlmCallResult } from '../../packages/pdf-sdk/src/ai/transport.ts';

// ── mock CasualPdfApi (only the methods the bridge uses) ─────────────────────
function mockApi(over: Record<string, unknown> = {}) {
  const gotos: number[] = [];
  const api = {
    pageCount: () => 3,
    getOutline: async () => [{ title: 'Intro', pageIndex: 0, children: [] }],
    extractText: async (page: number) => ({
      pageIndex: page,
      width: 612,
      height: 792,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      text: `text of page ${page}`,
      runs: [],
    }),
    gotoPage: (p: number) => gotos.push(p),
    ...over,
  };
  return { api: api as any, gotos };
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
  assert.deepEqual(res, { ok: true, data: { page: 1, text: 'text of page 1', width: 612, height: 792 } });
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
