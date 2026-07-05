// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP tool handlers — the file-in / file-out logic behind the Casual PDF MCP
 * server (docs/AI.md §6). These wrap the SAME pure-bytes SDK ops the app uses
 * (page-furniture, merge, verify, PII) so an MCP client like Claude Desktop can
 * drive PDF operations locally, offline, no server. Kept separate from the stdio
 * wiring (server.ts) so they're unit-testable without the transport.
 *
 * Node-only (reads/writes files); pdf-lib / node-forge are all in-policy and
 * run under Node. Ops that need PDFium-WASM or canvas (render, redaction flatten)
 * are intentionally NOT here — they belong to the in-app runtime.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { addWatermark, addHeaderFooter, addBatesNumbers } from '../page-furniture.ts';
import { mergePdfs } from '../merge.ts';
import { verifyPdfSignatures } from '../verify.ts';
import { detectPii } from '../ai/pii.ts';
import { listFormFields, fillFormFields } from '../ai/form.ts';
import { signPdfWithP12, buildSelfSignedP12 } from '../sign.ts';

const read = async (p: string): Promise<Uint8Array> => new Uint8Array(await readFile(p));
const save = async (p: string, bytes: Uint8Array): Promise<void> => {
  await writeFile(p, bytes);
};

export interface WatermarkArgs {
  input: string;
  output: string;
  text: string;
  opacity?: number;
  rotation?: number;
  fontSize?: number;
  color?: string;
  pages?: number[];
}
export async function watermarkFile(a: WatermarkArgs) {
  const out = await addWatermark(await read(a.input), {
    text: a.text,
    opacity: a.opacity,
    rotation: a.rotation,
    fontSize: a.fontSize,
    color: a.color,
    pages: a.pages,
  });
  await save(a.output, out);
  return { output: a.output, bytes: out.length };
}

export interface HeaderFooterArgs {
  input: string;
  output: string;
  header?: { left?: string; center?: string; right?: string };
  footer?: { left?: string; center?: string; right?: string };
  fontSize?: number;
  margin?: number;
  skipFirstPage?: boolean;
}
export async function headerFooterFile(a: HeaderFooterArgs) {
  const out = await addHeaderFooter(await read(a.input), {
    header: a.header,
    footer: a.footer,
    fontSize: a.fontSize,
    margin: a.margin,
    skipFirstPage: a.skipFirstPage,
  });
  await save(a.output, out);
  return { output: a.output, bytes: out.length };
}

export interface BatesArgs {
  input: string;
  output: string;
  prefix?: string;
  startNumber?: number;
  digits?: number;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  fontSize?: number;
  margin?: number;
  pages?: number[];
}
export async function batesFile(a: BatesArgs) {
  const out = await addBatesNumbers(await read(a.input), {
    prefix: a.prefix,
    startNumber: a.startNumber,
    digits: a.digits,
    position: a.position,
    fontSize: a.fontSize,
    margin: a.margin,
    pages: a.pages,
  });
  await save(a.output, out);
  return { output: a.output, bytes: out.length };
}

export interface MergeArgs {
  inputs: string[];
  output: string;
  position?: 'append' | 'prepend';
}
export async function mergeFiles(a: MergeArgs) {
  if (!a.inputs?.length) throw new Error('inputs must be a non-empty array');
  let acc = await read(a.inputs[0]);
  for (let i = 1; i < a.inputs.length; i++) {
    acc = await mergePdfs(acc, await read(a.inputs[i]), { position: a.position });
  }
  await save(a.output, acc);
  return { output: a.output, merged: a.inputs.length, bytes: acc.length };
}

export async function verifyFile(a: { input: string }) {
  const sigs = await verifyPdfSignatures(await read(a.input));
  return {
    count: sigs.length,
    signatures: sigs.map((s) => ({
      signerName: s.signerName,
      issuerName: s.issuerName,
      valid: s.valid,
      digestValid: s.digestValid,
      signatureValid: s.signatureValid,
      selfSigned: s.selfSigned,
      coversWholeDocument: s.coversWholeDocument,
      signedAt: s.signedAt,
      certValidFrom: s.certValidFrom,
      certValidTo: s.certValidTo,
      reason: s.reason,
    })),
  };
}

export async function listFormFieldsFile(a: { input: string }) {
  return { fields: await listFormFields(await read(a.input)) };
}

export interface FillFormArgs {
  input: string;
  output: string;
  fields: { name: string; value: string }[];
}
export async function fillFormFile(a: FillFormArgs) {
  if (!Array.isArray(a.fields) || a.fields.length === 0) throw new Error('fields must be a non-empty array of {name, value}');
  const values = a.fields.map((f) => ({
    name: f.name,
    value: f.value === 'true' ? true : f.value === 'false' ? false : String(f.value ?? ''),
  }));
  const res = await fillFormFields(await read(a.input), values);
  await save(a.output, res.bytes);
  return { output: a.output, filled: res.filled, skipped: res.skipped };
}

export interface SignArgs {
  input: string;
  output: string;
  /** Path to a PKCS#12 (.p12/.pfx) identity. Omit to mint a throwaway self-signed one. */
  p12?: string;
  passphrase?: string;
  name?: string;
  reason?: string;
  location?: string;
}
export async function signFile(a: SignArgs) {
  const pdf = await read(a.input);
  let p12: Uint8Array;
  let passphrase: string;
  let selfSigned = false;
  if (a.p12) {
    p12 = new Uint8Array(await readFile(a.p12));
    passphrase = a.passphrase ?? '';
  } else {
    // No cert supplied → mint a throwaway self-signed identity (unverifiable
    // trust, but a real cryptographic PKCS#7 signature). Container passphrase
    // matches buildSelfSignedP12's ('casual-pdf').
    const b64 = await buildSelfSignedP12(a.name ?? 'Casual PDF Signer');
    p12 = new Uint8Array(Buffer.from(b64, 'base64'));
    passphrase = 'casual-pdf';
    selfSigned = true;
  }
  const signed = await signPdfWithP12(pdf, p12, passphrase, {
    signerName: a.name,
    reason: a.reason,
    location: a.location,
  });
  await save(a.output, signed);
  return { output: a.output, signedBy: a.name ?? 'Casual PDF Signer', selfSigned, bytes: signed.length };
}

export function detectPiiText(a: { text: string }) {
  const hits = detectPii(a.text ?? '');
  const found: Record<string, number> = {};
  for (const h of hits) found[h.type] = (found[h.type] ?? 0) + 1;
  // Types + counts only — never echo the PII values.
  return { count: hits.length, found };
}
