// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// E2E of the Share entry point: with a collab server configured (?collab=), client A
// clicks Share → "Start co-editing" → gets an invite link (a room minted in place, no
// reload); client B opens that link and joins the SAME room — both see each other in
// presence. Proves the co-editing session can be STARTED from the UI end to end.
//
//   node tools/render-parity/verify-collab-share.mjs
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
const APP_PORT = 8201;
const HP_PORT = 8202;
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
async function pollFor(fn, ok, tries = 30, gap = 300) {
  let v;
  for (let i = 0; i < tries; i++) { v = await fn(); if (ok(v)) return v; await new Promise((r) => setTimeout(r, gap)); }
  return v;
}
const collabParam = encodeURIComponent(`ws://127.0.0.1:${HP_PORT}`);

try {
  // Client A: server configured (?collab=) but NO room yet → not in a session.
  const ctxA = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const a = await ctxA.newPage();
  a.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  await a.goto(`http://127.0.0.1:${APP_PORT}/?src=%2Fsample.pdf&collab=${collabParam}`, { waitUntil: 'networkidle', timeout: 60000 });
  await a.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });

  // The Share button is offered (a server is available).
  const shareBtn = a.locator('[data-testid=share-button]');
  assert(await shareBtn.isVisible(), 'Share button shown when a collab server is available');
  assert((await shareBtn.textContent())?.includes('Share'), 'reads "Share" before a session starts');

  // Start a session → an invite link appears (room minted in place).
  await shareBtn.click();
  await a.locator('[data-testid=share-start]').click();
  await a.locator('[data-testid=share-link]').waitFor({ state: 'visible', timeout: 5000 });
  const link = await a.locator('[data-testid=share-link]').inputValue();
  console.log('invite link:', link);
  assert(/[?&]room=r-/.test(link), 'the invite link carries a freshly minted room');
  assert(new URL(link).searchParams.get('room') === new URL(a.url()).searchParams.get('room'), 'the browser URL was updated in place (no reload) to the shared room');
  await a.keyboard.press('Escape'); // close dialog

  // Client B opens the invite link → joins the SAME room.
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const b = await ctxB.newPage();
  b.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  await b.goto(link.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${APP_PORT}`), { waitUntil: 'networkidle', timeout: 60000 });
  await b.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });

  // Both should now see each other in presence (they're in the same room).
  const aAvatars = await pollFor(() => a.locator('.cpdf__presence-avatar').count(), (v) => v >= 1);
  const bAvatars = await pollFor(() => b.locator('.cpdf__presence-avatar').count(), (v) => v >= 1);
  console.log('avatars A/B:', aAvatars, bAvatars);
  assert(aAvatars >= 1, 'A (the initiator) sees B join the shared session');
  assert(bAvatars >= 1, 'B (via the invite link) sees A in the session');

  await ctxA.close();
  await ctxB.close();
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
