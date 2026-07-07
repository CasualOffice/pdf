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
  markDeclined,
  voidEnvelope,
  readEnvelope,
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
