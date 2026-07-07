// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// E2E: sign with YOUR OWN .p12/.pfx (a CA-issued identity), not the self-signed
// default. Uploads a throwaway test cert (CN="Alice Tester"), signs, reloads the
// signed file, and asserts the badge is Certified AND the details report the
// signer name from the uploaded cert — proving the own-cert path is wired through.
//
//   node tools/render-parity/verify-signature-owncert.mjs
//
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const p12Path = resolve(here, 'fixtures/test-signer.p12');
let signedBytes = null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname);
    if (p === '/signed.pdf' && signedBytes) { res.setHeader('Content-Type', 'application/pdf'); return res.end(Buffer.from(signedBytes)); }
    if (p.endsWith('/')) p += 'index.html';
    const rel = normalize(p).replace(/^(\.\.[/\\])+/, '');
    let body;
    try { body = await readFile(join(root, rel)); }
    catch { body = await readFile(join(here, 'fixtures', rel.replace(/^\/+/, ''))); }
    res.setHeader('Content-Type', MIME[extname(rel)] || 'application/octet-stream'); res.end(body);
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => server.listen(8172, '127.0.0.1', r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
let failed = false; const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };
try {
  // 1. open sample.pdf, open the Sign dialog, choose "own certificate".
  const p1 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await p1.goto('http://127.0.0.1:8172/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await p1.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await p1.getByRole('button', { name: 'Menu' }).first().click(); await p1.waitForTimeout(200);
  await p1.getByRole('menuitem', { name: /Sign document/ }).click(); await p1.waitForTimeout(300);

  // Toggle own-cert → the file + passphrase inputs appear, primary button changes.
  await p1.getByText('Use my own certificate').click();
  await p1.waitForTimeout(150);
  const signBtn = p1.getByRole('button', { name: /Sign with certificate/ });
  assert(await signBtn.isVisible(), 'own-cert toggle reveals "Sign with certificate"');
  assert(!(await signBtn.isEnabled()), 'Sign with certificate is disabled until a file is chosen');

  // Upload the test .p12 + passphrase, then sign (captures the download).
  await p1.locator('input[type=file][accept*=".p12"]').setInputFiles(p12Path);
  await p1.locator('.signdlg__owncert-pass').fill('casual-pdf');
  await p1.waitForTimeout(150);
  assert(await signBtn.isEnabled(), 'Sign with certificate enables once a cert is chosen');
  const [dl] = await Promise.all([
    p1.waitForEvent('download', { timeout: 30000 }),
    signBtn.click(),
  ]);
  const outPath = '/tmp/ui-owncert-signed.pdf'; await dl.saveAs(outPath);
  signedBytes = await readFile(outPath);
  console.log('signed bytes:', signedBytes.length, '| has ByteRange:', signedBytes.includes('ByteRange'));
  assert(signedBytes.includes('ByteRange'), 'the downloaded PDF carries a signature ByteRange');
  await p1.close();

  // 2. reload the signed file → Certified badge, details name the uploaded signer.
  const p2 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = []; p2.on('pageerror', (e) => errs.push(String(e)));
  await p2.goto('http://127.0.0.1:8172/?src=%2Fsigned.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await p2.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await p2.waitForTimeout(700);
  const badge = p2.locator('.appbar__sigstatus');
  assert((await badge.textContent())?.trim() === 'Certified', 'badge shows Certified for the own-cert signature');
  await badge.click(); await p2.waitForTimeout(1500);
  const dlgText = (await p2.locator('.dialog--form').textContent()) || '';
  console.log('dialog:', dlgText.replace(/\s+/g, ' ').slice(0, 260));
  assert(/Signature valid/i.test(dlgText), 'dialog reports Signature valid');
  assert(/Content digest matches/i.test(dlgText), 'digest matches (document intact)');
  assert(/Alice Tester/.test(dlgText), 'details show the UPLOADED cert’s signer name (own-cert path used)');
  assert(errs.length === 0, `no page errors (${errs.length})`);
  await p2.close();
} catch (e) { console.log('DRIVER ERROR:', e.message); failed = true; }
finally { await browser.close(); server.close(); }
console.log('RESULT:', failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
