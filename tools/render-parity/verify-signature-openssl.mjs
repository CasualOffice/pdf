// UX-S2 external-validation gate: sign a PDF via the app, then verify the
// embedded PKCS#7/CMS signature with OpenSSL — an INDEPENDENT, standards-
// compliant implementation (not our own forge verifier). Proves the signature is
// genuinely verifiable by external tools (Acrobat, etc.), not just self-asserted.
//
// Requires `openssl` on PATH (present on GitHub ubuntu runners + dev machines).
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../apps/web/dist');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.pdf':'application/pdf','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json' };
const server = createServer(async (req, res) => {
  try { const u = new URL(req.url,'http://x'); let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
    const fp = join(root, normalize(p).replace(/^(\.\.[/\\])+/, '')); res.setHeader('Content-Type', MIME[extname(fp)]||'application/octet-stream'); res.end(await readFile(fp));
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r)=>server.listen(8185,'127.0.0.1',r));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(mac)?{executablePath:mac}:{}), headless: true });
let failed = false; const assert=(c,m)=>{ console.log(`${c?'PASS':'FAIL'}: ${m}`); if(!c) failed=true; };
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8185/?src=%2Fsample.pdf', { waitUntil:'networkidle', timeout:60000 });
  await page.locator('.cpdf__viewport img').first().waitFor({ state:'visible', timeout:60000 });
  await page.getByRole('button',{name:'Menu'}).first().click(); await page.waitForTimeout(200);
  await page.getByRole('menuitem',{name:/Sign document/}).click(); await page.waitForTimeout(300);
  const [dl] = await Promise.all([ page.waitForEvent('download',{timeout:30000}), page.getByRole('button',{name:/Sign and download/}).click() ]);
  await dl.saveAs('/tmp/sig-ossl.pdf');
  await page.close();

  const pdf = new Uint8Array(await readFile('/tmp/sig-ossl.pdf'));
  const s = new TextDecoder('latin1').decode(pdf);
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(s);
  assert(!!m, 'signed PDF has a /ByteRange');
  const [a,b,c,d] = [+m[1],+m[2],+m[3],+m[4]];
  const content = new Uint8Array(b+d); content.set(pdf.subarray(a,a+b),0); content.set(pdf.subarray(c,c+d),b);
  await writeFile('/tmp/sig-ossl-content.bin', content);
  const gap = s.slice(a+b, c+1); const lt=gap.indexOf('<'), gt=gap.indexOf('>',lt+1);
  const raw = Buffer.from(gap.slice(lt+1,gt).replace(/[^0-9a-fA-F]/g,''), 'hex');
  const len = raw[1]===0x82 ? 4+((raw[2]<<8)|raw[3]) : raw[1]===0x81 ? 3+raw[2] : 2+raw[1];
  await writeFile('/tmp/sig-ossl.der', raw.subarray(0,len));

  // The embedded certificate is present + parseable (independent of our code).
  const certs = execFileSync('openssl', ['pkcs7','-inform','DER','-in','/tmp/sig-ossl.der','-print_certs','-noout'], { encoding:'utf8' });
  assert(/subject=.*CN\s*=/.test(certs), 'embedded signer certificate is present + readable by OpenSSL');

  // The signature verifies (digest over the ByteRange content + RSA over the
  // signed attributes). -binary: no MIME/CRLF canonicalization of binary PDF bytes.
  // -noverify: skip trust-chain (self-signed) — we're validating the crypto.
  let ok = false;
  try {
    const out = execFileSync('openssl', ['cms','-verify','-inform','DER','-in','/tmp/sig-ossl.der','-content','/tmp/sig-ossl-content.bin','-binary','-noverify','-out','/dev/null'], { encoding:'utf8', stdio:['pipe','pipe','pipe'] });
    ok = true; void out;
  } catch (e) { console.log('openssl:', String(e.stderr||e.message).split('\n')[0]); }
  assert(ok, 'OpenSSL CMS verification SUCCESSFUL — the signature is cryptographically valid (UX-S2, external validator)');
} catch (e) { console.log('DRIVER ERROR:', e.message); failed = true; }
finally { await browser.close(); server.close(); }
process.exit(failed ? 1 : 0);
