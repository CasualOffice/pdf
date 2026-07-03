// E2E for overlay "Secure (flatten)" edit ("Option A" bake mode, docs/TEXT-EDITING.md).
// With Overlay + Secure ON, a commit renders the page, paints the cover box + new
// text, and rebuilds the page as an image (reusing the redaction flatten) — so the
// ORIGINAL text is truly removed from the bytes, not merely covered.
//
// Asserts: the original word ("quick") is GONE from the downloaded bytes (the
// security property); no page errors. (The new text is rasterized, so it is not
// extractable — a visual concern, not checked here.)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const fp = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const b = await readFile(fp); res.setHeader('Content-Type', MIME[extname(fp)] || 'application/octet-stream'); res.end(b);
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => server.listen(8154, '127.0.0.1', r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e)); });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };

try {
  await page.goto('http://127.0.0.1:8154/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.getByRole('tab', { name: 'Edit mode' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Quick text edits/ }).click();

  const run = page.getByRole('button', { name: /Edit text: The quick brown fox/ });
  await run.waitFor({ state: 'visible', timeout: 30000 });

  await page.getByRole('button', { name: /Overlay/ }).click();
  const secure = page.getByRole('button', { name: /Secure/ });
  await secure.click();
  assert((await secure.getAttribute('aria-pressed')) === 'true', 'Secure (flatten) mode toggles on');

  await run.click();
  const input = page.locator('.cpdf__textedit-input');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill('REDACTEDREPLACED');
  await input.press('Enter');
  await page.waitForTimeout(4500); // render + flatten + rebuild
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(800);

  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.keyboard.press('Meta+s'),
  ]);
  await dl.saveAs('/tmp/ui-overlay-bake.pdf');
  const text = execSync(`python3 ${join(here, 'extract-text.py')} /tmp/ui-overlay-bake.pdf`, { maxBuffer: 64 * 1024 * 1024 }).toString();
  console.log('extracted (first 160):', JSON.stringify(text.slice(0, 160)));
  assert(!/\bquick\b/i.test(text), 'original "quick" is GONE from the bytes (truly removed by flatten)');
  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) {
  console.log('DRIVER ERROR:', e.message);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
