// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@casualoffice/pdf';

export interface RestrictPermissions {
  print: boolean;
  copy: boolean;
  modify: boolean;
  annotate: boolean;
}

/**
 * Restrict PDF permissions: an owner password + which actions are allowed. The
 * file is AES-256 encrypted with an empty OPEN password (no prompt to view), so
 * this restricts *actions* (honored by compliant readers), not *access*.
 */
export function RestrictDialog({
  onRestrict,
  onClose,
  busy = false,
}: {
  onRestrict: (ownerPassword: string, allow: RestrictPermissions) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [owner, setOwner] = useState('');
  const [allow, setAllow] = useState<RestrictPermissions>({ print: true, copy: false, modify: false, annotate: false });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    const focusables = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
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

  const toggle = (k: keyof RestrictPermissions) => setAllow((a) => ({ ...a, [k]: !a[k] }));
  const submit = () => {
    if (owner.trim()) onRestrict(owner, allow);
  };

  const PERMS: { key: keyof RestrictPermissions; label: string }[] = [
    { key: 'print', label: 'Allow printing' },
    { key: 'copy', label: 'Allow copying text & images' },
    { key: 'modify', label: 'Allow editing content' },
    { key: 'annotate', label: 'Allow comments & form fill' },
  ];

  return (
    <div className="dialog__scrim" role="presentation" onClick={() => !busy && onClose()}>
      <div
        ref={dialogRef}
        className="dialog dialog--form"
        role="dialog"
        aria-modal="true"
        aria-label="Restrict permissions"
        aria-busy={busy || undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="signdlg__head">
          <Icon name="lock" size={22} />
          <h2 className="dialog__title" style={{ margin: 0 }}>
            Restrict permissions
          </h2>
        </div>
        <p className="dialog__body" style={{ textAlign: 'left' }}>
          Set an owner password and choose which actions are allowed. The PDF is AES-256 encrypted but opens
          <strong> without a password</strong> — this restricts actions (honored by compliant readers like Acrobat,
          Preview and Chrome), it does not keep the content secret.
        </p>

        <div className="signdlg__owncert">
          <label className="restrictdlg__label" htmlFor="restrict-owner">
            Owner password (required to change permissions)
          </label>
          <input
            id="restrict-owner"
            ref={firstRef}
            type="password"
            className="signdlg__owncert-pass"
            placeholder="Owner password"
            autoComplete="new-password"
            disabled={busy}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
          <div className="restrictdlg__perms" role="group" aria-label="Allowed actions">
            {PERMS.map(({ key, label }) => (
              <label key={key} className="restrictdlg__perm">
                <input type="checkbox" checked={allow[key]} disabled={busy} onChange={() => toggle(key)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="signdlg__actions">
          <button
            type="button"
            className="signdlg__btn signdlg__btn--primary"
            onClick={submit}
            disabled={busy || !owner.trim()}
            aria-live="polite"
          >
            {busy ? 'Protecting…' : 'Protect & download'}
          </button>
          <button type="button" className="signdlg__btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
