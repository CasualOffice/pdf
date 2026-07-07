// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end request-to-sign: TWO real browser clients + a real Hocuspocus server.
// Client A requests a signature; client B sees the request, signs; the envelope
// completes and the certificate becomes available. Proves signing.ts + use-signing
// + the panel + collab sync end-to-end.
//
//   node tools/render-parity/verify-collab-signing.mjs
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
const APP_PORT = 8191;
const HP_PORT = 8192;
const ROOM = 'e2e-signing';
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
const url = `http://127.0.0.1:${APP_PORT}/?src=%2Fsample.pdf&collab=${collabParam}&room=${ROOM}&role=editor`;

async function openClient() {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.getByRole('tab', { name: 'Edit mode' }).click(); // request form + sign need Edit
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Request signatures' }).click(); // open the Signatures panel
  return { ctx, page };
}

try {
  const a = await openClient();
  const b = await openClient();
  await a.page.waitForTimeout(1600);

  // A: request a signature from Bob.
  await a.page.locator('.cpdf__sign-input[placeholder="Document title"]').fill('Test agreement');
  await a.page.locator('.cpdf__sign-input[placeholder="Name"]').first().fill('Bob Signer');
  await a.page.locator('.cpdf__sign-input[placeholder="Email"]').first().fill('bob@x.com');
  await a.page.locator('[data-testid=sign-request-submit]').click();
  await a.page.waitForTimeout(600);
  assert((await a.page.locator('[data-testid=sign-status]').textContent())?.trim() === 'Sent', 'A: request created, status Sent');

  // B: the request synced over collab; the signer + Sign button appear.
  await b.page.waitForTimeout(2500);
  await b.page.locator('[data-testid=sign-signer]').first().waitFor({ state: 'visible', timeout: 8000 });
  const signerText = (await b.page.locator('[data-testid=sign-signer]').first().textContent()) || '';
  assert(/Bob Signer/.test(signerText), 'B: sees the synced recipient (Bob Signer)');
  const signBtn = b.page.locator('[data-testid=sign-now]').first();
  assert(await signBtn.isVisible(), 'B: a Sign button is available for the pending signer');

  // B signs → the envelope completes on both clients.
  await signBtn.click();
  await b.page.waitForTimeout(500);
  assert((await b.page.locator('[data-testid=sign-status]').textContent())?.trim() === 'Completed', 'B: envelope Completed after signing');
  await a.page.waitForTimeout(2500);
  assert((await a.page.locator('[data-testid=sign-status]').textContent())?.trim() === 'Completed', 'A: sees Completed over collab');
  assert(await a.page.locator('[data-testid=sign-download-cert]').isVisible(), 'A: certificate download available on completion');

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
