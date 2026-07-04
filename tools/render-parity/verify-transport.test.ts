// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the provider-flexible DocOps transport (Anthropic / Ollama /
// OpenAI-compatible / collab / desktop). Runs the pure wire-translation logic
// and the streaming SSE parser with no browser — fast, deterministic.
//
//   node --experimental-strip-types --test tools/render-parity/verify-transport.test.ts
//
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toOpenAIMessages,
  toOpenAITools,
  fromOpenAIMessage,
  parseOpenAiSse,
  createDocOpsTransport,
} from '../../packages/pdf-sdk/src/ai/transport.ts';

// ── outgoing translation: Anthropic blocks → OpenAI chat ─────────────────────

test('toOpenAITools maps Anthropic tool defs to OpenAI function tools', () => {
  const out = toOpenAITools([
    { name: 'find_in_pdf', description: 'search', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  ]);
  assert.deepEqual(out, [
    {
      type: 'function',
      function: { name: 'find_in_pdf', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
    },
  ]);
});

test('toOpenAITools returns undefined for empty tools', () => {
  assert.equal(toOpenAITools([]), undefined);
  assert.equal(toOpenAITools(undefined as unknown as unknown[]), undefined);
});

test('toOpenAIMessages translates system + text + tool_use + tool_result', () => {
  const msgs = [
    { role: 'user', content: 'Summarize page 1' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Let me look' },
      { type: 'tool_use', id: 't1', name: 'get_page_text', input: { page: 0 } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Hello world' }] },
  ];
  const out = toOpenAIMessages('You are helpful', msgs);
  assert.deepEqual(out[0], { role: 'system', content: 'You are helpful' });
  assert.deepEqual(out[1], { role: 'user', content: 'Summarize page 1' });
  assert.deepEqual(out[2], {
    role: 'assistant',
    content: 'Let me look',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_page_text', arguments: '{"page":0}' } }],
  });
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 't1', content: 'Hello world' });
});

test('toOpenAIMessages omits the system message when system is empty', () => {
  const out = toOpenAIMessages('', [{ role: 'user', content: 'hi' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});

// ── incoming translation: OpenAI message → Anthropic blocks ──────────────────

test('fromOpenAIMessage builds tool_use blocks and tool_use stop_reason', () => {
  const { content, stop_reason } = fromOpenAIMessage(
    { content: 'Done', tool_calls: [{ id: 'c1', function: { name: 'foo', arguments: '{"a":1}' } }] },
    'tool_calls',
  );
  assert.deepEqual(content[0], { type: 'text', text: 'Done' });
  assert.deepEqual(content[1], { type: 'tool_use', id: 'c1', name: 'foo', input: { a: 1 } });
  assert.equal(stop_reason, 'tool_use');
});

test('fromOpenAIMessage on plain text → end_turn', () => {
  const { content, stop_reason } = fromOpenAIMessage({ content: 'Just text' }, 'stop');
  assert.deepEqual(content, [{ type: 'text', text: 'Just text' }]);
  assert.equal(stop_reason, 'end_turn');
});

test('fromOpenAIMessage tolerates malformed tool arguments (empty input)', () => {
  const { content } = fromOpenAIMessage({ tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{bad' } }] }, 'tool_calls');
  assert.deepEqual(content[0], { type: 'tool_use', id: 'c', name: 'x', input: {} });
});

// ── streaming: OpenAI SSE → Anthropic blocks, with buffer-split robustness ────

function chunkedSseStream(sse: string, chunkSize: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const bytes = enc.encode(sse);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}

test('parseOpenAiSse streams text + assembles a fragmented tool call', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"find_in_pdf","arguments":"{\\"query\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cat\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
    'data: [DONE]',
    '',
  ].join('\n');

  // 7-byte chunks split events mid-line — exercises the reassembly buffer.
  const seen: string[] = [];
  const { content, stop_reason } = await parseOpenAiSse(chunkedSseStream(sse, 7), (t) => seen.push(t));

  assert.equal(seen.join(''), 'Hello');
  assert.deepEqual(content[0], { type: 'text', text: 'Hello' });
  assert.deepEqual(content[1], { type: 'tool_use', id: 'call_1', name: 'find_in_pdf', input: { query: 'cat' } });
  assert.equal(stop_reason, 'tool_use');
});

// ── factory: user provider choice → correct transport ────────────────────────

test('createDocOpsTransport selects the provider the user picked', () => {
  const anth = createDocOpsTransport({ provider: 'anthropic' });
  assert.equal(anth.label, 'Anthropic');
  assert.equal(anth.requiresApiKey, true);
  assert.equal(anth.drivesLoop, false);

  const ollama = createDocOpsTransport({ provider: 'ollama' });
  assert.equal(ollama.label, 'Ollama (local)');
  assert.equal(ollama.requiresApiKey, false);
  assert.equal(ollama.drivesLoop, false);

  const openai = createDocOpsTransport({ provider: 'openai' });
  assert.equal(openai.label, 'OpenAI-compatible');
  assert.equal(openai.requiresApiKey, true);

  const collab = createDocOpsTransport({ provider: 'collab', collabWsUrl: 'wss://h/yjs' });
  assert.equal(collab.label, 'Collab server');
  assert.equal(collab.drivesLoop, true);

  const desktop = createDocOpsTransport({ provider: 'desktop' });
  assert.equal(desktop.label, 'Local (desktop)');
  assert.equal(desktop.drivesLoop, true);

  // auto with no desktop shell + no window (node) → Anthropic
  const auto = createDocOpsTransport({ provider: 'auto' });
  assert.equal(auto.label, 'Anthropic');
});
