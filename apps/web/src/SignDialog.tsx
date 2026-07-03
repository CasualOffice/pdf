// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react';
import { Icon } from '@casualoffice/pdf';

export function SignDialog({
  onClose,
  onAddVisibleSignature,
  onSignDocument,
  busy = false,
}: {
  onClose: () => void;
  onAddVisibleSignature: () => void;
  onSignDocument: () => void;
  busy?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const continueToSignature = () => {
    onClose();
    onAddVisibleSignature();
  };
  const signNow = () => {
    onClose();
    onSignDocument();
  };

  return (
    <div className="dialog__scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog dialog--form"
        role="dialog"
        aria-modal="true"
        aria-label="Sign document"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="signdlg__head">
          <Icon name="sign" size={22} />
          <h2 className="dialog__title" style={{ margin: 0 }}>
            Sign document
          </h2>
        </div>
        <p className="dialog__body" style={{ textAlign: 'left' }}>
          Add a cryptographic signature to the current PDF, or place a visible signature stamp on the page first.
        </p>

        <div className="signdlg__actions">
          <button type="button" className="signdlg__btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="signdlg__btn" onClick={continueToSignature}>
            Add visible signature
          </button>
          <button ref={closeRef} type="button" className="signdlg__btn signdlg__btn--primary" onClick={signNow} disabled={busy}>
            {busy ? 'Signing…' : 'Sign and download'}
          </button>
        </div>
      </div>
    </div>
  );
}
