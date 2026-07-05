// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// E2E for SURGICAL text redaction (the user's real ask): remove the text under a
// marked region from the file, keep the rest of the page as real text. A
// deterministic transport uses mark_redaction to target the word "appleone"
// precisely; we redact in the default "Remove text" mode and assert that word is
// GONE from the bytes while the rest of the page (and other pages) keep their text.
//
//   node tools/render-parity/verify-redact-text.mjs
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
await new Promise((r) => server.listen(8161, '127.0.0.1', r));

const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e)); });

let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };

try {
  await page.addInitScript(() => {
    window.__casualPdfAiTransport__ = {
      drivesLoop: true,
      label: 'Test',
      async call(payload) {
        window.__mk__ = await payload.toolExecutor('mark_redaction', { page: 0, text: 'appleone' });
        payload.onText && payload.onText('Marked "appleone" for redaction.');
        return { data: { ok: true }, status: 200, updatedHistory: [] };
      },
    };
  });

  await page.goto('http://127.0.0.1:8161/?src=%2Fmulti.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });

  // AI marks the exact word (auto-switches to Edit mode).
  await page.locator('[data-testid=ai-toggle]').click();
  await page.locator('[data-testid=ai-input]').fill('Redact appleone');
  await page.locator('[data-testid=ai-send]').click();
  await page.locator('[data-testid=ai-answer]').last().waitFor({ state: 'visible', timeout: 20000 });
  const mk = await page.evaluate(() => window.__mk__);
  console.log('mark result:', JSON.stringify(mk));
  assert(mk && mk.data && mk.data.marked >= 1, 'AI marked the word "appleone"');

  // Apply in the default "Remove text" (surgical) mode.
  await page.getByRole('button', { name: 'Apply redactions' }).click();
  await page.waitForTimeout(300);
  assert((await page.locator('[data-testid=redact-mode-text]').getAttribute('aria-checked')) === 'true', 'Remove text is the default mode');
  await page.getByRole('button', { name: 'Remove text & redact' }).click();
  await page.waitForTimeout(3500);
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(1000);

  // Download and check the bytes.
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.keyboard.press('Meta+s'),
  ]);
  await dl.saveAs('/tmp/redact-text.pdf');
  const text = execSync(`python3 ${join(here, 'extract-text.py')} /tmp/redact-text.pdf`, { maxBuffer: 64 * 1024 * 1024 }).toString().replace(/\s+/g, ' ');
  console.log('post-redaction text (first 160):', JSON.stringify(text.slice(0, 160)));
  assert(!/appleone/.test(text), 'the redacted word "appleone" is REMOVED from the bytes');
  assert(/ALPHA/.test(text) && /Common line/.test(text), 'the REDACTED page keeps its other text (not flattened away)');
  assert(/bananatwo/.test(text) && /cherrythree/.test(text), 'other pages keep their text');

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
