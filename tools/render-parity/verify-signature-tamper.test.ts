// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// The signature verifier's CORE SECURITY GUARANTEE (UX-S2): a genuine signature
// verifies as valid, and ANY modification to the signed bytes makes it INVALID.
// The existing signature E2Es only cover the positive path (a real signature
// reads as valid + OpenSSL agrees) — a regression that broke digest-checking
// (e.g. `digestValid` hard-wired true) would pass them all while silently
// accepting tampered documents. This drives the negative path headlessly.
//
//   node --experimental-transform-types --test tools/render-parity/verify-signature-tamper.test.ts
//
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSelfSignedP12, signPdfWithP12 } from '../../packages/pdf-sdk/src/sign.ts';
import { verifyPdfSignatures } from '../../packages/pdf-sdk/src/verify.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('the verifier accepts a genuine signature and REJECTS a tampered document', async () => {
  // Sign a REAL PDF (the sample fixture — @signpdf's plain placeholder needs a
  // traditional xref, which app-signed real PDFs have) with a fresh self-signed
  // identity. All headless: WebCrypto + forge + @signpdf, no browser.
  const base = new Uint8Array(readFileSync(resolve(here, 'fixtures/sample.pdf')));
  const p12 = Uint8Array.from(Buffer.from(await buildSelfSignedP12('Test Signer'), 'base64'));
  const signed = await signPdfWithP12(base, p12, 'casual-pdf', { signerName: 'Test Signer' });

  // ── genuine signature → valid, digest matches, self-signed ──────────────────
  const [sig] = await verifyPdfSignatures(signed);
  assert.ok(sig, 'a signature is found in the signed PDF');
  assert.equal(sig.digestValid, true, 'content digest matches (document intact)');
  assert.equal(sig.signatureValid, true, 'signature is cryptographically valid');
  assert.equal(sig.valid, true, 'overall verdict: valid');
  assert.equal(sig.selfSigned, true, 'self-signed identity flagged');
  assert.equal(sig.signerName, 'Test Signer', 'signer name read from the cert');

  // ── tamper: flip a bit inside the SIGNED content (the original PDF body sits at
  //    the start of the file = the first ByteRange segment). The verifier MUST now
  //    report the document as altered. ─────────────────────────────────────────
  const tampered = signed.slice();
  const flipAt = Math.floor(base.length / 2); // squarely inside the signed body
  tampered[flipAt] ^= 0xff;
  const [tsig] = await verifyPdfSignatures(tampered);
  assert.ok(tsig, 'the signature is still present after tampering');
  assert.equal(tsig.digestValid, false, 'TAMPERED: content digest no longer matches');
  assert.equal(tsig.valid, false, 'TAMPERED: overall INVALID — the core security guarantee holds');
});
