// End-to-end test of the font-substitution path in text editing: when new
// characters (digits/punctuation not in the original run) are typed, editTextRun
// swaps the run to a standard PDF font (Helvetica/Times/Courier) via
// FPDFText_LoadStandardFont so the new glyphs render correctly.
//
// The sample.pdf run "The quick brown fox…" has no digits — typing "2026" inside
// triggers the substitution. The downloaded bytes must contain "2026" (proving
// PDFium encoded the new glyphs via the standard font).
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
await new Promise((r) => server.listen(8152, '127.0.0.1', r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e)); });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };

try {
  await page.goto('http://127.0.0.1:8152/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.getByRole('tab', { name: 'Edit mode' }).click();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: 'Edit existing text' }).click();
  // Wait for text-run boxes (PDFium WASM loads from CDN first time).
  const run = page.getByRole('button', { name: /Edit text: The quick brown fox/ });
  await run.waitFor({ state: 'visible', timeout: 30000 });
  console.log('text-run boxes appeared');

  // Click the run and type text that includes characters not in the original
  // ("2", "0", "6" are digits absent from "The quick brown fox…") → triggers
  // font substitution (fetchSubstituteFont → Arimo from CDN).
  await run.click();
  const input = page.locator('.cpdf__textedit-input');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  const NEW_TEXT = 'Casual PDF v2026 — fast!';
  await input.fill(NEW_TEXT);
  await input.press('Enter');

  // Standard font substitution is synchronous — no CDN fetch needed.
  await page.waitForTimeout(4000);
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(1000);

  // Check no error banner appeared.
  const banner = page.locator('.cpdf__placebanner');
  const bannerText = await banner.textContent().catch(() => '');
  console.log('banner text after edit:', JSON.stringify(bannerText?.slice(0, 80)));
  assert(!/failed|error/i.test(bannerText ?? ''), 'no error in the text-edit banner after substitution');

  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.keyboard.press('Meta+s'),
  ]);
  await dl.saveAs('/tmp/ui-fontsub.pdf');
  const text = execSync(`python3 ${join(here, 'extract-text.py')} /tmp/ui-fontsub.pdf`, { maxBuffer: 64 * 1024 * 1024 }).toString();
  console.log('extracted text (first 120 chars):', JSON.stringify(text.slice(0, 120)));

  assert(/2026/i.test(text), 'new digit "2026" present — substitute font embedded and encodes new glyphs');
  assert(!/\bquick\b/i.test(text), 'original "quick" replaced (not duplicated)');
  assert(/parity/i.test(text), 'rest of the document is intact');
  assert(!/failed|error|unreachable/i.test(bannerText ?? ''), 'no error in the banner after substitution (re-check)');
  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) {
  console.log('DRIVER ERROR:', e.message);
  failed = true;
} finally {
  await browser.close(); server.close();
  process.exit(failed ? 1 : 0);
}
