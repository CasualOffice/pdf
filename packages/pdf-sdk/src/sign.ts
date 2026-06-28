// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Certified cryptographic signing (PKCS#7 / PAdES-style) for Casual PDF — the
 * "real" digital signature, distinct from the *visible* signature stamp in the
 * viewer chrome. Implemented with the in-policy write-side stack (locked
 * decision #4): @signpdf/signpdf + node-forge, applied as an **incremental
 * update** (append-only, original bytes preserved → decision #5 / gate UX-F2).
 *
 * Two entry points:
 *   • generateSelfSignedP12 — mint an ephemeral self-signed identity in the
 *     browser (signature verifies cryptographically; the signer is "unknown" to
 *     a verifier's trust store, as expected for a self-signed cert).
 *   • signPdf — add a signature placeholder + embed a detached PKCS#7 over the
 *     document byte range, using a PKCS#12 (.p12) identity.
 *
 * Requires a `Buffer` global in the host (the web app provides a polyfill); the
 * @signpdf stack operates on Node Buffers.
 */
import forge from 'node-forge';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';

/** Convert a node-forge binary string to a Uint8Array. */
function binaryStringToBytes(bin: string): Uint8Array {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

export interface SelfSignedOptions {
  /** Common name on the certificate — usually the signer's full name. */
  name: string;
  org?: string;
  country?: string;
  /** Passphrase protecting the generated .p12 (kept in memory only). */
  passphrase: string;
}

/**
 * Mint a self-signed RSA-2048 PKCS#12 identity. Returns the .p12 DER bytes.
 * The resulting signature is cryptographically valid; because the cert is
 * self-signed, a verifier reports "signature valid, signer identity unverified"
 * unless the cert is explicitly trusted.
 */
export function generateSelfSignedP12({ name, org = 'Casual PDF', country = 'US', passphrase }: SelfSignedOptions): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  const now = new Date();
  cert.validity.notBefore = new Date(now.getFullYear() - 1, 0, 1);
  cert.validity.notAfter = new Date(now.getFullYear() + 10, 0, 1);
  const attrs = [
    { name: 'commonName', value: name },
    { name: 'organizationName', value: org },
    { name: 'countryName', value: country },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' });
  return binaryStringToBytes(forge.asn1.toDer(p12Asn1).getBytes());
}

export interface SignPdfOptions {
  /** The PDF to sign (e.g. the current document bytes, annotations baked in). */
  pdf: Uint8Array;
  /** A PKCS#12 (.p12 / .pfx) identity: DER bytes. */
  p12: Uint8Array;
  passphrase: string;
  reason?: string;
  name?: string;
  location?: string;
  contactInfo?: string;
}

/**
 * Embed a certified digital signature. Adds an incremental signature
 * placeholder (append-only) then signs the byte range with a detached PKCS#7
 * (SubFilter adbe.pkcs7.detached). Returns the signed PDF bytes.
 */
export async function signPdf({
  pdf,
  p12,
  passphrase,
  reason = 'I approve this document',
  name = 'Casual PDF Signer',
  location = '',
  contactInfo = '',
}: SignPdfOptions): Promise<Uint8Array> {
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: Buffer.from(pdf),
    reason,
    name,
    location,
    contactInfo,
  });
  const signer = new P12Signer(Buffer.from(p12), { passphrase });
  const signed = await new SignPdf().sign(withPlaceholder, signer);
  return new Uint8Array(signed);
}
