// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the signing certificate render (signing-certificate.ts): the
// completion certificate page is appended and the doc-hash helper is well-formed.
// (Content is spot-checked separately via pymupdf in verify-signing-certificate.mjs
// — this stays a pure Node unit test.)
//
//   node --experimental-transform-types --test tools/render-parity/verify-signing-certificate.test.ts
//
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildCompletionCertificate, computeDocHash } from '../../packages/pdf-sdk/src/signing-certificate.ts';
import type { SigningEnvelope } from '../../packages/pdf-sdk/src/signing.ts';

function sampleEnvelope(): SigningEnvelope {
  return {
    id: 'env-1234abcd',
    title: 'Mutual NDA',
    status: 'completed',
    order: 'sequential',
    createdBy: 'alice@x.com',
    createdAt: 1710000000000,
    docHash: 'deadbeefcafe',
    signers: [
      { id: 's1', name: 'Bob Jones', email: 'bob@x.com', role: 'signer', order: 1, status: 'signed', viewedAt: 1710000100000, signedAt: 1710000200000, authMethod: 'email' },
      { id: 's2', name: 'Cara Lee', email: 'cara@x.com', role: 'cc', order: 2, status: 'pending' },
    ],
    events: [
      { type: 'created', actor: 'alice@x.com', at: 1710000000000 },
      { type: 'sent', actor: 'alice@x.com', at: 1710000050000 },
      { type: 'signed', actor: 'bob@x.com', at: 1710000200000 },
    ],
  };
}

test('buildCompletionCertificate appends a certificate page', async () => {
  const base = await PDFDocument.create();
  base.addPage([300, 300]);
  const out = await buildCompletionCertificate(await base.save(), sampleEnvelope());
  const reloaded = await PDFDocument.load(out);
  assert.equal(reloaded.getPageCount(), 2, 'one certificate page appended to the 1-page base');
});

test('a long audit trail overflows onto more pages (no truncation)', async () => {
  const base = await PDFDocument.create();
  base.addPage([300, 300]);
  const env = sampleEnvelope();
  env.events = Array.from({ length: 120 }, (_, i) => ({ type: 'viewed' as const, actor: `sig${i}@x.com`, at: 1710000000000 + i }));
  const out = await buildCompletionCertificate(await base.save(), env);
  const reloaded = await PDFDocument.load(out);
  assert.ok(reloaded.getPageCount() >= 3, `long log spills to multiple cert pages (${reloaded.getPageCount()})`);
});

test('computeDocHash returns a 64-char sha256 hex', async () => {
  const h = await computeDocHash(new Uint8Array([1, 2, 3, 4]));
  assert.match(h, /^[0-9a-f]{64}$/);
  const h2 = await computeDocHash(new Uint8Array([1, 2, 3, 4]));
  assert.equal(h, h2, 'deterministic');
});
