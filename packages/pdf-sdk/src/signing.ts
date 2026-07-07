// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Signing-workflow model over the Yjs overlay's `signing` map — the request-to-sign
 * envelope: recipients, routing order, per-signer status, and an append-only audit
 * log. Rides the shared collab doc, so a multi-party signing flow syncs peer→peer.
 *
 * Design (from the 2026-07-08 competitive research → decision): recipients by
 * name+email with roles `signer`/`cc`; a signing-order toggle (default PARALLEL,
 * or SEQUENTIAL with whose-turn gating); a DocuSign-style audit trail (envelope
 * GUID + SHA-256 doc hash + per-signer Sent/Viewed/Signed timestamps + a consent
 * event); status draft→sent→viewed→partially_signed→completed (+ declined/voided).
 * Honest scope: an ESIGN/eIDAS-SES + integrity signature (the existing PKCS#7 seal
 * is the tamper-evidence) — NOT AES/QES. One envelope per document in v1.
 *
 * Pure: ids + timestamps are caller-supplied, so the whole lifecycle unit-tests
 * without a clock. Structure: envelope fields on `signing` (Y.Map), `signers` and
 * `events` as Y.Arrays (events append-only → conflict-free).
 */
import * as Y from 'yjs';
import type { CasualPdfDoc } from './model';

export type SignerRole = 'signer' | 'cc';
export type SignerStatus = 'pending' | 'viewed' | 'signed' | 'declined';
export type EnvelopeStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'partially_signed'
  | 'completed'
  | 'declined'
  | 'voided';
export type SigningOrder = 'parallel' | 'sequential';

export interface Signer {
  id: string;
  name: string;
  email: string;
  role: SignerRole;
  /** 1-based routing order (used when order === 'sequential'). */
  order: number;
  status: SignerStatus;
  viewedAt?: number;
  signedAt?: number;
  declinedAt?: number;
  /** How the signer was authenticated (min: "email"). */
  authMethod?: string;
}

export type AuditEventType =
  | 'created'
  | 'sent'
  | 'viewed'
  | 'consented'
  | 'signed'
  | 'sealed'
  | 'declined'
  | 'voided';

export interface AuditEvent {
  type: AuditEventType;
  /** Who acted (name or email). */
  actor: string;
  at: number;
  detail?: string;
}

export interface SigningEnvelope {
  id: string;
  title: string;
  status: EnvelopeStatus;
  order: SigningOrder;
  createdBy: string;
  createdAt: number;
  /** SHA-256 hex of the base document bytes (attribution/tamper-evidence). */
  docHash?: string;
  signers: Signer[];
  events: AuditEvent[];
}

const SIGNERS = 'signers';
const EVENTS = 'events';

/** Is there an envelope on this document yet? */
export function hasEnvelope(model: CasualPdfDoc): boolean {
  return !!model.signing.get('id');
}

/** Input for creating the (single) envelope. */
export interface NewEnvelope {
  id: string;
  title: string;
  createdBy: string;
  createdAt: number;
  order?: SigningOrder;
  docHash?: string;
}

/** Create the signing envelope in `draft`. Idempotent-guarded by the caller. */
export function createEnvelope(model: CasualPdfDoc, e: NewEnvelope): void {
  model.doc.transact(() => {
    model.signing.set('id', e.id);
    model.signing.set('title', e.title);
    model.signing.set('status', 'draft' as EnvelopeStatus);
    model.signing.set('order', e.order ?? 'parallel');
    model.signing.set('createdBy', e.createdBy);
    model.signing.set('createdAt', e.createdAt);
    if (e.docHash) model.signing.set('docHash', e.docHash);
    model.signing.set(SIGNERS, new Y.Array<Y.Map<unknown>>());
    model.signing.set(EVENTS, new Y.Array<Y.Map<unknown>>());
    pushEvent(model, { type: 'created', actor: e.createdBy, at: e.createdAt });
  });
}

function signersArr(model: CasualPdfDoc): Y.Array<Y.Map<unknown>> | undefined {
  return model.signing.get(SIGNERS) as Y.Array<Y.Map<unknown>> | undefined;
}
function eventsArr(model: CasualPdfDoc): Y.Array<Y.Map<unknown>> | undefined {
  return model.signing.get(EVENTS) as Y.Array<Y.Map<unknown>> | undefined;
}

