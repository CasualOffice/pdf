// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the Casual PDF MCP server: the tool registry + the file-in/
// file-out handlers, exercised with real pdf-lib documents. No stdio transport.
//
//   node --experimental-transform-types --test tools/render-parity/verify-mcp.test.ts
//
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_TOOLS, createServer } from '../../packages/pdf-sdk/src/mcp/server.ts';
import { mergeFiles, watermarkFile, verifyFile, detectPiiText, listFormFieldsFile, fillFormFile, signFile } from '../../packages/pdf-sdk/src/mcp/handlers.ts';

const tmp = (n: string) => join(tmpdir(), n);
async function onePagePdf(path: string, label: string) {
  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.create();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  doc.addPage([300, 200]).drawText(label, { x: 20, y: 150, size: 14, font });
  // Classic xref table (not an object stream) so @signpdf/placeholder-plain can read it.
  await writeFile(path, await doc.save({ useObjectStreams: false }));
}
const pageCount = async (path: string) => (await (await import('pdf-lib')).PDFDocument.load(await readFile(path))).getPageCount();

test('MCP_TOOLS registry is well-formed and sorted by name', () => {
  const names = MCP_TOOLS.map((t) => t.name);
  assert.deepEqual([...names].sort(), names); // sorted (stability)
  assert.deepEqual(names, ['add_bates', 'add_header_footer', 'add_watermark', 'detect_pii', 'fill_form', 'list_form_fields', 'merge_pdfs', 'sign_pdf', 'verify_signatures']);
  for (const t of MCP_TOOLS) {
    assert.equal(typeof t.description, 'string');
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(typeof t.run, 'function');
  }
});

test('createServer builds without throwing', () => {
  const s = createServer();
  assert.ok(s && typeof s.connect === 'function');
});

test('merge_pdfs handler concatenates files on disk', async () => {
  const a = tmp('mcp-a.pdf');
  const b = tmp('mcp-b.pdf');
  const out = tmp('mcp-merged.pdf');
  await onePagePdf(a, 'A');
  await onePagePdf(b, 'B');
  const res = await mergeFiles({ inputs: [a, b], output: out });
  assert.equal(res.merged, 2);
  assert.equal(await pageCount(out), 2);
});

test('add_watermark handler writes a larger, valid PDF', async () => {
  const src = tmp('mcp-wm-src.pdf');
  const out = tmp('mcp-wm-out.pdf');
  await onePagePdf(src, 'Body');
  const before = (await readFile(src)).length;
  const res = await watermarkFile({ input: src, output: out, text: 'CONFIDENTIAL' });
  assert.ok(res.bytes > before, 'watermarked file grew');
  assert.equal(await pageCount(out), 1); // still valid
});

test('verify_signatures handler reports zero on an unsigned PDF', async () => {
  const src = tmp('mcp-unsigned.pdf');
  await onePagePdf(src, 'x');
  const res = await verifyFile({ input: src });
  assert.equal(res.count, 0);
});

test('list_form_fields + fill_form handlers round-trip on disk', async () => {
  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.create();
  const p = doc.addPage([300, 200]);
  const form = doc.getForm();
  form.createTextField('email').addToPage(p, { x: 20, y: 150, width: 200, height: 20 });
  const src = tmp('mcp-form-src.pdf');
  const out = tmp('mcp-form-out.pdf');
  await writeFile(src, await doc.save());

  const listed = await listFormFieldsFile({ input: src });
  assert.ok(listed.fields.some((f) => f.name === 'email' && f.type === 'text'));
  const res = await fillFormFile({ input: src, output: out, fields: [{ name: 'email', value: 'a@b.com' }] });
  assert.deepEqual(res.filled, ['email']);
  const after = await listFormFieldsFile({ input: out });
  assert.equal(after.fields.find((f) => f.name === 'email')?.value, 'a@b.com'); // persisted
});

test('sign_pdf (self-signed) produces a real PKCS#7 that verify_signatures confirms', async () => {
  const src = tmp('mcp-sign-src.pdf');
  const out = tmp('mcp-signed.pdf');
  await onePagePdf(src, 'sign me');
  const res = await signFile({ input: src, output: out, name: 'Ada Lovelace' });
  assert.equal(res.selfSigned, true);
  assert.equal(res.signedBy, 'Ada Lovelace');
  const v = await verifyFile({ input: out });
  assert.equal(v.count, 1); // one signature present
  assert.equal(v.signatures[0].digestValid, true); // document intact (digest matches)
  assert.equal(v.signatures[0].signatureValid, true); // RSA signature valid
  assert.equal(v.signatures[0].selfSigned, true); // trust caveat surfaced
});

test('detect_pii handler returns type counts, not values', () => {
  const res = detectPiiText({ text: 'card 4111 1111 1111 1111 and email a@b.com' });
  assert.ok(res.found['credit-card'] >= 1 && res.found['email'] >= 1);
  assert.ok(!JSON.stringify(res).includes('4111')); // values not echoed
});
