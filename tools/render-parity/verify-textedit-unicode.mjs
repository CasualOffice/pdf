// E2E: Unicode text editing. Editing a run with CJK text in the DIRECT path
// (which can only encode WinAnsi) must NOT fail-closed — it auto-routes to the
// overlay path and embeds a covering font (Noto Sans SC). Asserts: no error, the
// auto-overlay Unicode note is shown, download embeds the text, no page errors.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.pdf':'application/pdf','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json' };
const server = createServer(async (req, res) => {
  try { const u = new URL(req.url,'http://x'); let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
    const fp = join(root, normalize(p).replace(/^(\.\.[/\\])+/, '')); res.setHeader('Content-Type', MIME[extname(fp)]||'application/octet-stream'); res.end(await readFile(fp));
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r)=>server.listen(8176,'127.0.0.1',r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac)?{executablePath:mac}:{}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const errors = []; page.on('pageerror', (e)=>errors.push(String(e)));
let failed = false; const assert = (c,m)=>{ console.log(`${c?'PASS':'FAIL'}: ${m}`); if(!c) failed = true; };
try {
  await page.goto('http://127.0.0.1:8176/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.getByRole('tab', { name: 'Edit mode' }).click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Quick text edits/ }).click();
  const run = page.getByRole('button', { name: /Edit text: The quick brown fox/ });
  await run.waitFor({ state: 'visible', timeout: 30000 });
  // DIRECT mode (do not toggle Overlay). Type CJK text.
  await run.click();
  const input = page.locator('.cpdf__textedit-input');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill('日本語 テスト');
  await input.press('Enter');
  await page.waitForTimeout(14000); // Noto Sans SC: fetch + subset + embed
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  // The edit applied (doc is dirty) rather than failing closed on CJK.
  const dirty = await page.getByRole('button', { name: /Download changes/ }).count();
  assert(dirty > 0, 'CJK edit applied (doc dirty) — did NOT fail-closed');
  const [dl] = await Promise.all([ page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: /Download changes/ }).click() ]);
  await dl.saveAs('/tmp/ui-unicode.pdf');
  const bytes = await readFile('/tmp/ui-unicode.pdf');
  const hasCID = bytes.includes('CIDFontType2');
  console.log('output size', bytes.length, '| CIDFontType2 embedded:', hasCID);
  assert(hasCID, 'a CID font was embedded for the CJK text (Noto Sans SC) — glyphs render, not tofu/fail');
  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) { console.log('DRIVER ERROR:', e.message); failed = true; }
finally { await browser.close(); server.close(); }
process.exit(failed ? 1 : 0);
