// End-to-end test of the in-app text-edit UI: Edit mode → "Edit text" tool →
// click the run → retype → Enter → reload → download → verify the bytes changed.
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
await new Promise((r) => server.listen(8149, '127.0.0.1', r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e)); });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };

try {
  await page.goto('http://127.0.0.1:8149/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.getByRole('tab', { name: 'Edit mode' }).click();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: 'Edit existing text' }).click();
  // listTextRuns loads PDFium from CDN → run boxes appear.
  const run = page.getByRole('button', { name: /Edit text: The quick brown fox/ });
  await run.waitFor({ state: 'visible', timeout: 30000 });
  console.log('text-run boxes appeared');
  await run.click();
  const input = page.locator('.cpdf__textedit-input');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill('The slow brown fox jumps over the lazy dog.');
  await input.press('Enter');
  // commit → editTextRun → openDocumentBuffer reload.
  await page.waitForTimeout(2500);
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(1000);

  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.keyboard.press('Meta+s'),
  ]);
  await dl.saveAs('/tmp/ui-edited.pdf');
  const text = execSync(`python3 ${join(here, 'extract-text.py')} /tmp/ui-edited.pdf`, { maxBuffer: 64 * 1024 * 1024 }).toString();
  console.log('text:', JSON.stringify(text.slice(0, 90)));
  assert(/\bslow\b/i.test(text), 'edited "slow" present in the downloaded doc (UI → true edit)');
  assert(!/\bquick\b/i.test(text), 'original "quick" gone');
  assert(/parity/i.test(text), 'rest of the document preserved');
  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) {
  console.log('DRIVER ERROR:', e.message);
  failed = true;
} finally {
  await browser.close(); server.close();
  process.exit(failed ? 1 : 0);
}
