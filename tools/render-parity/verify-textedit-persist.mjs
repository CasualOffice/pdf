// Regression: text-edit mode must PERSIST across a commit (the Viewer used to
// remount on openDocumentBuffer, resetting the tool). Do two edits in a row
// without re-clicking the tool; the second must work.
import { createServer } from 'node:http';import { readFile } from 'node:fs/promises';import { join, normalize, extname, dirname, resolve } from 'node:path';import { fileURLToPath } from 'node:url';import { existsSync } from 'node:fs';import { chromium } from 'playwright-core';
const here=dirname(fileURLToPath(import.meta.url));const root=resolve(here,'../../apps/web/dist');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.pdf':'application/pdf','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json'};
const server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://x');let p=decodeURIComponent(u.pathname);if(p.endsWith('/'))p+='index.html';const fp=join(root,normalize(p).replace(/^(\.\.[/\\])+/,''));res.setHeader('Content-Type',MIME[extname(fp)]||'application/octet-stream');res.end(await readFile(fp));}catch{res.statusCode=404;res.end('nf');}});
await new Promise(r=>server.listen(8183,'127.0.0.1',r));
const mac='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';const browser=await chromium.launch({...(existsSync(mac)?{executablePath:mac}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1200,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
let failed=false;const assert=(c,m)=>{console.log(`${c?'PASS':'FAIL'}: ${m}`);if(!c)failed=true;};
try{
  await page.goto('http://127.0.0.1:8183/?src=%2Fsample.pdf',{waitUntil:'networkidle',timeout:60000});
  await page.locator('.cpdf__viewport img').first().waitFor({state:'visible',timeout:60000});
  await page.getByRole('tab',{name:'Edit mode'}).click();await page.waitForTimeout(300);
  await page.getByRole('button',{name:/Quick text edits/}).click();
  const run=page.getByRole('button',{name:/Edit text: The quick brown fox/});
  await run.waitFor({state:'visible',timeout:30000});
  await run.click();
  let input=page.locator('.cpdf__textedit-input');await input.waitFor({state:'visible',timeout:5000});
  await input.fill('first edit done');await input.press('Enter');
  await page.waitForTimeout(4000);
  // Mode must still be active: the "Edit text:" run buttons re-appear WITHOUT re-clicking the tool.
  const runsAfter = await page.getByRole('button',{name:/Edit text:/}).count();
  assert(runsAfter > 0, 'text-edit mode persisted after commit (run boxes still present — no remount)');
  // And a SECOND edit works.
  const run2 = page.getByRole('button',{name:/Edit text: first edit done/});
  await run2.first().click();
  input=page.locator('.cpdf__textedit-input');await input.waitFor({state:'visible',timeout:5000});
  await input.fill('second edit done');await input.press('Enter');
  await page.waitForTimeout(4000);
  const has2 = await page.getByRole('button',{name:/Edit text: second edit done/}).count();
  assert(has2 > 0, 'a second consecutive edit applied without re-activating the tool');
  assert(errors.length===0,`no page errors (${errors.length})`);
}catch(e){console.log('DRIVER ERROR:',e.message);failed=true;}
finally{await browser.close();server.close();}
process.exit(failed?1:0);
