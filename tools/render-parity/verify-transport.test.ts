// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the DocOps transport. TWO modes only — desktop (shell) and
// collab (server env). No client-side provider/model config.
//
//   node --experimental-transform-types --test tools/render-parity/verify-transport.test.ts
//
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDocOpsTransport,
  deriveAiWsUrl,
  resolveTauriInvoke,
  DesktopTransport,
  CollabTransport,
} from '../../packages/pdf-sdk/src/ai/transport.ts';

test('deriveAiWsUrl maps a Yjs collab URL to the /api/ai endpoint', () => {
  assert.equal(deriveAiWsUrl('wss://host/yjs'), 'wss://host/api/ai');
  assert.equal(deriveAiWsUrl('ws://host/yjs/'), 'ws://host/api/ai');
  assert.equal(deriveAiWsUrl('wss://host'), 'wss://host/api/ai');
});

test('createDocOpsTransport(desktop) → DesktopTransport', () => {
  const t = createDocOpsTransport({ provider: 'desktop' });
  assert.ok(t instanceof DesktopTransport);
  assert.equal(t.label, 'Local (desktop)');
  assert.equal(t.drivesLoop, true);
});

test('createDocOpsTransport(collab) → CollabTransport', () => {
  const t = createDocOpsTransport({ provider: 'collab', collabWsUrl: 'wss://host/yjs' });
  assert.ok(t instanceof CollabTransport);
  assert.equal(t.label, 'Collab server');
  assert.equal(t.drivesLoop, true);
});

test('createDocOpsTransport(auto) with no shell + no collab → DesktopTransport', () => {
  // In node there is no desktop shell (window undefined) and no collab URL.
  const t = createDocOpsTransport({ provider: 'auto' });
  assert.ok(t instanceof DesktopTransport);
});

test('createDocOpsTransport(auto) with a collab URL (no shell) → CollabTransport', () => {
  const t = createDocOpsTransport({ provider: 'auto', collabWsUrl: 'wss://host/yjs' });
  assert.ok(t instanceof CollabTransport);
});

// ── desktop path: the casual_pdf shell exposes window.__TAURI__.core.invoke ──

test('resolveTauriInvoke finds invoke from __TAURI__.core (withGlobalTauri)', () => {
  (globalThis as any).window = { __TAURI__: { core: { invoke: async () => ({}) } } };
  try {
    assert.equal(typeof resolveTauriInvoke(), 'function');
  } finally {
    delete (globalThis as any).window;
  }
});

test('DesktopTransport surfaces the shell "no model loaded" message (graceful first-run)', async () => {
  // The desktop shell returns a clear, actionable error when no local model is
  // loaded; DesktopTransport must propagate it so the panel shows it (not a crash).
  (globalThis as any).window = {
    __TAURI__: {
      core: {
        invoke: async () => {
          throw 'No local model is loaded. Load a local model in AI settings.';
        },
      },
    },
  };
  try {
    const res = await new DesktopTransport().call({
      model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], max_tokens: 100,
    });
    assert.equal(res.status, 500);
    assert.match(res.data.error.message, /No local model is loaded/);
  } finally {
    delete (globalThis as any).window;
  }
});

test('DesktopTransport routes through docops_llm_call with the { args } wrapper + camelCase maxTokens', async () => {
  const seen: any[] = [];
  (globalThis as any).window = {
    __TAURI__: {
      core: {
        invoke: async (cmd: string, args: any) => {
          seen.push([cmd, args]);
          return { content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' };
        },
      },
    },
  };
  try {
    const streamed: string[] = [];
    const res = await new DesktopTransport().call({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      max_tokens: 100,
      onText: (t) => streamed.push(t),
    });
    assert.equal(seen[0][0], 'docops_llm_call');
    assert.ok(seen[0][1].args, 'payload is wrapped in { args } (Rust command contract)');
    assert.equal(seen[0][1].args.maxTokens, 100, 'camelCase maxTokens matches DocopsLlmArgs');
    assert.equal(streamed.join(''), 'Hello'); // streamed to the panel
    assert.equal(res.status, 200);
  } finally {
    delete (globalThis as any).window;
  }
});
