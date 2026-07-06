// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// CHAR-LEVEL redaction (via the Rust core): box ONLY the middle word "BBBB" of one
// text run "AAAA BBBB CCCC" (embedded Arimo = Type0/CID, the real-PDF case) and
// assert just "BBBB" is removed while "AAAA"/"CCCC" survive as real text.
//   node tools/render-parity/verify-redact-split.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const fixtures = resolve(here, 'fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const rel = normalize(p).replace(/^(\.\.[/\\])+/, '');
    let b; try { b = await readFile(join(root, rel)); } catch { b = await readFile(join(fixtures, rel.replace(/^\/+/, ''))); }
    res.setHeader('Content-Type', MIME[extname(rel)] || 'application/octet-stream'); res.end(b);
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => server.listen(8163, '127.0.0.1', r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e)); });
let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };

try {
  await page.goto('http://127.0.0.1:8163/?src=%2Fsplitline.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.getByRole('tab', { name: 'Edit mode' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Redact \(permanently remove regions\)/ }).click();
  await page.waitForTimeout(300);
  // Box just "BBBB" (Arimo size 20 on a 400pt page → ~x 78–130, frac 0.2–0.325; y ~0.36–0.52).
  const el = page.locator('.cpdf__page').first();
  const b = await el.boundingBox();
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.36);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.325, b.y + b.height * 0.52, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Apply redactions' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Remove text & redact' }).click();
  await page.waitForTimeout(2500);
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(800);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.keyboard.press('Meta+s')]);
  await dl.saveAs('/tmp/splitline-redacted.pdf');
  // fitz (PyMuPDF) decodes the CID→unicode ToUnicode CMap; the naive extractor can't.
  const text = execSync(`python3 -c "import fitz; print(fitz.open('/tmp/splitline-redacted.pdf')[0].get_text())"`).toString().replace(/\s+/g, ' ').trim();
  console.log('BEFORE: AAAA BBBB CCCC');
  console.log('AFTER :', JSON.stringify(text));
  assert(!/BBBB/.test(text), 'the boxed middle word "BBBB" is REMOVED');
  assert(/AAAA/.test(text), 'the prefix "AAAA" survives (char-level, not whole-line removal)');
  assert(/CCCC/.test(text), 'the suffix "CCCC" survives in place');
  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) { console.log('FAIL: exception', String(e)); failed = true; }
finally { await browser.close(); server.close(); }
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
