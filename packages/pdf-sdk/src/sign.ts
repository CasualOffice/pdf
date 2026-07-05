// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Certified PDF signing — a real, verifiable cryptographic signature.
 *
 * A stable **self-signed identity** (RSA-2048 key + X.509 certificate) is
 * generated on first use and persisted, then reused. On the **desktop** shell it
 * is stored in the native OS-keychain vault (encrypted at rest — see
 * `apps/shell/src-tauri/src/vault.rs`), reached via `window.__deskApp__`. On the
 * **web** build it lives in IndexedDB (off the synchronous localStorage surface).
 * A one-time migration lifts any legacy `localStorage` identity into the new
 * store and wipes the plaintext copy. Signing is
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

/** Legacy localStorage key prefix — the pre-vault web identity store. Retained
 *  only to migrate an existing identity into the native vault / IndexedDB. */
const STORE_PREFIX = 'casualpdf.identity.v1:';
/** IndexedDB store for the web build (survives a localStorage clear; async). */
const IDB_NAME = 'casualpdf-identity';
const IDB_STORE = 'p12';
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

/** Build a fresh self-signed identity → base64 PKCS#12. Node + browser (WebCrypto).
 *  Exported so headless callers (the MCP server) can mint a throwaway identity. */
export async function buildSelfSignedP12(commonName: string): Promise<string> {
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

function decodeP12(b64: string): Uint8Array {
  return Uint8Array.from(forge.util.decode64(b64), (c) => c.charCodeAt(0));
}

/** Read the legacy browser-localStorage identity for a name (pre-vault). */
function readLegacyIdentity(commonName: string): string | null {
  try {
    return localStorage.getItem(STORE_PREFIX + commonName);
  } catch {
    return null;
  }
}
/** Wipe the legacy plaintext identity once it has been migrated. */
function clearLegacyIdentity(commonName: string): void {
  try {
    localStorage.removeItem(STORE_PREFIX + commonName);
  } catch {
    /* ignore */
  }
}

// ── Web fallback: IndexedDB ─────────────────────────────────────────────────
function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}
async function idbGet(commonName: string): Promise<string | null> {
  const db = await idbOpen();
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(commonName);
      r.onsuccess = () => resolve((r.result as string | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
async function idbPut(commonName: string, b64: string): Promise<void> {
  const db = await idbOpen();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(b64, commonName);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Get (or lazily create + persist) the stable self-signed identity for a name.
 *
 * Desktop → native OS-keychain vault (`window.__deskApp__`). Web → IndexedDB,
 * falling back to localStorage only when IndexedDB is unavailable (private mode).
 * Either path migrates a legacy `localStorage` identity in on first use and
 * wipes the plaintext copy.
 */
async function getIdentityP12(commonName: string): Promise<Uint8Array> {
  // Desktop: native, encrypted-at-rest OS keychain.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const desk = (globalThis as any).__deskApp__;
  if (desk?.identityGet && desk?.identitySet) {
    let b64: string | null = null;
    try {
      b64 = await desk.identityGet(commonName);
    } catch {
      b64 = null;
    }
    if (!b64) {
      b64 = readLegacyIdentity(commonName) ?? (await buildSelfSignedP12(commonName));
      try {
        await desk.identitySet(commonName, b64);
        clearLegacyIdentity(commonName); // migrated into the keychain
      } catch {
        /* vault write failed — the identity is still valid for this call. */
      }
    }
    return decodeP12(b64);
  }

  // Web: IndexedDB, migrating from the legacy localStorage key if present.
  const existing = await idbGet(commonName).catch(() => null);
  if (existing) return decodeP12(existing);

  const b64 = readLegacyIdentity(commonName) ?? (await buildSelfSignedP12(commonName));
  try {
    await idbPut(commonName, b64);
    clearLegacyIdentity(commonName); // migrated into IndexedDB → drop plaintext
  } catch {
    // IndexedDB unavailable (private mode) — keep it in localStorage so it persists.
    try {
      localStorage.setItem(STORE_PREFIX + commonName, b64);
    } catch {
      /* ephemeral — still valid for this call. */
    }
  }
  return decodeP12(b64);
}

/** Sign a PDF with the stable self-signed identity and return the signed bytes. */
/**
 * Sign a PDF with a caller-supplied PKCS#12 identity (bytes + passphrase) as an
 * incremental update. The in-policy JS core (@signpdf + node-forge); no vault, no
 * DOM — usable from Node (the MCP server) or the browser. `signPdf` below wraps
 * this with the web vault identity.
 */
export async function signPdfWithP12(
  pdf: Uint8Array,
  p12: Uint8Array,
  passphrase: string,
  opts: { signerName?: string; reason?: string; location?: string; contactInfo?: string } = {},
): Promise<Uint8Array> {
  const [{ plainAddPlaceholder }, signpdfMod, { P12Signer }] = await Promise.all([
    import('@signpdf/placeholder-plain'),
    import('@signpdf/signpdf'),
    import('@signpdf/signer-p12'),
  ]);
  // Construct a signer from the SignPdf class — resolves across ESM/CJS interop
  // (the browser bundle vs raw Node, where the ready instance is buried).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = signpdfMod as any;
  const SignPdf = mod.SignPdf ?? mod.default?.SignPdf;
  const signpdf = SignPdf ? new SignPdf() : (mod.default?.default ?? mod.default ?? mod);
  const signerName = opts.signerName ?? 'Casual PDF Signer';

  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: Buffer.from(pdf),
    reason: opts.reason ?? 'Signed in Casual PDF',
    contactInfo: opts.contactInfo ?? signerName,
    name: signerName,
    location: opts.location ?? '',
    signatureLength: 8192,
  });

  const signer = new P12Signer(Buffer.from(p12), { passphrase });
  const signed = await signpdf.sign(withPlaceholder, signer);
  return new Uint8Array(signed);
}

export async function signPdf({
  pdf,
  signerName = 'Casual PDF Signer',
  reason = 'Signed in Casual PDF',
  location,
  contactInfo,
}: SignPdfOptions): Promise<Uint8Array> {
  const p12 = await getIdentityP12(signerName);
  return signPdfWithP12(pdf, p12, PASSPHRASE, { signerName, reason, location, contactInfo });
}
