// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * PII detection for AI redaction — a broad registry of **structured** PII
 * detected deterministically with regex + checksum validation (so a random
 * 16-digit number isn't flagged as a card unless it passes Luhn, and a 12-digit
 * number isn't an Aadhaar unless it passes Verhoeff). Checksums used: Luhn
 * (cards / IMEI / Canada SIN), Verhoeff (India Aadhaar), mod-97 (IBAN), ABA
 * (US bank routing).
 *
 * **Contextual** PII that regex can't identify reliably — person names, company
 * names, places/addresses, signatures, and role-tagged dates (DOB/DOD/sign date)
 * — is handled by the AI itself, which marks them via `mark_redaction`. So the
 * two together (this registry + the model) cover the long tail. This module is
 * pure and unit-tested; adding a type is one registry entry.
 */

export type PiiType =
  | 'credit-card' | 'imei' | 'canada-sin' | 'aadhaar' | 'iban' | 'us-routing'
  | 'ssn' | 'us-ein' | 'us-passport' | 'india-passport' | 'india-pan'
  | 'india-gstin' | 'india-voter-id' | 'india-uan' | 'india-vehicle' | 'india-pincode'
  | 'uk-nino' | 'us-zip' | 'email' | 'url' | 'ipv4' | 'ipv6' | 'mac-address'
  | 'phone' | 'swift-bic' | 'bitcoin-address' | 'ethereum-address'
  | 'date' | 'time' | 'isbn' | 'vin' | 'coordinates';

export interface PiiMatch {
  type: PiiType;
  /** Char range into the scanned text. */
  start: number;
  end: number;
  value: string;
}

// ── Checksums ────────────────────────────────────────────────────────────────

/** Luhn (mod-10) — credit cards, IMEI, Canada SIN. */
export function luhnValid(input: string): boolean {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Verhoeff dihedral tables (India Aadhaar).
const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff — India Aadhaar (12 digits, last is the check digit). */
export function verhoeffValid(input: string): boolean {
  const digits = input.replace(/\D/g, '');
  if (digits.length !== 12) return false;
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) c = VD[c][VP[i % 8][rev[i].charCodeAt(0) - 48]];
  return c === 0;
}

/** ISO 7064 mod-97-10 — IBAN. */
export function ibanValid(input: string): boolean {
  const s = input.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => (ch.charCodeAt(0) - 55).toString());
  let rem = 0;
  for (const d of numeric) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  return rem === 1;
}

/** ABA (mod-10, weights 3-7-1) — US bank routing number. */
export function abaValid(input: string): boolean {
  const d = input.replace(/\D/g, '');
  if (d.length !== 9) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (d.charCodeAt(i) - 48) * w[i];
  return sum % 10 === 0;
}

// ── Registry ─────────────────────────────────────────────────────────────────

interface Detector {
  type: PiiType;
  re: RegExp;
  validate?: (v: string) => boolean;
}

// Priority order (earlier = kept when spans overlap): more specific / validated first.
const DETECTORS: Detector[] = [
  { type: 'credit-card', re: /\b\d(?:[ -]?\d){12,18}\b/g, validate: luhnValid },
  { type: 'imei', re: /\b\d{15}\b/g, validate: luhnValid },
  { type: 'aadhaar', re: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, validate: verhoeffValid },
  { type: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, validate: ibanValid },
  { type: 'canada-sin', re: /\b\d{3}[- ]?\d{3}[- ]?\d{3}\b/g, validate: luhnValid },
  { type: 'india-pan', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: 'india-gstin', re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z][Zz][0-9A-Z]\b/g },
  { type: 'india-voter-id', re: /\b[A-Z]{3}\d{7}\b/g },
  { type: 'india-uan', re: /\b\d{12}\b/g }, // 12-digit (after aadhaar's validated pass)
  { type: 'india-vehicle', re: /\b[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}\b/g },
  { type: 'india-passport', re: /\b[A-PR-WY]\d{7}\b/g },
  { type: 'us-passport', re: /\b[A-Z0-9]{9}\b(?=.*passport)/gi },
  { type: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'us-ein', re: /\b\d{2}-\d{7}\b/g },
  { type: 'uk-nino', re: /\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]\b/g },
  { type: 'swift-bic', re: /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g },
  { type: 'ethereum-address', re: /\b0x[a-fA-F0-9]{40}\b/g },
  { type: 'bitcoin-address', re: /\b(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{25,39}\b/g },
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'url', re: /\bhttps?:\/\/[^\s<>")]+/gi },
  { type: 'ipv4', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { type: 'ipv6', re: /\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b/gi },
  { type: 'mac-address', re: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g },
  { type: 'vin', re: /\b[A-HJ-NPR-Z0-9]{17}\b/g },
  { type: 'isbn', re: /\b(?:ISBN(?:-1[03])?:?\s*)?(?:97[89][- ]?)?\d{1,5}[- ]?\d+[- ]?\d+[- ]?[\dX]\b/gi },
  { type: 'phone', re: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g },
  { type: 'india-pincode', re: /\b[1-9]\d{2}\s?\d{3}\b/g },
  { type: 'us-zip', re: /\b\d{5}(?:-\d{4})?\b/g },
  { type: 'coordinates', re: /\b-?\d{1,3}\.\d{3,},\s?-?\d{1,3}\.\d{3,}\b/g },
  { type: 'date', re: /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/gi },
  { type: 'time', re: /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:[AaPp][Mm])?\b/g },
];

/** Every PII type this module can detect deterministically. */
export const PII_TYPES: PiiType[] = DETECTORS.map((d) => d.type);

/**
 * Detect structured PII in `text`. Candidates come from the registry regexes and
 * (for cards/Aadhaar/IBAN/routing) must pass their checksum. Overlapping spans
 * are resolved by registry priority (so a card isn't also flagged as a phone or
 * ZIP), and the result is sorted by position.
 */
export function detectPii(text: string): PiiMatch[] {
  const all: PiiMatch[] = [];
  for (const det of DETECTORS) {
    for (const m of text.matchAll(det.re)) {
      if (m.index == null) continue;
      if (det.validate && !det.validate(m[0])) continue;
      all.push({ type: det.type, start: m.index, end: m.index + m[0].length, value: m[0] });
    }
  }
  // Registry order is priority; keep a match only if it doesn't overlap a kept one.
  const rank = new Map(DETECTORS.map((d, i) => [d.type, i]));
  all.sort((a, b) => (rank.get(a.type)! - rank.get(b.type)!) || a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept: PiiMatch[] = [];
  for (const m of all) {
    if (!kept.some((k) => m.start < k.end && m.end > k.start)) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}
