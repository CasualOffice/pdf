// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-side signature verification — the counterpart to sign.ts.
 *
 * The app can *create* PKCS#7 signatures (sign.ts); this parses and VERIFIES the
 * signatures already in a PDF so the UI can show real details (signer, issuer,
 * validity, signing time) and a trustworthy verdict instead of a cosmetic
 * "byte-scan says /ByteRange exists → Signed" badge.
 *
 * For each signature dictionary it:
 *   1. reads the /ByteRange and reconstructs the exact bytes that were signed
 *      (everything except the /Contents hex placeholder),
 *   2. parses the detached PKCS#7/CMS from /Contents (node-forge, BSD-3 — already
 *      the signing dep),
 *   3. verifies the content digest (messageDigest attribute == hash of the signed
 *      bytes → the document is intact since signing) AND the signature over the
 *      signed attributes (→ the holder of the cert's key produced it),
 *   4. extracts the signer certificate details, and flags self-signed identities
 *      (valid signature, but issuer not in any trust store) and whether the
 *      signature covers the whole file (else content was appended after signing).
 *
 * node-forge is heavy (~85 KB gz) so this ships as the lazy `@casualoffice/pdf/
 * verify` subpath and dynamic-imports forge, exactly like sign.ts.
 */

export interface SignatureInfo {
  /** 1-based index of the signature in the file (first found = 1). */
  index: number;
  /** Signer certificate subject Common Name (falls back to O/OU/email). */
  signerName: string;
  /** Issuer Common Name (who vouched for the signer). */
  issuerName: string;
  /** Certificate serial number (hex). */
  serialNumber: string;
  /** Certificate validity window (ISO strings). */
  certValidFrom: string;
  certValidTo: string;
  /** Signing time from the PKCS#7 signingTime attribute (ISO), or null. */
  signedAt: string | null;
  /** Optional PDF signature-dictionary fields. */
  reason: string | null;
  location: string | null;
  contactName: string | null;
  /** Digest algorithm used (e.g. "SHA-256"). */
  digestAlgorithm: string;
  /** The signed content's hash matches the messageDigest attribute → the bytes
   *  covered by this signature are unchanged since it was applied. */
  digestValid: boolean;
  /** The signature over the signed attributes verifies under the signer's public
   *  key → produced by the key holder. */
  signatureValid: boolean;
  /** Issuer == subject → the identity is not vouched for by any CA (the signature
   *  can still be cryptographically valid; a verifier just can't trust *who*). */
  selfSigned: boolean;
  /** The ByteRange covers the whole file → nothing was appended after signing.
   *  If false, later revisions changed the document after this signature. */
  coversWholeDocument: boolean;
  /** True cert-not-expired-at-verification (informational). */
  certCurrentlyValid: boolean;
  /** Overall: cryptographically intact (digest + signature both valid). Trust of
   *  the *identity* is separate (see selfSigned). */
  valid: boolean;
}

/** Find every `/ByteRange [a b c d]` in the file with its byte offset. */
function findByteRanges(latin1: string): { a: number; b: number; c: number; d: number; at: number }[] {
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const out: { a: number; b: number; c: number; d: number; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin1))) {
    out.push({ a: +m[1], b: +m[2], c: +m[3], d: +m[4], at: m.index });
  }
  return out;
}

/** The /Contents hex for a ByteRange sits in the gap between its two segments
 *  (from a+b up to c). Read the `<...>` hex string there. */
function readContentsHex(latin1: string, a: number, b: number, c: number): string | null {
  const gap = latin1.slice(a + b, c + 1);
  const lt = gap.indexOf('<');
  const gt = gap.indexOf('>', lt + 1);
  if (lt < 0 || gt < 0) return null;
  return gap.slice(lt + 1, gt).replace(/[^0-9a-fA-F]/g, '');
}

/** Pull an optional `/Key (literal)` or `/Key <hex>` string from the signature
 *  dictionary region (a small window before the ByteRange). Best-effort. */
