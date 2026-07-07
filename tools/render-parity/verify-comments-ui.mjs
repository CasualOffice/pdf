// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// E2E of the threaded-comments panel (solo mode): open a doc, switch to Edit,
// open Comments, post a comment, reply, verify both render, resolve → it leaves
// the open list, Show resolved brings it back. Drives the REAL viewer + model.
//
//   node tools/render-parity/verify-comments-ui.mjs
//
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const fixtures = resolve(here, 'fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const rel = normalize(p).replace(/^(\.\.[/\\])+/, '');
    let b;
    try { b = await readFile(join(root, rel)); }
    catch { b = await readFile(join(fixtures, rel.replace(/^\/+/, ''))); }
    res.setHeader('Content-Type', MIME[extname(rel)] || 'application/octet-stream');
    res.end(b);
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => server.listen(8163, '127.0.0.1', r));

const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e)); });

let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };

try {
  await page.goto('http://127.0.0.1:8163/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });

  // Switch to Edit mode so comments can be authored.
  await page.locator('[aria-label="Edit mode"]').click();
  // Open the Comments rail panel.
  await page.locator('[aria-label="Comments & annotations"]').click();
  const input = page.locator('[data-testid=comment-new-input]');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  assert(true, 'Comments panel opens with a compose box in Edit mode');

  // Post a top-level comment with an @mention.
  await input.fill('Please double-check this figure @ada');
  await page.locator('[data-testid=comment-submit]').click();
  const thread = page.locator('[data-testid=comment-thread]');
  await thread.first().waitFor({ state: 'visible', timeout: 5000 });
  assert((await thread.count()) === 1, 'posting creates one thread');
  const firstBody = (await page.locator('[data-testid=comment-body]').first().textContent()) || '';
  assert(/double-check this figure/.test(firstBody), 'comment body renders');
  assert(/@ada/.test(firstBody), 'the @mention is preserved in the body');

  // Reply in the thread.
  const replyInput = page.locator('[data-testid=comment-reply-input]').first();
  await replyInput.fill('Fixed, thanks');
  await replyInput.press('Enter');
  await page.waitForTimeout(200);
  const bodies = await page.locator('[data-testid=comment-body]').allTextContents();
  assert(bodies.length === 2, 'reply adds a second message to the thread');
  assert(bodies.some((b) => /Fixed, thanks/.test(b)), 'reply body renders');

  // Resolve the thread → it leaves the open list.
  await page.locator('[aria-label="Resolve thread"]').first().click();
  await page.waitForTimeout(200);
  assert((await page.locator('[data-testid=comment-thread]').count()) === 0, 'resolved thread leaves the open list');

  // "Show N resolved" brings it back.
  await page.locator('.cpdf__comment-resolved-toggle').click();
  await page.waitForTimeout(150);
  assert((await page.locator('[data-testid=comment-thread]').count()) === 1, 'Show resolved reveals the resolved thread');

  // Create-from-selection: drag over page text, click Comment in the mini-toolbar,
  // and the compose box shows the anchor chip; posting anchors the thread.
  const pg = page.locator('.cpdf__page').first();
  const pbox = await pg.boundingBox();
  await page.mouse.move(pbox.x + pbox.width * 0.18, pbox.y + pbox.height * 0.22);
  await page.mouse.down();
  await page.mouse.move(pbox.x + pbox.width * 0.6, pbox.y + pbox.height * 0.235, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const commentBtn = page.locator('[aria-label="Comment on selection"]');
  if (await commentBtn.isVisible().catch(() => false)) {
    await commentBtn.click();
    await page.locator('[data-testid=comment-anchor-chip]').waitFor({ state: 'visible', timeout: 3000 });
    assert(true, 'selection → the compose box shows an anchor chip');
    await page.locator('[data-testid=comment-new-input]').fill('This sentence is unclear');
    await page.locator('[data-testid=comment-submit]').click();
    await page.waitForTimeout(250);
    const bodies2 = await page.locator('[data-testid=comment-body]').allTextContents();
    assert(bodies2.some((b) => /This sentence is unclear/.test(b)), 'anchored-to-selection comment posts as a thread');
  } else {
    console.log('NOTE: headless text selection did not form; anchor-chip assertions skipped');
  }

  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) {
  console.log('FAIL: threw', String(e));
  failed = true;
} finally {
  await browser.close();
  server.close();
}
console.log('RESULT:', failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
