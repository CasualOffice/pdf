// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Icon, type CasualPdfApi } from '@casualoffice/pdf';

/**
 * Certified digital-signing dialog (UX-S2). Collects signer details + an
 * identity (a freshly-minted self-signed cert, or an uploaded .p12/.pfx), pulls
 * the current document bytes from the viewer API, applies a cryptographic
 * PKCS#7 signature (incremental update), and downloads the signed PDF.
 *
 * The signing stack (@signpdf + node-forge) is ~90 KB gzipped, so it's loaded
 * lazily via dynamic import — only when the user actually signs.
 */
export function SignDialog({
  api,
  title,
  onClose,
}: {
  api: CasualPdfApi | null;
  title: string;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [reason, setReason] = useState('I approve this document');
  const [location, setLocation] = useState('');
  const [useCert, setUseCert] = useState(false);
  const [certFile, setCertFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const sign = async () => {
    setError(null);
    if (!api) {
      setError('The document isn’t ready yet.');
      return;
    }
    if (useCert && (!certFile || !passphrase)) {
      setError('Choose a .p12/.pfx file and enter its passphrase.');
      return;
    }
    setBusy(true);
    try {
      const pdf = await api.getBytes();
      if (!pdf) throw new Error('Couldn’t read the document bytes.');
      // Lazy-load the crypto stack only when signing (dedicated subpath so the
      // node-forge bundle splits into its own async chunk).
      const { signPdf, generateSelfSignedP12 } = await import('@casualoffice/pdf/sign');
      const signerName = name.trim() || 'Casual PDF Signer';
      let p12: Uint8Array;
      let pass: string;
      if (useCert && certFile) {
        p12 = new Uint8Array(await certFile.arrayBuffer());
        pass = passphrase;
      } else {
        // Ephemeral self-signed identity; the passphrase only guards the
        // in-memory .p12 and is never persisted.
        pass =
          typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `cpdf-${Math.random()}`;
        p12 = generateSelfSignedP12({ name: signerName, passphrase: pass });
      }
      const signed = await signPdf({
        pdf,
        p12,
        passphrase: pass,
        reason: reason.trim() || 'I approve this document',
        name: signerName,
        location: location.trim(),
      });
      // Download the signed copy.
      // Copy into a fresh ArrayBuffer so the Blob owns a tight, standalone buffer.
      const ab = new ArrayBuffer(signed.byteLength);
      new Uint8Array(ab).set(signed);
      const blob = new Blob([ab], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const base = title.replace(/\.pdf$/i, '') || 'document';
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}-signed.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Signing failed.');
      setBusy(false);
    }
  };

  return (
    <div className="dialog__scrim" role="presentation" onClick={() => !busy && onClose()}>
      <div
        className="dialog dialog--form"
        role="dialog"
        aria-modal="true"
        aria-label="Digitally sign"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="signdlg__head">
          <Icon name="sign" size={22} />
          <h2 className="dialog__title" style={{ margin: 0 }}>
            Digitally sign
          </h2>
        </div>
        <p className="dialog__body" style={{ textAlign: 'left' }}>
          Add a certified cryptographic signature (PKCS#7) over the current document. The original is
          preserved — the signature is appended as an incremental update.
        </p>

        <label className="signdlg__field">
          <span>Signer name</span>
          <input ref={nameRef} value={name} placeholder="Your name" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="signdlg__field">
          <span>Reason</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="signdlg__field">
          <span>Location (optional)</span>
          <input value={location} placeholder="City, Country" onChange={(e) => setLocation(e.target.value)} />
        </label>

        <fieldset className="signdlg__identity">
          <legend>Identity</legend>
          <label className="signdlg__radio">
            <input type="radio" name="ident" checked={!useCert} onChange={() => setUseCert(false)} />
            <span>
              Create a signature for me
              <em>Quick self-signed identity — valid signature, signer not independently verified.</em>
            </span>
          </label>
          <label className="signdlg__radio">
            <input type="radio" name="ident" checked={useCert} onChange={() => setUseCert(true)} />
            <span>
              Use my certificate (.p12 / .pfx)
              <em>A certificate from a trusted authority verifies your identity.</em>
            </span>
          </label>
          {useCert && (
            <div className="signdlg__cert">
              <input
                type="file"
                accept=".p12,.pfx,application/x-pkcs12"
                aria-label="Certificate file"
                onChange={(e) => setCertFile(e.target.files?.[0] ?? null)}
              />
              <input
                type="password"
                value={passphrase}
                placeholder="Certificate passphrase"
                aria-label="Certificate passphrase"
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </div>
          )}
        </fieldset>

        {error && (
          <p className="signdlg__error" role="alert">
            {error}
          </p>
        )}

        <div className="signdlg__actions">
          <button type="button" className="signdlg__btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="signdlg__btn signdlg__btn--primary" onClick={sign} disabled={busy}>
            {busy ? 'Signing…' : 'Sign & download'}
          </button>
        </div>
      </div>
    </div>
  );
}
