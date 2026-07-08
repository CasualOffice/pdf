// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@casualoffice/pdf';

/**
 * Start / share a live co-editing session. Shown only when a collab server is
 * available. Before a session exists it offers "Start co-editing" (mints a room in
 * place — no reload); once in a session it shows the shareable link. Warns when the
 * document was opened from disk (a blob: URL collaborators can't load).
 */
export function ShareDialog({
  inSession,
  isBlobDoc,
  onStart,
  onClose,
}: {
  inSession: boolean;
  isBlobDoc: boolean;
  onStart: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement | HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [copied, setCopied] = useState(false);
  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        const f = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input, [tabindex]:not([tabindex="-1"])') ?? []);
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the field is selectable for a manual copy */
    }
  };

  return (
    <div className="dialog__scrim" role="presentation" onClick={onClose}>
      <div ref={dialogRef} className="dialog dialog--form" role="dialog" aria-modal="true" aria-label="Co-edit this document" onClick={(e) => e.stopPropagation()}>
        <div className="signdlg__head">
          <Icon name="comments" size={22} />
          <h2 className="dialog__title" style={{ margin: 0 }}>
            Co-edit this document
          </h2>
        </div>

        {isBlobDoc && (
          <p className="share__warn">
            This PDF was opened from your device, so collaborators won’t be able to load it. Open the PDF from a shared
            URL to co-edit its content (annotations still sync).
          </p>
        )}

        {inSession ? (
          <>
            <p className="dialog__body" style={{ textAlign: 'left' }}>
              Anyone with this link can open the document and edit together in real time — cursors, comments and changes
              sync live.
            </p>
            <div className="share__link">
              <input
                ref={primaryRef as React.RefObject<HTMLInputElement>}
                className="share__link-input"
                readOnly
                value={shareUrl}
                aria-label="Share link"
                data-testid="share-link"
                onFocus={(e) => e.target.select()}
              />
              <button type="button" className="signdlg__btn signdlg__btn--primary" data-testid="share-copy" onClick={copy}>
                {copied ? 'Copied!' : 'Copy link'}
              </button>
            </div>
            <div className="signdlg__actions">
              <button type="button" className="signdlg__btn" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="dialog__body" style={{ textAlign: 'left' }}>
              Start a live co-editing session — you’ll get a link to invite others. Everyone sees each other’s cursors,
              comments and edits in real time.
            </p>
            <div className="signdlg__actions">
              <button
                ref={primaryRef as React.RefObject<HTMLButtonElement>}
                type="button"
                className="signdlg__btn signdlg__btn--primary"
                data-testid="share-start"
                onClick={onStart}
              >
                Start co-editing
              </button>
              <button type="button" className="signdlg__btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
