// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import type { SignatureInfo } from '@casualoffice/pdf/verify';

/**
 * Signature details + verification dialog. Opened from the app-bar signature
 * badge. Runs the real cryptographic verifier (`@casualoffice/pdf/verify`) over
 * the current document bytes and shows, per signature: the verdict (digest +
 * signature both valid), signer/issuer/validity/time, and honest trust caveats
 * (self-signed identity, changes-after-signing).
 */
export function SignatureInfoDialog({
  getBytes,
  onClose,
}: {
  getBytes: () => Promise<Uint8Array | null | undefined>;
  onClose: () => void;
}) {
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading');
  const [sigs, setSigs] = useState<SignatureInfo[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bytes = await getBytes();
        if (!bytes) throw new Error('no-bytes');
        const { verifyPdfSignatures } = await import('@casualoffice/pdf/verify');
        const result = await verifyPdfSignatures(bytes);
        if (alive) { setSigs(result); setState('done'); }
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => { alive = false; };
  }, [getBytes]);

  useEffect(() => { closeRef.current?.focus(); }, [state]);

  const fmt = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString();
  };

  return (
    <div className="dialog__scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog dialog--form"
        role="dialog"
        aria-modal="true"
        aria-label="Signature details"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="signinfo__head">
          <h2 className="dialog__title" style={{ margin: 0 }}>Signature details</h2>
        </div>

        {state === 'loading' && <p className="dialog__body">Verifying signature…</p>}
        {state === 'error' && (
          <p className="dialog__body">Could not read the signature from this document.</p>
        )}
        {state === 'done' && sigs.length === 0 && (
          <p className="dialog__body">No cryptographic signature was found in this document.</p>
        )}

        {state === 'done' && sigs.map((s) => {
          const intact = s.digestValid && s.signatureValid;
          return (
            <div className="signinfo__card" key={s.index}>
              <div className={`signinfo__verdict signinfo__verdict--${intact ? 'ok' : 'bad'}`}>
                <span className="signinfo__verdict-dot" aria-hidden="true" />
                {intact
                  ? 'Signature valid — the document is intact since it was signed'
                  : s.signerName === '(unreadable)'
                    ? 'Signature present but could not be verified'
                    : 'Signature invalid — the content changed after signing'}
              </div>

              <dl className="signinfo__rows">
                <div><dt>Signed by</dt><dd>{s.signerName}</dd></div>
                <div><dt>Issued by</dt><dd>{s.issuerName || '—'}</dd></div>
                <div><dt>Signed at</dt><dd>{fmt(s.signedAt)}</dd></div>
                <div><dt>Algorithm</dt><dd>{s.digestAlgorithm || '—'}</dd></div>
                <div><dt>Certificate</dt><dd>{fmt(s.certValidFrom)} → {fmt(s.certValidTo)}</dd></div>
                <div>
                  <dt>Integrity</dt>
                  <dd>{s.digestValid ? 'Content digest matches' : 'Content digest MISMATCH'}</dd>
                </div>
                <div>
                  <dt>Signature</dt>
                  <dd>{s.signatureValid ? 'Cryptographically valid' : 'Invalid'}</dd>
                </div>
              </dl>

              {s.selfSigned && intact && (
                <p className="signinfo__note">
                  Identity not independently verified — this is a <strong>self-signed</strong> certificate.
                  The signature is cryptographically valid, but no trusted authority vouches for who signed it.
                </p>
              )}
              {!s.coversWholeDocument && s.signerName !== '(unreadable)' && (
                <p className="signinfo__note signinfo__note--warn">
                  This signature does not cover the whole file — the document was modified after it was signed.
                </p>
              )}
              {!s.certCurrentlyValid && s.certValidTo && (
                <p className="signinfo__note signinfo__note--warn">
                  The signing certificate is outside its validity window.
                </p>
              )}
            </div>
          );
        })}

        <div className="signinfo__actions">
          <button ref={closeRef} type="button" className="signdlg__btn signdlg__btn--primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
