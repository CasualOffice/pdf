// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// E2E for region-only "Keep text" redaction (the user's report: after redaction
// you can't edit/select text). Redact page 1 of multi.pdf in "Keep text" mode and
// assert the redacted page's OTHER text is still editable in-app AND still present
// in the downloaded bytes (cover, not remove).
//
//   node tools/render-parity/verify-redact-cover-ui.mjs
//
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
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const rel = normalize(p).replace(/^(\.\.[/\\])+/, '');
    let b;
    try { b = await readFile(join(root, rel)); }
    catch { b = await readFile(join(fixtures, rel.replace(/^\/+/, ''))); }
    res.setHeader('Content-Type', MIME[extname(rel)] || 'application/octet-stream');
    res.end(b);
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => server.listen(8160, '127.0.0.1', r));

const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e)); });

let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };

try {
  await page.goto('http://127.0.0.1:8160/?src=%2Fmulti.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.getByRole('tab', { name: 'Edit mode' }).click();
  await page.waitForTimeout(300);

  // Redact a box on page 1.
  await page.getByRole('button', { name: /Redact \(permanently remove regions\)/ }).click();
  await page.waitForTimeout(300);
  const p1 = page.locator('.cpdf__page').first();
  const box = await p1.boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.3, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Apply redactions' }).click();
  await page.waitForTimeout(300);

  // Choose "Keep text" mode, then cover.
  assert(await page.locator('[data-testid=redact-mode-cover]').isVisible(), 'redaction mode toggle present (Keep text)');
  await page.locator('[data-testid=redact-mode-cover]').click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Cover regions' }).click();
  await page.waitForTimeout(2500);
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(1000);

  // The redacted page's OTHER text must still be editable (the user's complaint).
  await page.getByRole('button', { name: /Quick text edits/ }).click();
  await page.waitForTimeout(1000);
  const runs = await page.getByRole('button', { name: /Edit text:/ }).count();
  console.log('editable runs on page 1 after Keep-text redaction:', runs);
  assert(runs > 0, 'text on the redacted page is STILL editable after Keep-text redaction');
  await page.getByRole('button', { name: /Quick text edits/ }).click().catch(() => {}); // exit

  // Download → the page's text is still in the bytes (cover, not remove).
  await page.waitForTimeout(500);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.keyboard.press('Meta+s'),
  ]);
  await dl.saveAs('/tmp/covered-ui.pdf');
  const text = execSync(`python3 ${join(here, 'extract-text.py')} /tmp/covered-ui.pdf`, { maxBuffer: 64 * 1024 * 1024 }).toString();
  console.log('downloaded text (first 90):', JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 90)));
  assert(/appleone/.test(text), 'redacted page 1 keeps its text in the downloaded file (Keep-text mode)');

  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) {
  console.log('FAIL: exception', String(e));
  failed = true;
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
