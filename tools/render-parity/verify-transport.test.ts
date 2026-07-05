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
