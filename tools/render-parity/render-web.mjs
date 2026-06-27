// Web half of UX-F1: render page 1 of a PDF through the real EmbedPDF
// (PDFium-WASM) viewer and save it as a PNG. Drives the built app via its
// `?src=` override and screenshots the first rendered page <img>.
//
// Usage: node render-web.mjs --url <appBase> --src <pdfUrl> --out <png> [--chrome <path>]
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const appBase = arg('url', 'http://127.0.0.1:8099/');
const src = arg('src', '/sample.pdf');
const out = arg('out', 'out/web.png');
// Browser: an explicit Chrome path (flag/env) wins; else the macOS default if
// present; else fall back to Playwright's own Chromium (`npx playwright install
// chromium` in CI). Same PDFium-WASM either way — UX-F1 is engine parity.
const macDefault = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const explicit = arg('chrome') || process.env.CHROME_PATH;
const execPath = explicit || (existsSync(macDefault) ? macDefault : undefined);

const target = `${appBase}${appBase.includes('?') ? '&' : '?'}src=${encodeURIComponent(src)}`;
console.log('rendering (web):', target, execPath ? `[chrome: ${execPath}]` : '[playwright chromium]');

const browser = await chromium.launch({ ...(execPath ? { executablePath: execPath } : {}), headless: true });
// deviceScaleFactor: 1 so the screenshot is in CSS px == the PDF point grid.
const page = await browser.newPage({ viewport: { width: 1000, height: 1100 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(target, { waitUntil: 'networkidle', timeout: 60000 });
const img = page.locator('main img').first();
await img.waitFor({ state: 'visible', timeout: 60000 });
await page.waitForTimeout(2500); // let PDFium finish painting the bitmap

const box = await img.boundingBox();
console.log('page image box:', box && `${Math.round(box.width)}x${Math.round(box.height)}`);
await img.screenshot({ path: out });
console.log('wrote', out);
if (errors.length) console.log('page errors:', errors.join('\n'));
await browser.close();
