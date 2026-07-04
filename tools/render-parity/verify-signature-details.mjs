// E2E: sign a PDF via the app, reload the signed file, open the signature-details
// dialog from the badge, and assert the verifier reports a valid, self-signed sig.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
let signedBytes = null;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.pdf':'application/pdf','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json' };
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname);
    if (p === '/signed.pdf' && signedBytes) { res.setHeader('Content-Type','application/pdf'); return res.end(Buffer.from(signedBytes)); }
    if (p.endsWith('/')) p += 'index.html';
    const fp = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    res.setHeader('Content-Type', MIME[extname(fp)] || 'application/octet-stream'); res.end(await readFile(fp));
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => server.listen(8171, '127.0.0.1', r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
let failed = false; const assert = (c,m) => { console.log(`${c?'PASS':'FAIL'}: ${m}`); if(!c) failed = true; };
try {
  // 1. sign sample.pdf
  const p1 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await p1.goto('http://127.0.0.1:8171/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await p1.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await p1.getByRole('button', { name: 'Menu' }).first().click(); await p1.waitForTimeout(200);
  await p1.getByRole('menuitem', { name: /Sign document/ }).click(); await p1.waitForTimeout(300);
  const [dl] = await Promise.all([
    p1.waitForEvent('download', { timeout: 30000 }),
    p1.getByRole('button', { name: /Sign and download/ }).click(),
  ]);
  const path = '/tmp/ui-signed.pdf'; await dl.saveAs(path);
  signedBytes = await readFile(path);
  console.log('signed bytes:', signedBytes.length, '| has ByteRange:', signedBytes.includes('ByteRange'));
  await p1.close();
  // 2. reload the signed file, check badge → Certified, open details
  const p2 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = []; p2.on('pageerror', e => errs.push(String(e)));
  await p2.goto('http://127.0.0.1:8171/?src=%2Fsigned.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await p2.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await p2.waitForTimeout(600);
  const badge = p2.locator('.appbar__sigstatus');
  const badgeText = (await badge.textContent())?.trim();
  console.log('badge:', badgeText);
  assert(badgeText === 'Certified', 'badge shows Certified for a signed PDF');
  await badge.click(); await p2.waitForTimeout(1500);
  const dlgText = await p2.locator('.dialog--form').textContent();
  console.log('dialog text (trimmed):', dlgText?.replace(/\s+/g,' ').slice(0, 300));
  assert(/Signature valid/i.test(dlgText || ''), 'dialog reports Signature valid');
  assert(/Content digest matches/i.test(dlgText || ''), 'digest matches (document intact)');
  assert(/Cryptographically valid/i.test(dlgText || ''), 'signature cryptographically valid');
  assert(/self-signed/i.test(dlgText || ''), 'self-signed identity caveat shown');
  assert(errs.length === 0, `no page errors (${errs.length})`);
  await p2.screenshot({ path: '/tmp/sig-details.png' });
  await p2.close();
} catch (e) { console.log('DRIVER ERROR:', e.message); failed = true; }
finally { await browser.close(); server.close(); }
process.exit(failed ? 1 : 0);
