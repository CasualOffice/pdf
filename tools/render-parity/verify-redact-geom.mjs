// Redaction geometry probe: redact a region on page 0 (a /Rotate-90 page) of the
// geom fixture, download the result, and report the rendered canvas dims + saved
// file so we can check the output preserves MediaBox/CropBox/Rotate.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

let failed = false;
const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) failed = true; };

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
await new Promise((r) => server.listen(8143, '127.0.0.1', r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 1 });
page.on('console', (m) => { const t = m.text(); if (t.includes('[flatten]') || m.type() === 'error') console.log('CONSOLE', t); });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));

try {
  await page.goto('http://127.0.0.1:8143/?src=%2Fgeom.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.locator('.cpdf__page').first().screenshot({ path: '/tmp/geom-original-page0.png' });
  console.log('screenshot /tmp/geom-original-page0.png (before redaction)');
  await page.getByRole('tab', { name: 'Edit mode' }).click();
  await page.waitForTimeout(300);
  // Activate Redact tool, drag a small box on the first page.
  await page.getByRole('button', { name: /Redact \(permanently remove regions\)/ }).click();
  await page.waitForTimeout(300);
  const pageEl = page.locator('.cpdf__page').first();
  const box = await pageEl.boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.32, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Apply redactions' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Redact & remove' }).click();
  await page.waitForTimeout(3500);
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(1200);
  await page.locator('.cpdf__page').first().screenshot({ path: '/tmp/geom-redacted-page0.png' });
  console.log('screenshot /tmp/geom-redacted-page0.png');
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.keyboard.press('Meta+s'),
  ]);
  await dl.saveAs('/tmp/geom-redacted.pdf');
  console.log('saved /tmp/geom-redacted.pdf');

  // Geometry preserved? (page 0 keeps /Rotate 90; page 1 keeps MediaBox origin.)
  const geomJson = execSync(
    `node -e "const {PDFDocument}=require('pdf-lib');const fs=require('fs');(async()=>{const d=await PDFDocument.load(fs.readFileSync('/tmp/geom-redacted.pdf'));console.log(JSON.stringify(d.getPages().map(p=>({x:p.getMediaBox().x,w:p.getMediaBox().width,rot:p.getRotation().angle}))));})();"`,
    { cwd: resolve(here, '../../packages/pdf-sdk') },
  ).toString().trim().split('\n').pop();
  const pages = JSON.parse(geomJson);
  console.log('output geometry:', geomJson);
  assert(pages[0].rot === 90, 'redacted page 0 keeps its /Rotate 90 (no orientation flip)');
  assert(Math.round(pages[0].w) === 612, 'redacted page 0 keeps its MediaBox dimensions');
  assert(Math.round(pages[1].x) === 36, 'untouched page 1 keeps its non-zero MediaBox origin');

  // Text: redacted page rasterized (text gone); untouched page keeps its text.
  const t = execSync(`python3 ${join(here, 'extract-text.py')} /tmp/geom-redacted.pdf`, { maxBuffer: 64 * 1024 * 1024 }).toString();
  assert(!/ROTATED|quick/i.test(t), 'redacted page 0 text removed from the byte stream (UX-S5)');
  assert(/OFFSET|secret/i.test(t), 'untouched page 1 keeps its selectable text');
} catch (e) {
  console.log('DRIVER ERROR', e.message);
  failed = true;
} finally {
  await browser.close(); server.close();
  process.exit(failed ? 1 : 0);
}
