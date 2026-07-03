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
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  // Stable ref so the mount effect runs exactly once — depending on `onClose`
  // (an inline arrow from the parent, new identity every render) would re-run
  // the effect on each parent render and yank focus back mid-interaction.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    primaryRef.current?.focus();
    const focusables = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        // Trap focus within the dialog (WCAG 2.2 no-keyboard-trap-escape via Esc).
        const f = focusables();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        const active = document.activeElement as HTMLElement;
        if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, []);

  const continueToSignature = () => {
    onClose();
    onAddVisibleSignature();
  };
  // Do NOT close here — keep the dialog open so the "Signing…" busy state is
  // visible during the (lazy-loaded, ~85 KB) crypto + PKCS#7 work. The parent
  // closes the dialog when signing succeeds; on failure it stays open to retry.
  const signNow = () => {
    onSignDocument();
  };

  return (
    <div className="dialog__scrim" role="presentation" onClick={() => !busy && onClose()}>
      <div
        ref={dialogRef}
        className="dialog dialog--form"
        role="dialog"
        aria-modal="true"
        aria-label="Sign document"
        aria-busy={busy || undefined}
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
          <button type="button" className="signdlg__btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="signdlg__btn" onClick={continueToSignature} disabled={busy}>
            Add visible signature
          </button>
          <button ref={primaryRef} type="button" className="signdlg__btn signdlg__btn--primary" onClick={signNow} disabled={busy} aria-live="polite">
            {busy ? 'Signing…' : 'Sign and download'}
          </button>
        </div>
      </div>
    </div>
  );
}
