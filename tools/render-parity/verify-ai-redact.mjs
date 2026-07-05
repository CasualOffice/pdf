// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// E2E for AI PII redaction. A deterministic transport calls detect_pii(0) on a
// fixture with a Luhn-valid card, SSN, email, and Verhoeff-valid Aadhaar. That
// runs the REAL bridge → regex+checksum detection → CasualPdfApi.addRedactionMarks
// at the runs' real coords. We then Apply (the human-confirm step) and assert the
// PII text is GONE from the downloaded bytes — the full detect→mark→apply→remove
// pipeline, including the coordinate mapping.
//
//   (cd packages/pdf-sdk && node ../../tools/render-parity/make-pii-fixture.mjs)  # once
//   node tools/render-parity/verify-ai-redact.mjs
//
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
await new Promise((r) => server.listen(8157, '127.0.0.1', r));

const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e)); });

let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };

try {
  await page.addInitScript(() => {
    window.__casualPdfAiTransport__ = {
      drivesLoop: true,
      label: 'Test',
      async call(payload) {
        // Whole-document scan (no page) — the real "redact my PII" flow.
        window.__piiResult__ = await payload.toolExecutor('detect_pii', {});
        payload.onText && payload.onText('Marked the PII across the document for redaction. Review and Apply to remove.');
        return { data: { ok: true }, status: 200, updatedHistory: [] };
      },
    };
  });

  await page.goto('http://127.0.0.1:8157/?src=%2Fpii.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  // Stay in VIEW mode (the default). Asking the AI to redact must auto-switch to
  // Edit so the marks are visible + reviewable (P1 fix).
  assert((await page.getByRole('tab', { name: 'View mode' }).getAttribute('aria-selected')) === 'true', 'starts in View mode');

  // Ask the AI to redact PII → detect_pii marks it.
  await page.locator('[data-testid=ai-toggle]').click();
  await page.locator('[data-testid=ai-input]').fill('Redact all my PII on this page.');
  await page.locator('[data-testid=ai-send]').click();
  await page.locator('[data-testid=ai-answer]').last().waitFor({ state: 'visible', timeout: 20000 });

  const pii = await page.evaluate(() => window.__piiResult__);
  console.log('detect_pii result:', JSON.stringify(pii));
  assert(pii && pii.ok, 'detect_pii ran through the real bridge');
  const found = (pii && pii.data && pii.data.found) || {};
  assert(found['credit-card'] >= 1, 'credit card detected (Luhn-validated)');
  assert(found['ssn'] >= 1, 'SSN detected');
  assert(found['email'] >= 1, 'email detected');
  assert(found['aadhaar'] >= 1, 'Aadhaar detected (Verhoeff-validated)');
  assert(pii.data.marked >= 4, `marked >= 4 PII spans for redaction (${pii.data.marked})`);
  assert(!JSON.stringify(pii).includes('4111'), 'the PII value is NOT echoed back to the model');

  // P1: adding marks auto-switched View → Edit so they're visible/reviewable.
  await page.waitForTimeout(300);
  assert((await page.getByRole('tab', { name: 'Edit mode' }).getAttribute('aria-selected')) === 'true', 'AI redaction auto-switched to Edit mode (marks visible)');

  // Apply the redactions (the human confirm step) and remove.
  await page.getByRole('button', { name: 'Apply redactions' }).click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid=redact-mode-flatten]').click(); // secure whole-page removal
  await page.getByRole('button', { name: 'Flatten & redact' }).click();
  await page.waitForTimeout(3500); // flatten (rasterize + rebuild) is slow
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(1200);

  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.keyboard.press('Meta+s'),
  ]);
  await dl.saveAs('/tmp/ai-redacted.pdf');
  const text = execSync(`python3 ${join(here, 'extract-text.py')} /tmp/ai-redacted.pdf`, { maxBuffer: 64 * 1024 * 1024 }).toString();
  console.log('post-redaction text (first 120):', JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 120)));
  assert(!/4111|1111 1111/.test(text), 'card number removed from the byte stream (UX-S5)');
  assert(!/123-45-6789/.test(text), 'SSN removed from the byte stream');

  assert(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) {
  console.log('FAIL: exception', String(e));
  failed = true;
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
