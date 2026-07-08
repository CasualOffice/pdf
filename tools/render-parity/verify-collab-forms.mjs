// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end form co-editing: TWO real browser clients + a real Hocuspocus server,
// on a PDF with AcroForm fields. Filling a field on client A must appear on B.
// Proves the form binding (form-binding.ts) + wiring end-to-end.
//
//   node tools/render-parity/verify-collab-forms.mjs
//
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hocuspocus } from '@hocuspocus/server';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const fixtures = resolve(here, 'fixtures');
const APP_PORT = 8181;
const HP_PORT = 8182;
const ROOM = 'e2e-forms';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const app = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const rel = normalize(p).replace(/^(\.\.[/\\])+/, '');
    let b; try { b = await readFile(join(root, rel)); } catch { b = await readFile(join(fixtures, rel.replace(/^\/+/, ''))); }
    res.setHeader('Content-Type', MIME[extname(rel)] || 'application/octet-stream'); res.end(b);
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => app.listen(APP_PORT, '127.0.0.1', r));
const hp = new Hocuspocus({ port: HP_PORT, quiet: true });
await hp.listen();

const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };
const collabParam = encodeURIComponent(`ws://127.0.0.1:${HP_PORT}`);
const url = `http://127.0.0.1:${APP_PORT}/?src=%2Fform.pdf&collab=${collabParam}&room=${ROOM}&role=editor`;

async function openClient() {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  return { ctx, page };
}
const firstFieldInput = (page) => page.locator('.cpdf__page input, .cpdf__page textarea').first();

try {
  const a = await openClient();
  const b = await openClient();
  await a.page.waitForTimeout(1800); // both join + exchange awareness

  // The form field renders as an input on the page.
  await firstFieldInput(a.page).waitFor({ state: 'visible', timeout: 15000 });
  assert(true, 'form field renders as an input');

  // Client A fills the first field.
  const inA = firstFieldInput(a.page);
  await inA.click();
  await inA.fill('Ada Lovelace');
  await inA.blur();
  await a.page.waitForTimeout(600);

  // The value should propagate to client B's field over the collab server. POLL for
  // it (robust to CI timing) rather than a single fixed wait.
  let valB = '';
  for (let i = 0; i < 30; i++) {
    valB = await firstFieldInput(b.page).inputValue().catch(() => '');
    if (valB === 'Ada Lovelace') break;
    await b.page.waitForTimeout(300);
  }
  console.log('B field value after sync:', JSON.stringify(valB));
  assert(valB === 'Ada Lovelace', 'the field filled on A synced to B over the collab server');

  await a.ctx.close();
  await b.ctx.close();
} catch (e) {
  console.log('FAIL: exception', String(e));
  failed = true;
} finally {
  await browser.close();
  await hp.destroy();
  app.close();
}
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
