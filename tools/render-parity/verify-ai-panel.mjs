// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// E2E test of the "Ask this PDF" panel: processing indicator + live streaming +
// the real bridge→CasualPdfApi roundtrip. A deterministic transport is injected
// (window.__casualPdfAiTransport__) so there's no real LLM, but the tool call
// (get_document_info) executes against the REAL viewer, so the streamed answer
// reflects the fixture's actual page count.
//
//   node tools/render-parity/verify-ai-panel.mjs
//
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const fixtures = resolve(here, 'fixtures');
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const rel = normalize(p).replace(/^(\.\.[/\\])+/, '');
    let b;
    try {
      b = await readFile(join(root, rel));
    } catch {
      // Fall back to the fixtures dir for PDFs not bundled into dist.
      b = await readFile(join(fixtures, rel.replace(/^\/+/, '')));
    }
    res.setHeader('Content-Type', MIME[extname(rel)] || 'application/octet-stream');
    res.end(b);
  } catch {
    res.statusCode = 404;
    res.end('nf');
  }
});
await new Promise((r) => server.listen(8155, '127.0.0.1', r));

const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac) ? { executablePath: mac } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });

const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e)); });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };

try {
  // Inject a deterministic transport BEFORE the app loads. Round 1: stream text
  // + a get_document_info tool call. Round 2: read the real tool_result (the
  // fixture's page count) and stream the answer. A small delay makes the
  // processing indicator observable.
  await page.addInitScript(() => {
    let calls = 0;
    window.__casualPdfAiTransport__ = {
      requiresApiKey: false,
      drivesLoop: false,
      label: 'Test',
      async call(payload) {
        calls += 1;
        await new Promise((r) => setTimeout(r, 400));
        if (calls === 1) {
          payload.onText && payload.onText('Let me check the document. ');
          return {
            data: {
              content: [
                { type: 'text', text: 'Let me check the document. ' },
                { type: 'tool_use', id: 'tu1', name: 'get_document_info', input: {} },
              ],
              stop_reason: 'tool_use',
            },
            status: 200,
          };
        }
        let n = 0;
        try {
          const last = payload.messages[payload.messages.length - 1];
          n = JSON.parse(last.content[0].content).data.pageCount;
        } catch { /* leave 0 */ }
        const answer = `This document has ${n} pages.`;
        payload.onText && payload.onText(answer);
        return { data: { content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' }, status: 200 };
      },
    };
  });

  await page.goto('http://127.0.0.1:8155/?src=%2Fsample.pdf', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state: 'visible', timeout: 60000 });
  console.log('viewer loaded');

  // Open the AI panel.
  await page.locator('[data-testid=ai-toggle]').click();
  await page.locator('[data-testid=ai-panel]').waitFor({ state: 'visible', timeout: 5000 });
  assert(true, 'AI panel opens');

  // Ask a question.
  await page.locator('[data-testid=ai-input]').fill('How many pages does this document have?');
  await page.locator('[data-testid=ai-send]').click();

  // Processing indicator appears while the model works.
  await page.locator('[data-testid=ai-thinking]').waitFor({ state: 'visible', timeout: 5000 });
  assert(true, 'processing indicator ("Thinking…") appears while busy');

  // Live streaming bubble shows partial text during the turn.
  const streamed = await page.locator('[data-testid=ai-streaming]').first().textContent({ timeout: 5000 }).catch(() => null);
  assert(!!streamed && streamed.length > 0, `streaming text renders live (${JSON.stringify((streamed || '').slice(0, 40))})`);

  // Final answer — reflects the REAL page count from the bridge→viewer roundtrip.
  const answerLoc = page.locator('[data-testid=ai-answer]').last();
  await answerLoc.waitFor({ state: 'visible', timeout: 15000 });
  const answer = (await answerLoc.textContent()) || '';
  console.log('answer:', JSON.stringify(answer));
  const match = answer.match(/This document has (\d+) pages\./);
  assert(!!match, 'final answer rendered in the panel');
  assert(match && Number(match[1]) >= 1, `answer carries the real page count from get_document_info (${match ? match[1] : '?'})`);

  // Indicator clears when done.
  await page.locator('[data-testid=ai-thinking]').waitFor({ state: 'hidden', timeout: 5000 });
  assert(true, 'processing indicator clears when the turn completes');

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
