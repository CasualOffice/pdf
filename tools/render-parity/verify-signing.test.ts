// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the signing-workflow model (signing.ts): envelope lifecycle,
// recipients, parallel vs sequential order (whose-turn gating), status derivation,
// audit log, and peer→peer sync. Deterministic, no browser.
//
//   node --experimental-transform-types --test tools/render-parity/verify-signing.test.ts
//
import test from 'node:test';
import assert from 'node:assert/strict';
import { Y } from '../../packages/pdf-sdk/src/collab-binding.ts';
import { createCasualPdfDoc } from '../../packages/pdf-sdk/src/model.ts';
import {
  createEnvelope,
  addSigner,
  sendEnvelope,
  markViewed,
  markSigned,
  markConsented,
  markDeclined,
  voidEnvelope,
  readEnvelope,
  readEvents,
  recordEvent,
  deriveStatus,
  whoseTurn,
  canSign,
  type Signer,
} from '../../packages/pdf-sdk/src/signing.ts';

function make() {
  return createCasualPdfDoc('base-v1', new Y.Doc());
}

function envelope(model: ReturnType<typeof make>, order: 'parallel' | 'sequential' = 'parallel') {
  createEnvelope(model, { id: 'env1', title: 'NDA', createdBy: 'alice', createdAt: 1, order, docHash: 'abc123' });
  addSigner(model, { id: 's1', name: 'Bob', email: 'bob@x.com', order: 1 });
  addSigner(model, { id: 's2', name: 'Cara', email: 'cara@x.com', order: 2 });
}

test('createEnvelope → draft with a created event + doc hash', () => {
  const m = make();
  envelope(m);
  const e = readEnvelope(m)!;
  assert.equal(e.status, 'draft');
  assert.equal(e.title, 'NDA');
  assert.equal(e.docHash, 'abc123');
  assert.equal(e.signers.length, 2);
  assert.equal(e.events[0].type, 'created', 'audit log opens with created');
});

test('lifecycle: sent → viewed → partially_signed → completed (parallel)', () => {
  const m = make();
  envelope(m, 'parallel');
  sendEnvelope(m, 2);
  assert.equal(readEnvelope(m)!.status, 'sent');
  markViewed(m, 's1', 3);
  assert.equal(readEnvelope(m)!.status, 'viewed');
  markSigned(m, 's1', 4);
  assert.equal(readEnvelope(m)!.status, 'partially_signed', 'one of two signed');
  markSigned(m, 's2', 5);
  const e = readEnvelope(m)!;
  assert.equal(e.status, 'completed', 'all signers signed');
  assert.equal(e.signers.find((s) => s.id === 's1')?.signedAt, 4);
  assert.deepEqual(
    e.events.map((ev) => ev.type),
    ['created', 'sent', 'viewed', 'signed', 'signed'],
    'audit log records every step',
  );
});

test('parallel: both signers may sign immediately; canSign true for both', () => {
  const m = make();
  envelope(m, 'parallel');
  sendEnvelope(m, 2);
  const e = readEnvelope(m)!;
  assert.deepEqual(whoseTurn(e).map((s) => s.id).sort(), ['s1', 's2']);
  assert.equal(canSign(e, 's1'), true);
  assert.equal(canSign(e, 's2'), true);
});

test('sequential: only order-1 may sign until they do (whose-turn gating)', () => {
  const m = make();
  envelope(m, 'sequential');
  sendEnvelope(m, 2);
  let e = readEnvelope(m)!;
  assert.deepEqual(whoseTurn(e).map((s) => s.id), ['s1'], 'only s1 (order 1) can sign');
  assert.equal(canSign(e, 's2'), false, 's2 must wait');
  markSigned(m, 's1', 3);
  e = readEnvelope(m)!;
  assert.deepEqual(whoseTurn(e).map((s) => s.id), ['s2'], 'now s2 can sign');
  assert.equal(canSign(e, 's2'), true);
  markSigned(m, 's2', 4);
  assert.equal(readEnvelope(m)!.status, 'completed');
});

test('decline is terminal for the envelope', () => {
  const m = make();
  envelope(m);
  sendEnvelope(m, 2);
  markSigned(m, 's1', 3);
  markDeclined(m, 's2', 4, 'not authorised');
  const e = readEnvelope(m)!;
  assert.equal(e.status, 'declined');
  assert.equal(canSign(e, 's1'), false, 'no more signing once declined');
  assert.equal(e.events.at(-1)?.type, 'declined');
});

test('void is terminal (unless already completed)', () => {
  const m = make();
  envelope(m);
  sendEnvelope(m, 2);
  voidEnvelope(m, 'alice', 3, 'wrong document');
  assert.equal(readEnvelope(m)!.status, 'voided');
  // A completed envelope cannot be voided.
  const m2 = make();
  envelope(m2);
  sendEnvelope(m2, 2);
  markSigned(m2, 's1', 3);
  markSigned(m2, 's2', 4);
  voidEnvelope(m2, 'alice', 5);
  assert.equal(readEnvelope(m2)!.status, 'completed', 'completed stays completed');
});

