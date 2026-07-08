// Regression: in-app SEARCH must still work after an in-session openDocumentBuffer
// reload (text-edit sessions). Search "parity" (in unedited body lines) → edit the
// "quick brown fox" run (a DIFFERENT run) → search "parity" again: must still match.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = createServer(async (req, res) => { try { const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html'; const fp = join(root, normalize(p).replace(/^(\.\.[/\\])+/, '')); res.setHeader('Content-Type', MIME[extname(fp)] || 'application/octet-stream'); res.end(await readFile(fp)); } catch { res.statusCode = 404; res.end('nf'); } });
await new Promise((r) => server.listen(8188, '127.0.0.1', r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
let failed = false; const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };
const totalFor = async (term) => {
  await page.getByRole('button', { name: 'Find in document' }).click();
  const input = page.locator('input[aria-label="Find in document"]');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill('');
  await input.fill(term);
  // Poll the "active/total" count until it settles > 0 (or give up).
  let total = 0;
  for (let i = 0; i < 25; i++) {
    const txt = (await page.locator('.cpdf__search-count').textContent()) || '0/0';
    total = Number(txt.split('/')[1] || 0);
    if (total > 0) break;
    await page.waitForTimeout(300);
  }
  await page.keyboard.press('Escape'); // close find
  await page.waitForTimeout(200);
  return total;
};
try {
  await page.goto('http://127.0.0.1:8188/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });

  const before = await totalFor('parity');
  console.log('parity matches BEFORE edit:', before);
  assert(before > 0, 'baseline: "parity" is found before any text edit');

  // Text-edit a DIFFERENT run (the quick brown fox line) → in-session openDocumentBuffer.
  await page.getByRole('tab', { name: 'Edit mode' }).click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Quick text edits/ }).click();
  const run = page.getByRole('button', { name: /Edit text: The quick brown fox/ });
  await run.waitFor({ state: 'visible', timeout: 30000 });
  await run.click();
  const inp = page.locator('.cpdf__textedit-input'); await inp.waitFor({ state: 'visible', timeout: 5000 });
  await inp.fill('edited run xyz'); await inp.press('Enter');
  await page.waitForTimeout(4000); // commit → openDocumentBuffer reload

  const after = await totalFor('parity');
  console.log('parity matches AFTER edit:', after);
  assert(after > 0, 'SEARCH still works after an in-session text-edit reload ("parity" still found)');
  assert(after === before, `match count unchanged (${before} → ${after}; the edited run had no "parity")`);
  // DEFINITIVE: the EDITED text ("xyz") exists ONLY in the reloaded doc — finding it
  // proves the search targets the new openDocumentBuffer doc, not a stale index.
  const edited = await totalFor('xyz');
  console.log('edited-text ("xyz") matches AFTER edit:', edited);
  assert(edited > 0, 'the NEW (reloaded) document is searched — the edited text is findable');
  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) { console.log('DRIVER ERROR:', e.message); failed = true; }
finally { await browser.close(); server.close(); }
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
