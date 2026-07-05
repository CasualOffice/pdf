// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// E2E for AI source-span highlighting. A deterministic transport is injected; it
// reads the REAL page text (get_page_text), picks a real word, and calls
// highlight_source(0, word). That runs the REAL bridge → findRunsForText →
// CasualPdfApi.highlightRegion → a highlight annotation at the run's actual
// user-space rect. We then download and assert a Highlight annotation is baked
// into the bytes — proving the coordinate shape + create + bake integration.
//
//   node tools/render-parity/verify-ai-highlight.mjs
//
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
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
await new Promise((r) => server.listen(8156, '127.0.0.1', r));

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
        // Read the real page text, pick a real word, highlight it.
        const pt = await payload.toolExecutor('get_page_text', { page: 0 });
        const text = (pt && pt.data && pt.data.text) || '';
        const word = (text.match(/[A-Za-z]{4,}/) || [null])[0];
        window.__hlWord__ = word;
        if (word) {
          window.__hlResult__ = await payload.toolExecutor('highlight_source', { page: 0, text: word });
        }
        payload.onText && payload.onText(word ? `Highlighted "${word}" on page 1.` : 'No text found.');
        return { data: { ok: true }, status: 200, updatedHistory: [] };
      },
    };
  });

  await page.goto('http://127.0.0.1:8156/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });

  // Enter Edit mode so annotations render + Download bakes them.
  await page.getByRole('tab', { name: 'Edit mode' }).click().catch(() => {});
  await page.waitForTimeout(300);

  await page.locator('[data-testid=ai-toggle]').click();
  await page.locator('[data-testid=ai-input]').fill('What does the document say? Highlight it.');
  await page.locator('[data-testid=ai-send]').click();

  await page.locator('[data-testid=ai-answer]').last().waitFor({ state: 'visible', timeout: 20000 });
  const word = await page.evaluate(() => window.__hlWord__);
  const hl = await page.evaluate(() => window.__hlResult__);
  console.log('highlighted word:', JSON.stringify(word), '| tool result:', JSON.stringify(hl));
  assert(!!word, 'read a real word from the page via get_page_text');
  assert(hl && hl.ok && hl.data && hl.data.highlighted >= 1, 'highlight_source highlighted the run (via the real bridge → viewer)');

  // Download and confirm a Highlight annotation is baked into the bytes.
  await page.waitForTimeout(500);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.keyboard.press('Meta+s'),
  ]);
  await dl.saveAs('/tmp/ai-highlight.pdf');
  const bytes = await readFile('/tmp/ai-highlight.pdf');
  assert(bytes.includes('Highlight'), 'a Highlight annotation is baked into the downloaded PDF');

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
