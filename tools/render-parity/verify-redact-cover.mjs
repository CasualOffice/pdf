// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Node driver for region-only redaction (buildCoveredPdf, "Keep text" mode). The
// defining property vs the secure flatten: the page's text is PRESERVED (only a
// black box is drawn over the marked region). Also checks geometry is preserved
// on a /Rotate-90 + origin-shifted page (geom.pdf).
//
//   node --experimental-transform-types tools/render-parity/verify-redact-cover.mjs
//
import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCoveredPdf } from '../../packages/pdf-sdk/src/redact.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => resolve(here, 'fixtures', n);
let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };
const extract = (p) => execSync(`python3 ${join(here, 'extract-text.py')} ${p}`, { maxBuffer: 64 * 1024 * 1024 }).toString();
const pdfLib = await import('pdf-lib');

try {
  // multi.pdf: 3 pages (ALPHA/appleone, BRAVO/bananatwo, CHARLIE/cherrythree).
  const multi = new Uint8Array(await readFile(fx('multi.pdf')));
  const covered = await buildCoveredPdf(multi, [{ pageIndex: 0, x: 0.1, y: 0.1, w: 0.6, h: 0.12 }]);
  await writeFile('/tmp/covered.pdf', covered);
  const text = extract('/tmp/covered.pdf').replace(/\s+/g, ' ');
  console.log('covered text (first 120):', JSON.stringify(text.slice(0, 120)));
  // KEY: text is PRESERVED (this is the whole point — vs flatten which removes it).
  assert(/appleone/.test(text), 'redacted page 0 keeps its text (cover mode preserves the text layer)');
  assert(/bananatwo/.test(text) && /cherrythree/.test(text), 'other pages keep their text');
  const doc = await pdfLib.PDFDocument.load(covered);
  assert(doc.getPageCount() === 3, 'page count preserved');

  // geom.pdf: page 0 = /Rotate 90 (origin 0); page 1 = non-rotated, MediaBox origin 36.
  // Cover a mark on each — must not crash + keep geometry + keep text.
  const geom = new Uint8Array(await readFile(fx('geom.pdf')));
  const gcov = await buildCoveredPdf(geom, [
    { pageIndex: 0, x: 0.2, y: 0.2, w: 0.3, h: 0.1 },
    { pageIndex: 1, x: 0.2, y: 0.2, w: 0.3, h: 0.1 },
  ]);
  const gdoc = await pdfLib.PDFDocument.load(gcov);
  assert(gdoc.getPage(0).getRotation().angle === 90, 'rotated page 0 keeps /Rotate 90');
  assert(Math.round(gdoc.getPage(1).getMediaBox().x) === 36, 'offset page 1 keeps its MediaBox origin (36)');
  await writeFile('/tmp/geom-cov.pdf', gcov);
  assert(/ROTATED|quick/i.test(extract('/tmp/geom-cov.pdf')), 'rotated page keeps its text under cover mode');
} catch (e) {
  console.log('FAIL: exception', String(e));
  failed = true;
}
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