function readDictString(dict: string, key: string): string | null {
  const lit = new RegExp(`/${key}\\s*\\(((?:[^()\\\\]|\\\\.)*)\\)`).exec(dict);
  if (lit) return lit[1].replace(/\\([()\\])/g, '$1');
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mdForOid(forge: any, oid: string): { md: any; label: string } | null {
  const map: Record<string, [() => unknown, string]> = {
    '1.3.14.3.2.26': [forge.md.sha1.create, 'SHA-1'],
    '2.16.840.1.101.3.4.2.1': [forge.md.sha256.create, 'SHA-256'],
    '2.16.840.1.101.3.4.2.2': [forge.md.sha384.create, 'SHA-384'],
    '2.16.840.1.101.3.4.2.3': [forge.md.sha512.create, 'SHA-512'],
  };
  const e = map[oid];
  return e ? { md: e[0](), label: e[1] } : null;
}

/** ISO string from a Date, or null if it's missing/invalid (never throws). */
function isoSafe(d: Date | null | undefined): string | null {
  return d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function certCN(name: any): string {
  const field = (t: string) => name.getField(t)?.value as string | undefined;
  return field('CN') || field('O') || field('OU') || field('E') || field('emailAddress') || '(unnamed)';
}

/** Parse and verify all signatures in a PDF. Returns [] if none. */
export async function verifyPdfSignatures(pdf: Uint8Array): Promise<SignatureInfo[]> {
  const forge = (await import('node-forge')).default;
  const latin1 = new TextDecoder('latin1').decode(pdf);
  const ranges = findByteRanges(latin1);
  const results: SignatureInfo[] = [];

  for (let i = 0; i < ranges.length; i++) {
    const { a, b, c, d, at } = ranges[i];
    const hex = readContentsHex(latin1, a, b, c);
    if (!hex) continue;

    // Signed bytes = segment 1 (a..a+b) + segment 2 (c..c+d), i.e. the whole file
    // except the /Contents hex placeholder.
    const signed = new Uint8Array(b + d);
    signed.set(pdf.subarray(a, a + b), 0);
    signed.set(pdf.subarray(c, c + d), b);
    // Feed forge a byte-exact 1:1 binary string. NOT TextDecoder('latin1') — the
    // WHATWG "latin1" label decodes as windows-1252 in browsers (0x80–0x9F remap
    // to other code points), which corrupts the hash input for binary PDF bytes.
    const signedBin = forge.util.binary.raw.encode(signed);
    const coversWholeDocument = c + d >= pdf.length - 2; // trailing EOL tolerance

    // Signature-dictionary strings live just before the ByteRange.
    const dict = latin1.slice(Math.max(0, at - 800), at + 400);

    try {
      const der = forge.util.hexToBytes(hex);
      // The /Contents placeholder is zero-padded well past the actual DER, so
      // allow trailing bytes (parseAllBytes:false) instead of erroring on them.
      // @ts-expect-error node-forge accepts an options object at runtime; the
      // bundled @types only declare the legacy boolean `strict` parameter.
      const asn1 = forge.asn1.fromDer(der, { strict: false, parseAllBytes: false });
      // forge's union type doesn't surface `.certificates`/`.rawCapture` on the
      // SignedData branch — access via `any` (the runtime shape is correct).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p7 = forge.pkcs7.messageFromAsn1(asn1) as any;
      const cert = p7.certificates?.[0];
      const cap = p7.rawCapture;
      if (!cert || !cap) continue;

      const digOid = forge.asn1.derToOid(cap.digestAlgorithm);
      const dig = mdForOid(forge, digOid);

      // (1) content digest: hash the signed bytes, compare to messageDigest attr.
      let digestValid = false;
      let signedAt: string | null = null;
      const attrs = cap.authenticatedAttributes || [];
      if (dig) {
        dig.md.update(signedBin);
        const computed = dig.md.digest().getBytes();
        for (const attr of attrs) {
          const oid = forge.asn1.derToOid(attr.value[0].value);
          if (oid === forge.pki.oids.messageDigest) {
            digestValid = attr.value[1].value[0].value === computed;
          } else if (oid === forge.pki.oids.signingTime) {
            // forge captures the raw ASN.1 time (UTCTime/GeneralizedTime) as a
            // string like "260704120000Z" — parse it with forge, not new Date().
            const t = attr.value[1].value[0];
            try {
              const dt =
                t.type === forge.asn1.Type.UTCTIME
                  ? forge.asn1.utcTimeToDate(t.value)
                  : forge.asn1.generalizedTimeToDate(t.value);
              signedAt = isoSafe(dt);
            } catch {
              /* leave signedAt null */
            }
          }
        }
      }

      // (2) signature over the signed attributes (rebuilt as an explicit DER SET).
      let signatureValid = false;
      if (dig && attrs.length && cap.signature) {
        const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
        const attrMd = mdForOid(forge, digOid)!.md;
        attrMd.update(forge.asn1.toDer(set).getBytes());
        try {
          signatureValid = cert.publicKey.verify(attrMd.digest().getBytes(), cap.signature);
        } catch {
          signatureValid = false;
        }
      }

      const subjectDer = forge.asn1.toDer(forge.pki.distinguishedNameToAsn1(cert.subject)).getBytes();
      const issuerDer = forge.asn1.toDer(forge.pki.distinguishedNameToAsn1(cert.issuer)).getBytes();
      const now = Date.now();

      results.push({
        index: i + 1,
        signerName: certCN(cert.subject),
        issuerName: certCN(cert.issuer),
        serialNumber: cert.serialNumber,
        certValidFrom: isoSafe(cert.validity.notBefore) ?? '',
        certValidTo: isoSafe(cert.validity.notAfter) ?? '',
        signedAt,
        reason: readDictString(dict, 'Reason'),
        location: readDictString(dict, 'Location'),
        contactName: readDictString(dict, 'Name'),
        digestAlgorithm: dig?.label || digOid,
        digestValid,
        signatureValid,
        selfSigned: subjectDer === issuerDer,
        coversWholeDocument,
        certCurrentlyValid: now >= cert.validity.notBefore.getTime() && now <= cert.validity.notAfter.getTime(),
        valid: digestValid && signatureValid,
      });
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[verify] signature parse failed:', e);
      // Unparseable signature — surface it as present-but-unverifiable.
      results.push({
        index: i + 1,
        signerName: '(unreadable)',
        issuerName: '',
        serialNumber: '',
        certValidFrom: '',
        certValidTo: '',
        signedAt: null,
        reason: null,
        location: null,
        contactName: null,
        digestAlgorithm: '',
        digestValid: false,
        signatureValid: false,
        selfSigned: false,
        coversWholeDocument: false,
        certCurrentlyValid: false,
        valid: false,
      });
    }
  }
  return results;
}
