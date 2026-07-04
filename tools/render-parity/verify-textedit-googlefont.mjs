// E2E: dynamic Google Fonts for text editing. Editing a run whose font is a
// Google Font (Roboto) in Overlay mode should fetch + embed that font from
// jsdelivr (matchFont's GF tier), NOT fall back to a standard-14 Helvetica
// substitute. Asserts the downloaded bytes contain no '/Helvetica' (→ matched)
// and no page errors.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const fixtures = resolve(here, 'fixtures');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.pdf':'application/pdf','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json' };
const server = createServer(async (req, res) => {
  try { const u = new URL(req.url,'http://x'); let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    let fp = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (p === '/roboto.pdf') fp = join(fixtures, 'roboto.pdf');
    res.setHeader('Content-Type', MIME[extname(fp)] || 'application/octet-stream'); res.end(await readFile(fp));
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => server.listen(8175,'127.0.0.1',r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac)?{executablePath:mac}:{}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
// OFFLINE (CI-safe): the app fetches Roboto from jsdelivr at runtime; serve a tiny
// vendored Latin subset (fixtures/roboto-latin-test.ttf, keeps the "Roboto" name)
// so the gate is deterministic + needs no network. Regenerate with:
//   python3 -m fontTools.subset <Roboto[wdth,wght].ttf> --unicodes=U+0020-007E \
//     --output-file=fixtures/roboto-latin-test.ttf --no-hinting --drop-tables+=GSUB,GPOS
const robotoFont = await readFile(join(fixtures, 'roboto-latin-test.ttf'));
await page.route('**/ofl/roboto/**', (route) => route.fulfill({
  status: 200,
  headers: { 'access-control-allow-origin': '*', 'content-type': 'font/ttf' },
  body: robotoFont,
}));
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
let failed = false; const assert = (c,m) => { console.log(`${c?'PASS':'FAIL'}: ${m}`); if(!c) failed = true; };
try {
  await page.goto('http://127.0.0.1:8175/?src=%2Froboto.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.getByRole('tab', { name: 'Edit mode' }).click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Quick text edits/ }).click();
  const run = page.getByRole('button', { name: /Edit text: Roboto document text/ });
  await run.waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /Overlay/ }).click();
  await run.click();
  const input = page.locator('.cpdf__textedit-input');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill('Edited Roboto run'); await input.press('Enter');
  await page.waitForTimeout(5000); // edit + embed (font is a local intercept now)
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(600);
  const [dl] = await Promise.all([ page.waitForEvent('download', { timeout: 20000 }), page.keyboard.press('Meta+s') ]);
  await dl.saveAs('/tmp/ui-gf.pdf');
  const bytes = await readFile('/tmp/ui-gf.pdf');
  console.log('output size', bytes.length, '| has Roboto:', bytes.includes('Roboto'), '| has Helvetica:', bytes.includes('Helvetica'));
  assert(!bytes.includes('Helvetica'), 'no standard Helvetica substitute → the Roboto Google Font was matched + embedded');
  assert(bytes.includes('Roboto'), 'Roboto font present in the output');
  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) { console.log('DRIVER ERROR:', e.message); failed = true; }
finally { await browser.close(); server.close(); }
process.exit(failed ? 1 : 0);
