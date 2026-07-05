// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// E2E for AI summarization. Reproduces the reported bug (assistant returns only
// "N pages, no outline" and never reads the content) and proves the fix: a
// deterministic transport calls get_document_text, which runs the REAL bridge →
// extractAllText → whole-document text with page markers, so the model can
// actually summarize. Asserts the returned text carries real page content.
//
//   node tools/render-parity/verify-ai-summarize.mjs
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
await new Promise((r) => server.listen(8158, '127.0.0.1', r));

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
        // A model summarizing SHOULD read the content, not stop at get_document_info.
        const info = await payload.toolExecutor('get_document_info', {});
        window.__pageCount__ = info?.data?.pageCount ?? 0;
        const doc = await payload.toolExecutor('get_document_text', {});
        window.__docText__ = (doc && doc.data && doc.data.text) || '';
        window.__docMeta__ = doc && doc.data ? { pages: doc.data.pages, pagesIncluded: doc.data.pagesIncluded } : null;
        const body = window.__docText__.replace(/\[Page \d+\]/g, ' ').replace(/\s+/g, ' ').trim();
        payload.onText && payload.onText(`Summary: ${body.slice(0, 80)}`);
        return { data: { ok: true }, status: 200, updatedHistory: [] };
      },
    };
  });

  await page.goto('http://127.0.0.1:8158/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });

  await page.locator('[data-testid=ai-toggle]').click();
  await page.locator('[data-testid=ai-input]').fill('Summarize this document');
  await page.locator('[data-testid=ai-send]').click();
  await page.locator('[data-testid=ai-answer]').last().waitFor({ state: 'visible', timeout: 20000 });

  const docText = await page.evaluate(() => window.__docText__);
  const meta = await page.evaluate(() => window.__docMeta__);
  const answer = (await page.locator('[data-testid=ai-answer]').last().textContent()) || '';
  console.log('doc meta:', JSON.stringify(meta), '| text len:', (docText || '').length);
  console.log('answer:', JSON.stringify(answer.slice(0, 100)));

  assert(!!docText && docText.length > 40, 'get_document_text returned real document text (not empty)');
  assert(/\[Page 1\]/.test(docText), 'text is page-labelled ([Page 1] marker present)');
  assert(meta && meta.pages >= 1, 'reports the page count');
  // The streamed summary reflects the actual content (a word carried through).
  const firstWord = (docText.replace(/\[Page \d+\]/g, ' ').match(/[A-Za-z]{4,}/) || [''])[0];
  assert(!!firstWord && answer.includes(firstWord), `summary reflects real content ("${firstWord}")`);
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