function pushEvent(model: CasualPdfDoc, ev: AuditEvent): void {
  const events = eventsArr(model);
  if (!events) return;
  const m = new Y.Map<unknown>();
  m.set('type', ev.type);
  m.set('actor', ev.actor);
  m.set('at', ev.at);
  if (ev.detail) m.set('detail', ev.detail);
  events.push([m]);
}

/** Append an audit event (also used by the app to log a consent/seal). */
export function recordEvent(model: CasualPdfDoc, ev: AuditEvent): void {
  model.doc.transact(() => pushEvent(model, ev));
}

export interface NewSigner {
  id: string;
  name: string;
  email: string;
  role?: SignerRole;
  /** 1-based routing order; defaults to append order. */
  order?: number;
}

/** Add a recipient to the (draft) envelope. */
export function addSigner(model: CasualPdfDoc, s: NewSigner): void {
  const signers = signersArr(model);
  if (!signers) return;
  model.doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set('id', s.id);
    m.set('name', s.name);
    m.set('email', s.email);
    m.set('role', s.role ?? 'signer');
    m.set('order', s.order ?? signers.length + 1);
    m.set('status', 'pending' as SignerStatus);
    signers.push([m]);
  });
}

function findSigner(model: CasualPdfDoc, id: string): Y.Map<unknown> | null {
  const signers = signersArr(model);
  if (!signers) return null;
  for (const m of signers) if (m.get('id') === id) return m;
  return null;
}

function setEnvelopeStatus(model: CasualPdfDoc): void {
  model.signing.set('status', deriveStatus(readSigners(model), currentStatus(model)));
}

function currentStatus(model: CasualPdfDoc): EnvelopeStatus {
  return (model.signing.get('status') as EnvelopeStatus) ?? 'draft';
}

/** Move draft → sent (recipients notified). Records a `sent` event. */
export function sendEnvelope(model: CasualPdfDoc, at: number): void {
  if (currentStatus(model) !== 'draft') return;
  model.doc.transact(() => {
    model.signing.set('status', 'sent' as EnvelopeStatus);
    pushEvent(model, { type: 'sent', actor: String(model.signing.get('createdBy') ?? ''), at });
  });
}

/** A signer opened the document. */
export function markViewed(model: CasualPdfDoc, signerId: string, at: number): void {
  const s = findSigner(model, signerId);
  if (!s || s.get('status') !== 'pending') return;
  model.doc.transact(() => {
    s.set('status', 'viewed' as SignerStatus);
    s.set('viewedAt', at);
    pushEvent(model, { type: 'viewed', actor: String(s.get('email') ?? s.get('name') ?? ''), at });
    setEnvelopeStatus(model);
  });
}

/** A signer accepted the electronic-records disclosure (ESIGN §7001 consent). */
export function markConsented(model: CasualPdfDoc, signerId: string, at: number, disclosureVersion = 'v1'): void {
  const s = findSigner(model, signerId);
  if (!s) return;
  model.doc.transact(() =>
    pushEvent(model, {
      type: 'consented',
      actor: String(s.get('email') ?? s.get('name') ?? ''),
      at,
      detail: `disclosure ${disclosureVersion}`,
    }),
  );
}

/** A signer signed. Records the event, sets timestamp + auth method, recomputes status. */
export function markSigned(model: CasualPdfDoc, signerId: string, at: number, authMethod = 'email'): void {
  const s = findSigner(model, signerId);
  if (!s || s.get('status') === 'signed' || s.get('status') === 'declined') return;
  model.doc.transact(() => {
    s.set('status', 'signed' as SignerStatus);
    s.set('signedAt', at);
    s.set('authMethod', authMethod);
    pushEvent(model, { type: 'signed', actor: String(s.get('email') ?? s.get('name') ?? ''), at });
    setEnvelopeStatus(model);
  });
}

/** A signer declined — terminal for the envelope. */
export function markDeclined(model: CasualPdfDoc, signerId: string, at: number, reason?: string): void {
  const s = findSigner(model, signerId);
  if (!s || s.get('status') === 'signed' || s.get('status') === 'declined') return;
  model.doc.transact(() => {
    s.set('status', 'declined' as SignerStatus);
    s.set('declinedAt', at);
    pushEvent(model, { type: 'declined', actor: String(s.get('email') ?? s.get('name') ?? ''), at, detail: reason });
    model.signing.set('status', 'declined' as EnvelopeStatus);
  });
}