test('deriveStatus (pure): cc recipients do not block completion', () => {
  const signers: Signer[] = [
    { id: 'a', name: 'A', email: 'a', role: 'signer', order: 1, status: 'signed' },
    { id: 'b', name: 'B', email: 'b', role: 'cc', order: 2, status: 'pending' },
  ];
  assert.equal(deriveStatus(signers, 'sent'), 'completed', 'only signer roles gate completion');
});

test('envelope + signing syncs peer→peer over a shared Y.Doc', () => {
  const a = make();
  const b = createCasualPdfDoc('base-v1', new Y.Doc());
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
  a.doc.on('update', (u, o) => { if (o !== 'remote') Y.applyUpdate(b.doc, u, 'remote'); });
  b.doc.on('update', (u, o) => { if (o !== 'remote') Y.applyUpdate(a.doc, u, 'remote'); });

  createEnvelope(a, { id: 'env1', title: 'NDA', createdBy: 'alice', createdAt: 1, order: 'sequential' });
  addSigner(a, { id: 's1', name: 'Bob', email: 'bob@x.com', order: 1 });
  sendEnvelope(a, 2);
  markSigned(b, 's1', 3); // Bob signs from the OTHER client

  for (const m of [a, b]) {
    const e = readEnvelope(m)!;
    assert.equal(e.status, 'completed', 'both converge to completed');
    assert.equal(e.signers[0].signedAt, 3, 'signature synced across');
  }
});

test('createEnvelope is idempotent — a second call does not clobber the first', () => {
  const m = make();
  createEnvelope(m, { id: 'env1', title: 'First', createdBy: 'alice', createdAt: 1 });
  addSigner(m, { id: 's1', name: 'Bob', email: 'bob@x.com', order: 1 });
  // A double-click / re-entry must NOT reset the envelope or drop the signer.
  createEnvelope(m, { id: 'env2', title: 'Second', createdBy: 'mallory', createdAt: 2 });
  const e = readEnvelope(m)!;
  assert.equal(e.id, 'env1', 'the first envelope id is preserved');
  assert.equal(e.title, 'First', 'not overwritten by the second create');
  assert.equal(e.signers.length, 1, 'the signer was not clobbered by a fresh signers array');
});

test('M1: the MODEL rejects out-of-turn signing under sequential order (not just the UI)', () => {
  const m = make();
  envelope(m, 'sequential'); // s1 order 1, s2 order 2
  sendEnvelope(m, 2);
  markSigned(m, 's2', 3); // s2 tries to sign before s1
  const e = readEnvelope(m)!;
  assert.equal(e.signers.find((s) => s.id === 's2')?.status, 'pending', 'out-of-turn sign is a model no-op');
  assert.equal(e.status, 'sent', 'status unchanged');
});

test('H2: a concurrent void beats a concurrent sign — terminal wins on BOTH peers', () => {
  const a = make();
  const b = createCasualPdfDoc('base-v1', new Y.Doc());
  createEnvelope(a, { id: 'e', title: 't', createdBy: 'alice', createdAt: 1, order: 'parallel' });
  addSigner(a, { id: 's1', name: 'Bob', email: 'bob@x.com', order: 1 });
  sendEnvelope(a, 2);
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote'); // baseline sync, then DISCONNECT
  // Concurrent, offline: A voids; B signs the last signer.
  voidEnvelope(a, 'alice', 3);
  markSigned(b, 's1', 3);
  // Merge both ways.
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
  for (const m of [a, b]) assert.equal(readEnvelope(m)!.status, 'voided', 'the void (terminal event) wins, not completed');
});

test('M3: readEvents is chronological even when inserted out of timestamp order', () => {
  const m = make();
  createEnvelope(m, { id: 'e', title: 't', createdBy: 'a', createdAt: 100 });
  recordEvent(m, { type: 'viewed', actor: 'x', at: 50 }); // earlier ts, later insertion
  const times = readEvents(m).map((e) => e.at);
  assert.deepEqual(times, [...times].sort((x, y) => x - y), 'events sorted by timestamp');
});

test('L1: addSigner is a no-op once the envelope is sent (no status regression)', () => {
  const m = make();
  envelope(m);
  sendEnvelope(m, 2);
  addSigner(m, { id: 's3', name: 'Late', email: 'late@x.com', order: 3 });
  assert.equal(readEnvelope(m)!.signers.length, 2, 'no signer added after send');
});

test('markConsented records an ESIGN consent event for the signer', () => {
  const m = make();
  envelope(m);
  markConsented(m, 's1', 5);
  const e = readEnvelope(m)!;
  assert.ok(
    e.events.some((ev) => ev.type === 'consented' && ev.actor === 'bob@x.com'),
    'consent event recorded in the audit trail',
  );
});
