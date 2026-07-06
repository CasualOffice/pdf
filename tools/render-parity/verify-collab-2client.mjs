// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end co-editing: TWO real browser clients + a real Hocuspocus server.
// Proves the whole collab stack (binding + provider + presence) — an annotation
// drawn in client A appears in client B, and each sees the other's presence.
//
//   node tools/render-parity/verify-collab-2client.mjs
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
const APP_PORT = 8171;
const HP_PORT = 8172;
const ROOM = 'e2e-room';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// Static server for the built app (+ fixtures fallback).
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

// A real Hocuspocus server (no auth — the collab relay under test).
const hp = new Hocuspocus({ port: HP_PORT, quiet: true });
await hp.listen();

const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });

let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };
const collabParam = encodeURIComponent(`ws://127.0.0.1:${HP_PORT}`);
const urlFor = () => `http://127.0.0.1:${APP_PORT}/?src=%2Fsample.pdf&collab=${collabParam}&room=${ROOM}&role=editor`;

async function openClient() {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  await page.goto(urlFor(), { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  return { ctx, page };
}

const commentCount = async (page) => {
  // Open the Comments panel (idempotent toggle: ensure it's open) and count rows.
  const open = await page.locator('.cpdf__panel[aria-label="Comments"]').isVisible().catch(() => false);
  if (!open) { await page.getByRole('button', { name: 'Comments & annotations' }).click(); await page.waitForTimeout(400); }
  return page.locator('.cpdf__comment-row').count();
};

try {
  const a = await openClient();
  const b = await openClient();
  await a.page.waitForTimeout(1500); // let both join the room + exchange awareness

  // Presence: each client should see the other's avatar.
  const aAvatars = await a.page.locator('.cpdf__presence-avatar').count();
  const bAvatars = await b.page.locator('.cpdf__presence-avatar').count();
  console.log('avatars A/B:', aAvatars, bAvatars);
  assert(aAvatars >= 1, 'client A sees client B in presence');
  assert(bAvatars >= 1, 'client B sees client A in presence');

  // Baseline: no annotations yet on B.
  const beforeB = await commentCount(b.page);
  console.log('B annotations before:', beforeB);

  // Client A: Edit mode → draw a rectangle annotation.
  await a.page.getByRole('tab', { name: 'Edit mode' }).click();
  await a.page.waitForTimeout(300);
  const el = a.page.locator('.cpdf__page').first();
  const box = await el.boundingBox();
  await a.page.keyboard.press('r'); // rectangle tool
  await a.page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await a.page.mouse.down();
  await a.page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45, { steps: 10 });
  await a.page.mouse.up();
  await a.page.waitForTimeout(400);
  const afterA = await commentCount(a.page);
  console.log('A annotations after drawing:', afterA);
  assert(afterA >= 1, 'client A created the annotation locally');

  // The annotation should propagate to client B over the collab server.
  await b.page.waitForTimeout(2500);
  const afterB = await commentCount(b.page);
  console.log('B annotations after sync:', afterB);
  assert(afterB > beforeB, 'the annotation drawn in A synced to B over the collab server');

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