/** Void the envelope (sender cancels) — terminal. */
export function voidEnvelope(model: CasualPdfDoc, actor: string, at: number, reason?: string): void {
  const st = currentStatus(model);
  if (st === 'completed' || st === 'voided' || st === 'declined') return;
  model.doc.transact(() => {
    model.signing.set('status', 'voided' as EnvelopeStatus);
    pushEvent(model, { type: 'voided', actor, at, detail: reason });
  });
}

// ── reads / pure derivations ─────────────────────────────────────────────────

function signerFrom(m: Y.Map<unknown>): Signer {
  const s: Signer = {
    id: String(m.get('id')),
    name: String(m.get('name') ?? ''),
    email: String(m.get('email') ?? ''),
    role: (m.get('role') as SignerRole) ?? 'signer',
    order: Number(m.get('order') ?? 1),
    status: (m.get('status') as SignerStatus) ?? 'pending',
  };
  if (m.get('viewedAt') != null) s.viewedAt = Number(m.get('viewedAt'));
  if (m.get('signedAt') != null) s.signedAt = Number(m.get('signedAt'));
  if (m.get('declinedAt') != null) s.declinedAt = Number(m.get('declinedAt'));
  if (m.get('authMethod') != null) s.authMethod = String(m.get('authMethod'));
  return s;
}

/** All signers, in routing order then insertion order. */
export function readSigners(model: CasualPdfDoc): Signer[] {
  const signers = signersArr(model);
  if (!signers) return [];
  return signers.toArray().map(signerFrom).sort((a, b) => a.order - b.order);
}

export function readEvents(model: CasualPdfDoc): AuditEvent[] {
  const events = eventsArr(model);
  if (!events) return [];
  return events.toArray().map((m) => {
    const e: AuditEvent = { type: m.get('type') as AuditEventType, actor: String(m.get('actor') ?? ''), at: Number(m.get('at') ?? 0) };
    if (m.get('detail') != null) e.detail = String(m.get('detail'));
    return e;
  });
}

/** The whole envelope, or null if none exists. */
export function readEnvelope(model: CasualPdfDoc): SigningEnvelope | null {
  if (!hasEnvelope(model)) return null;
  return {
    id: String(model.signing.get('id')),
    title: String(model.signing.get('title') ?? ''),
    status: currentStatus(model),
    order: (model.signing.get('order') as SigningOrder) ?? 'parallel',
    createdBy: String(model.signing.get('createdBy') ?? ''),
    createdAt: Number(model.signing.get('createdAt') ?? 0),
    docHash: model.signing.get('docHash') != null ? String(model.signing.get('docHash')) : undefined,
    signers: readSigners(model),
    events: readEvents(model),
  };
}

/** Derive the envelope status from the signers (pure). `prev` preserves terminal
 *  states (declined/voided) which aren't recomputed from signers. */
export function deriveStatus(signers: Signer[], prev: EnvelopeStatus = 'draft'): EnvelopeStatus {
  if (prev === 'declined' || prev === 'voided') return prev;
  const toSign = signers.filter((s) => s.role === 'signer');
  if (!toSign.length) return prev === 'draft' ? 'draft' : prev;
  const signed = toSign.filter((s) => s.status === 'signed').length;
  if (signed === toSign.length) return 'completed';
  if (signed > 0) return 'partially_signed';
  if (toSign.some((s) => s.status === 'viewed')) return 'viewed';
  return prev === 'draft' ? 'draft' : 'sent';
}

/** Which signers may sign RIGHT NOW. Parallel → all unsigned signers; sequential →
 *  only unsigned signers at the lowest order that still has anyone outstanding. */
export function whoseTurn(env: SigningEnvelope): Signer[] {
  const signers = env.signers.filter((s) => s.role === 'signer' && s.status !== 'signed' && s.status !== 'declined');
  if (env.order !== 'sequential' || !signers.length) return signers;
  const minOrder = Math.min(...signers.map((s) => s.order));
  return signers.filter((s) => s.order === minOrder);
}

/** Can this signer sign now (used to gate the Sign action under sequential order)? */
export function canSign(env: SigningEnvelope, signerId: string): boolean {
  if (env.status === 'declined' || env.status === 'voided' || env.status === 'completed') return false;
  return whoseTurn(env).some((s) => s.id === signerId);
}
