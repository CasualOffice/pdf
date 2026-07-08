// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * `useSigning` — reactive request-to-sign workflow for one open document over the
 * Yjs `signing` map (rides the shared collab doc → co-signing syncs; a local doc
 * when solo). The UI reads `envelope` and calls createRequest / sign / decline /
 * voidRequest / downloadCertificate. Ids + timestamps are minted here (the model
 * stays pure). `getBytes` supplies the current PDF for the doc hash + certificate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createCasualPdfDoc, type CasualPdfDoc } from './model';
import {
  createEnvelope,
  addSigner,
  sendEnvelope,
  markSigned,
  markConsented,
  markDeclined,
  voidEnvelope,
  readEnvelope,
  hasEnvelope,
  type SigningEnvelope,
  type SigningOrder,
  type SignerRole,
} from './signing';

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'id-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }
}

export interface NewRecipient {
  name: string;
  email: string;
  role: SignerRole;
}

export interface SigningState {
  envelope: SigningEnvelope | null;
  createRequest(title: string, order: SigningOrder, recipients: NewRecipient[]): Promise<void>;
  sign(signerId: string): void;
  decline(signerId: string, reason?: string): void;
  voidRequest(reason?: string): void;
  downloadCertificate(): Promise<void>;
}

export function useSigning(
  documentId: string,
  sharedModel: CasualPdfDoc | null,
  author: string,
  getBytes: () => Promise<Uint8Array | null> | Uint8Array | null,
): SigningState {
  const localRef = useRef<CasualPdfDoc | null>(null);
  const localIdRef = useRef<string>('');
  if (!sharedModel && (localRef.current === null || localIdRef.current !== documentId)) {
    localRef.current = createCasualPdfDoc(documentId);
    localIdRef.current = documentId;
  }
  const model = sharedModel ?? localRef.current!;

  const [envelope, setEnvelope] = useState<SigningEnvelope | null>(null);
  useEffect(() => {
    const refresh = () => setEnvelope(readEnvelope(model));
    model.signing.observeDeep(refresh);
    refresh();
    return () => model.signing.unobserveDeep(refresh);
  }, [model]);

  const createRequest = useCallback(
    async (title: string, order: SigningOrder, recipients: NewRecipient[]) => {
      if (hasEnvelope(model)) return; // one envelope per document (H1: don't clobber)
      const bytes = await getBytes();
      let docHash: string | undefined;
      if (bytes) {
        const { computeDocHash } = await import('./signing-certificate');
        docHash = await computeDocHash(bytes);
      }
      if (hasEnvelope(model)) return; // re-check after the await (double-submit window)
      const now = Date.now();
      // One atomic transaction (L2) so peers never see a half-built envelope.
      model.doc.transact(() => {
        createEnvelope(model, { id: uid(), title, createdBy: author, createdAt: now, order, docHash });
        recipients.forEach((r, i) => addSigner(model, { id: uid(), name: r.name, email: r.email, role: r.role, order: i + 1 }));
        sendEnvelope(model, now);
      });
    },
    [model, author, getBytes],
  );

  // Signing records the ESIGN §7001 consent (the signer accepted the electronic-
  // records disclosure — captured by the consent checkbox) BEFORE the signature, so
  // both land in the audit trail. Honest auth method: authenticated only by collab-
  // room membership, NOT identity-verified (see H3 note in signing.ts).
  const sign = useCallback(
    (signerId: string) => {
      const now = Date.now();
      markConsented(model, signerId, now);
      markSigned(model, signerId, now, 'collab-session');
    },
    [model],
  );
  const decline = useCallback((signerId: string, reason?: string) => markDeclined(model, signerId, Date.now(), reason), [model]);
  const voidRequest = useCallback((reason?: string) => voidEnvelope(model, author, Date.now(), reason), [model, author]);

  const downloadCertificate = useCallback(async () => {
    const env = readEnvelope(model);
    if (!env) return;
    const bytes = await getBytes();
    if (!bytes) return;
    const { buildCompletionCertificate } = await import('./signing-certificate');
    const out = await buildCompletionCertificate(bytes, env);
    const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(env.title || 'document').replace(/\.pdf$/i, '')}.certificate.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, [model, getBytes]);

  return { envelope, createRequest, sign, decline, voidRequest, downloadCertificate };
}
