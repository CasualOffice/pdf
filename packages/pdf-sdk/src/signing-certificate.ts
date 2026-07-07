// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Renders a "Certificate of Completion" page (modeled on DocuSign's) and appends it
 * to the signed PDF: envelope id, document hash, per-signer Sent/Viewed/Signed
 * timestamps + auth method, and the full audit-event log. This is the human- and
 * legally-readable record of the signing workflow (signing.ts). pdf-lib is lazy-
 * imported (shared ~430 KB chunk, same as page-furniture/redact).
 */
import type { SigningEnvelope } from './signing';

/** SHA-256 hex of the document bytes — the attribution/tamper-evidence anchor
 *  stored on the envelope (`docHash`). WebCrypto (browser + Node). */
export async function computeDocHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return String(ts);
  }
}

/** Append a certificate-of-completion page to `pdf` from `env`. Returns new bytes. */
export async function buildCompletionCertificate(pdf: Uint8Array, env: SigningEnvelope): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 612;
  const H = 792; // US Letter
  const margin = 54;
  let page = doc.addPage([W, H]);
  let y = H - margin;

  const newPageIfNeeded = (need: number) => {
    if (y - need < margin) {
      page = doc.addPage([W, H]);
      y = H - margin;
    }
  };
  type LineOpts = { size?: number; bold?: boolean; x?: number; gap?: number; color?: [number, number, number] };
  const line = (text: string, opts: LineOpts = {}) => {
    const size = opts.size ?? 10;
    newPageIfNeeded(size + 4);
    const c = opts.color ?? [0.1, 0.1, 0.12];
    page.drawText(text, { x: opts.x ?? margin, y, size, font: opts.bold ? bold : font, color: rgb(c[0], c[1], c[2]) });
    y -= opts.gap ?? size + 6;
  };

  line('Certificate of Completion', { size: 18, bold: true, gap: 26 });
  line(`Document: ${env.title || 'Untitled'}`, { size: 11, bold: true });
  line(`Envelope ID: ${env.id}`);
  line(`Status: ${env.status}`);
  line(`Signing order: ${env.order}`);
  if (env.docHash) line(`Document hash (SHA-256): ${env.docHash}`, { size: 8, color: [0.35, 0.35, 0.4] });
  line(`Created by ${env.createdBy} at ${fmtTime(env.createdAt)}`, { gap: 18 });

  line('Recipients', { size: 13, bold: true, gap: 18 });
  for (const s of env.signers) {
    line(`${s.name} <${s.email}> — ${s.role} — ${s.status}`, { bold: true, gap: 14 });
    const parts: string[] = [];
    if (s.viewedAt) parts.push(`Viewed ${fmtTime(s.viewedAt)}`);
    if (s.signedAt) parts.push(`Signed ${fmtTime(s.signedAt)}`);
    if (s.authMethod) parts.push(`Auth: ${s.authMethod}`);
    line(parts.length ? '   ' + parts.join('   ·   ') : '   (no action yet)', {
      size: 9,
      color: [0.35, 0.35, 0.4],
      gap: 16,
    });
  }

  y -= 6;
  line('Audit trail', { size: 13, bold: true, gap: 18 });
  for (const e of env.events) {
    line(`${fmtTime(e.at)}   ${e.type.toUpperCase()}   ${e.actor}${e.detail ? '   (' + e.detail + ')' : ''}`, {
      size: 9,
      color: [0.3, 0.3, 0.35],
      gap: 13,
    });
  }

  // Honest scope, per the design decision (do not imply AES/QES).
  newPageIfNeeded(20);
  page.drawText(
    'Electronic signature under ESIGN/UETA & eIDAS (SES). Integrity sealed via PKCS#7. Not an AES/QES signature.',
    { x: margin, y: margin - 12, size: 7, font, color: rgb(0.5, 0.5, 0.55) },
  );

  return doc.save();
}
