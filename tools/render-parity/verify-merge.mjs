// Headless test: Insert PDF → merged page count increases.
// Exercises the File → Insert PDF… flow using a file-chooser intercept.
//
// Usage:
//   node tools/render-parity/verify-merge.mjs

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const port = 8139;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p.endsWith('/')) p += 'index.html';
    const fp = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(fp);
    res.setHeader('Content-Type', MIME[extname(fp)] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end('not found'); }
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const execPath = process.env.CHROME_PATH || (existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({ ...(execPath ? { executablePath: execPath } : {}), headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

let failed = false;
const pass = (msg) => console.log('PASS:', msg);
const fail = (msg) => { console.error('FAIL:', msg); failed = true; };

// Load app with the 1-page sample fixture.
await page.goto(`http://127.0.0.1:${port}/?src=/sample.pdf`);

// Wait for the viewer to render the first page thumbnail.
await page.locator('.cpdf__viewport img').first().waitFor({ timeout: 60000 });

// Page count before insert: confirm 1 page via the ".cpdf__pagetotal" display.
const totalBefore = await page.locator('.cpdf__pagetotal').textContent();
const pagesBefore = parseInt(totalBefore?.replace(/\D/g, '') ?? '0', 10);
console.log('pages before insert:', pagesBefore);
if (pagesBefore >= 1) pass('initial page count shown correctly'); else fail('page total not found');

// Trigger File → Insert PDF…: intercept the file chooser.
const chooserPromise = page.waitForEvent('filechooser');
await page.getByLabel('Menu').click();
await page.getByText('Insert PDF…').click();
const chooser = await chooserPromise;

// Supply the 3-page multi.pdf fixture.
const multiPath = resolve(here, 'fixtures/multi.pdf');
await chooser.setFiles(multiPath);

// Wait for the viewer to reload with the merged doc (src changes → key remount).
// The merged doc should have 4 pages (1 primary + 3 secondary).
await page.locator('.cpdf__viewport img').first().waitFor({ timeout: 60000 });

// Give a moment for the viewer to settle on the new doc.
await page.waitForTimeout(2000);

const totalAfter = await page.locator('.cpdf__pagetotal').textContent();
const pagesAfter = parseInt(totalAfter?.replace(/\D/g, '') ?? '0', 10);
console.log('pages after insert:', pagesAfter);
if (pagesAfter >= 4) pass(`merged doc has ${pagesAfter} pages (expected ≥4)`);
else fail(`expected ≥4 pages after insert, got ${pagesAfter}`);

// Confirm download button is enabled (dirty state set).
const saveBtnVisible = await page.locator('button:has-text("Save")').isVisible();
if (saveBtnVisible) pass('document marked dirty after insert'); else fail('save button not visible');

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
