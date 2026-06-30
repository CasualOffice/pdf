// Headless interaction driver for the built web app. Serves apps/web/dist +
// the fixture same-origin, loads it via ?src=, and exercises editor features.
// Currently verifies the marquee multi-select (Phase 2, UX-I3).
//
// Usage: node verify-drive.mjs [--src /sample.pdf] [--chrome <path>]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, arg('root', '../../apps/web/dist'));
const src = arg('src', '/sample.pdf');
const port = 8137;
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
const execPath = arg('chrome') || process.env.CHROME_PATH || (existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({ ...(execPath ? { executablePath: execPath } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e)); });
page.on('console', (m) => { const t = m.text(); if (t.includes('[marquee]') || t.includes('surgical') || m.type() === 'error') console.log('CONSOLE', m.type(), t); });
page.on('requestfailed', (r) => console.log('REQFAIL', r.url(), r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });

let failed = false;
const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) failed = true; };

try {
  const target = `http://127.0.0.1:${port}/?src=${encodeURIComponent(src)}`;
  await page.goto(target, { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(2000);

  await page.getByRole('tab', { name: 'Edit mode' }).click();
  await page.waitForTimeout(300);

  const pageEl = page.locator('.cpdf__page').first();
  const box = await pageEl.boundingBox();
  // Work in the blank bottom margin so neither the rect-drawing nor the marquee
  // start lands on text (which would turn the marquee into a text selection).
  const yb = box.y + box.height * 0.93;
  const drawRect = async (x0, x1) => {
    await page.keyboard.press('r');
    await page.mouse.move(box.x + x0, yb);
    await page.mouse.down();
    await page.mouse.move(box.x + x1, yb + box.height * 0.03, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  };
  await drawRect(70, 120);
  await drawRect(170, 220);

  // Diagnostic: how many annotations exist (Comments panel lists them all)?
  await page.getByRole('button', { name: 'Comments & annotations' }).click();
  await page.waitForTimeout(300);
  const annCount = await page.locator('.cpdf__comment-row').count();
  console.log('annotations created:', annCount);
  await page.getByRole('button', { name: 'Comments & annotations' }).click(); // close panel
  await page.waitForTimeout(200);

  // Marquee: Select tool, drag from the blank top-left corner across the whole
  // page (encloses both rects regardless of zoom). Starting on the corner margin
  // keeps it a marquee, not a text selection.
  await page.keyboard.press('v');
  await page.waitForTimeout(150);
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  const midMarquee = await page.locator('.cpdf__marquee').count();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height - 8, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log('marquee visible mid-drag:', midMarquee);

  const marqueeSeen = await page.locator('.cpdf__marquee').count(); // 0 after up (cleared) — informational
  const delText = (await page.locator('.cpdf__delete').textContent().catch(() => null)) ?? '(no delete button)';
  console.log('delete button text:', JSON.stringify(delText), '| marquee nodes now:', marqueeSeen);
  assert(/\(2\)/.test(delText), 'marquee selected both rectangle annotations (Delete (2))');

  // ── Autosave + crash recovery (UX-I5) ─────────────────────────────────────
  // The two rectangles above are edits → a debounced snapshot is scheduled.
  assert(!(await page.locator('.recoverybar').isVisible().catch(() => false)), 'no recovery banner on a clean start');
  await page.waitForTimeout(3200); // let the 2.5s-debounced snapshot persist to IndexedDB
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
  const bar = page.locator('.recoverybar');
  await bar.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  const barVisible = await bar.isVisible().catch(() => false);
  assert(barVisible, 'recovery banner appears after a reload with unsaved edits');
  if (barVisible) {
    await page.getByRole('button', { name: 'Restore' }).click();
    await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
    await page.waitForTimeout(1500);
    // The restored bytes are the *edited* doc — its annotations should survive.
    await page.getByRole('button', { name: 'Comments & annotations' }).click();
    await page.waitForTimeout(400);
    const restoredAnns = await page.locator('.cpdf__comment-row').count();
    console.log('annotations after restore:', restoredAnns);
    assert(restoredAnns >= 2, 'restored document still has the edited annotations');
  }

  // ── Redaction (UX-S5): flatten-only. Redacting a word rasterizes its page, so
  //    the word — and the rest of that single-page fixture's text — is no longer
  //    in the byte stream. (Untouched pages keep their text; covered by the
  //    geometry test on the multi-page fixture.) ─────────────────────────────
  const total = (s) => { const m = (s || '').match(/(\d+)\s*\/\s*(\d+)/); return m ? parseInt(m[2], 10) : NaN; };
  const searchCount = async (term) => {
    const open = await page.locator('.cpdf__search input').isVisible().catch(() => false);
    if (!open) await page.getByRole('button', { name: 'Find in document' }).first().click();
    const input = page.locator('.cpdf__search input');
    await input.waitFor({ state: 'visible', timeout: 8000 });
    await input.fill('');
    await input.fill(term);
    await page.waitForTimeout(1100); // debounce (250ms) + search
    return total(await page.locator('.cpdf__search-count').textContent());
  };

  await page.getByRole('tab', { name: 'Edit mode' }).click();
  await page.waitForTimeout(300);
  if (await page.locator('.cpdf__panel[aria-label="Comments"]').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Comments & annotations' }).click();
    await page.waitForTimeout(200);
  }

  const quickBefore = await searchCount('quick');
  console.log('search "quick" before redaction:', quickBefore);
  assert(quickBefore === 1, 'fixture has "quick" once before redaction');

  await page.getByRole('button', { name: /Redact all 1 match/ }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Apply redactions' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Redact & remove' }).click();
  // applyRedactions: saveAsCopy → render native → flatten → reopen.
  await page.waitForTimeout(4000);
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(1500);

  // In-app search after redaction: with the onDocumentReplaced → blob URL →
  // key-remount fix, EmbedPDF fully reinitializes (text layer re-indexes) after
  // the operation. Search should return 0 (rasterized page has no text), not NaN
  // or a stale pre-redaction count.
  const quickAfter = await searchCount('quick');
  console.log('search "quick" after redaction (in-app):', quickAfter);
  assert(quickAfter === 0, 'text search functional after redaction — returns 0 for rasterized page, not stale/NaN');

  // Authoritative UX-S5 check: download the redacted result and extract its text.
  const dlPath = '/tmp/e2e-redacted.pdf';
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.keyboard.press('Meta+s'),
  ]);
  await download.saveAs(dlPath);
  const text = execSync(`python3 ${join(here, 'extract-text.py')} ${dlPath}`, { maxBuffer: 64 * 1024 * 1024 }).toString();
  console.log('redacted text extract:', JSON.stringify(text.slice(0, 90)));
  assert(!/quick/i.test(text), 'redacted word "quick" removed from the byte stream (UX-S5)');
  assert(!/parity/i.test(text), 'redacted page flattened to an image — its text is gone, not merely covered');

  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) {
  console.log('DRIVER ERROR:', e.message);
  failed = true;
} finally {
  if (errors.length) console.log('page errors:\n' + errors.join('\n'));
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
}
