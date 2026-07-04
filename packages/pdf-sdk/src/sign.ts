// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Certified PDF signing — a real, verifiable cryptographic signature.
 *
 * A stable **self-signed identity** (RSA-2048 key + X.509 certificate) is
 * generated on first use and persisted in the browser, then reused. Signing is
 * done with the in-policy JS stack (@signpdf + node-forge, MIT/BSD-3):
 *   1. @signpdf/placeholder-plain appends a signature field + /ByteRange +
 *      zero-padded /Contents placeholder as an INCREMENTAL update (original
 *      bytes preserved → decision #5 / UX-F2),
 *   2. @signpdf/signer-p12 builds a detached PKCS#7/CMS over the ByteRange and
 *      **embeds the signer certificate** (so any validator — Acrobat, or our own
 *      `@casualoffice/pdf/verify` — can show details and check it).
 *
 * The key is generated with WebCrypto (fast, non-blocking) and handed to forge
 * to build the cert + PKCS#12; forge's synchronous RSA keygen would freeze the
 * UI for seconds, so we avoid it. Self-signed means "cryptographically valid but
 * identity self-asserted" — a verifier trusts the signature, not the name.
 *
 * node-forge + @signpdf are heavy (~90 KB gz); this ships as the lazy
 * `@casualoffice/pdf/sign` subpath.
 */
import forge from 'node-forge';

/** localStorage key prefix — one stable identity per signer name. */
const STORE_PREFIX = 'casualpdf.identity.v1:';
/** Passphrase for the in-browser PKCS#12 (not a security boundary — the p12
 *  never leaves the browser; it just satisfies the p12 container format). */
const PASSPHRASE = 'casual-pdf';

export interface SignPdfOptions {
  pdf: Uint8Array;
  signerName?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
}

function binString(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

function pemFromPkcs8(pkcs8: Uint8Array): string {
  const b64 = forge.util.encode64(binString(pkcs8)).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

/** Build a fresh self-signed identity → base64 PKCS#12. */
async function buildSelfSignedP12(commonName: string): Promise<string> {
  // WebCrypto keygen: fast and off the render path (forge's sync keygen isn't).
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  // forge parses PKCS#8 ("BEGIN PRIVATE KEY") directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const privateKey = forge.pki.privateKeyFromPem(pemFromPkcs8(pkcs8)) as any;
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);

  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  // Random 16-byte positive serial (leading 0 avoids a negative INTEGER).
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  cert.serialNumber = '00' + Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(now.getFullYear() + 10, now.getMonth(), now.getDate());
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'Casual PDF (self-signed)' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
  ]);
  cert.sign(privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], PASSPHRASE, { algorithm: '3des' });
  return forge.util.encode64(forge.asn1.toDer(p12Asn1).getBytes());
}

/** Get (or lazily create + persist) the stable self-signed identity for a name. */
async function getIdentityP12(commonName: string): Promise<Uint8Array> {
  const key = STORE_PREFIX + commonName;
  let b64: string | null = null;
  try {
    b64 = localStorage.getItem(key);
  } catch {
    /* localStorage may be unavailable (private mode) — fall through to ephemeral. */
  }
  if (!b64) {
    b64 = await buildSelfSignedP12(commonName);
    try {
      localStorage.setItem(key, b64);
    } catch {
      /* ignore persistence failure — the identity is still valid for this call. */
    }
  }
  return Uint8Array.from(forge.util.decode64(b64), (c) => c.charCodeAt(0));
}

/** Sign a PDF with the stable self-signed identity and return the signed bytes. */
export async function signPdf({
  pdf,
  signerName = 'Casual PDF Signer',
  reason = 'Signed in Casual PDF',
  location,
  contactInfo,
}: SignPdfOptions): Promise<Uint8Array> {
  const [{ plainAddPlaceholder }, signpdfMod, { P12Signer }] = await Promise.all([
    import('@signpdf/placeholder-plain'),
    import('@signpdf/signpdf'),
    import('@signpdf/signer-p12'),
  ]);
  const signpdf = signpdfMod.default ?? signpdfMod;

  const p12 = await getIdentityP12(signerName);

  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: Buffer.from(pdf),
    reason,
    contactInfo: contactInfo ?? signerName,
    name: signerName,
    location: location ?? '',
    signatureLength: 8192,
  });

  const signer = new P12Signer(Buffer.from(p12), { passphrase: PASSPHRASE });
  const signed = await signpdf.sign(withPlaceholder, signer);
  return new Uint8Array(signed);
}
