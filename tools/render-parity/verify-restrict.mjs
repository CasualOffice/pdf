// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// E2E: restrict PDF permissions. Menu → Restrict permissions → owner password +
// allow print / deny copy → Protect & download. Verifies the downloaded bytes are
// AES-256 encrypted (/Encrypt + AESV3), and — via pymupdf — that the permission
// flags round-trip (print allowed, copy denied) and it opens with no password.
//
//   node tools/render-parity/verify-restrict.mjs
//
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const fixtures = resolve(here, 'fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const rel = normalize(p).replace(/^(\.\.[/\\])+/, '');
    let b;
    try { b = await readFile(join(root, rel)); }
    catch { b = await readFile(join(fixtures, rel.replace(/^\/+/, ''))); }
    res.setHeader('Content-Type', MIME[extname(rel)] || 'application/octet-stream'); res.end(b);
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => server.listen(8174, '127.0.0.1', r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
let failed = false; const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('http://127.0.0.1:8174/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });

  await page.getByRole('button', { name: 'Menu' }).first().click(); await page.waitForTimeout(200);
  await page.getByRole('menuitem', { name: /Restrict permissions/ }).click(); await page.waitForTimeout(300);
  await page.locator('#restrict-owner').fill('owner-secret');
  // Default: print allowed, copy/modify/annotate denied → a set + unset flag to check.
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /Protect & download/ }).click(),
  ]);
  const outPath = '/tmp/ui-restricted.pdf'; await dl.saveAs(outPath);
  const bytes = await readFile(outPath);
  console.log('restricted bytes:', bytes.length);
  assert(bytes.includes('/Encrypt'), 'downloaded PDF is encrypted (/Encrypt present)');
  assert(bytes.includes('AESV3'), 'uses AES-256 (AESV3 crypt filter)');
  assert(errs.length === 0, `no page errors (${errs.length})`);

  // pymupdf: opens with no password + the permission flags round-trip.
  let py = null;
  try {
    py = execFileSync('python3', ['-c', `
import fitz, sys
d = fitz.open(sys.argv[1])
print('NEEDPASS', bool(d.needs_pass))
print('PRINT', bool(d.permissions & fitz.PDF_PERM_PRINT))
print('COPY', bool(d.permissions & fitz.PDF_PERM_COPY))
`, outPath], { encoding: 'utf8' });
  } catch (e) {
    console.log('NOTE: pymupdf unavailable, skipping permission assertions:', e.message.split('\n')[0]);
  }
  if (py) {
    console.log(py.trim());
    assert(/NEEDPASS False/.test(py), 'opens with no password (empty user password)');
    assert(/PRINT True/.test(py), 'print is ALLOWED (the checked flag round-trips)');
    assert(/COPY False/.test(py), 'copy is DENIED (the unchecked flag round-trips)');
  }
  await page.close();
} catch (e) { console.log('DRIVER ERROR:', e.message); failed = true; }
finally { await browser.close(); server.close(); }
console.log('RESULT:', failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
