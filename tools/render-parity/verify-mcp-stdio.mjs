// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end test of the Casual PDF MCP server over a REAL stdio transport:
// spawn the server as a subprocess and drive it with the MCP client SDK —
// initialize handshake, list tools, then call detect_pii. Proves the server
// actually speaks MCP, not just that its registry is well-formed.
//
//   node tools/render-parity/verify-mcp-stdio.mjs
//
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, '../../packages/pdf-sdk/src/mcp/server.ts');

let failed = false;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; };

const transport = new StdioClientTransport({
  command: process.execPath, // node
  args: ['--experimental-transform-types', '--no-warnings', server],
});
const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  assert(true, 'connected + initialized over stdio');

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log('tools:', names.join(', '));
  assert(names.length === 6, `server advertises 6 tools (${names.length})`);
  assert(names.includes('detect_pii') && names.includes('merge_pdfs'), 'expected tools present');
  assert(tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'), 'every tool has an object input schema');

  const res = await client.callTool({ name: 'detect_pii', arguments: { text: 'my card is 4111 1111 1111 1111' } });
  const text = res.content?.[0]?.text ?? '';
  console.log('detect_pii →', text.replace(/\s+/g, ' '));
  const data = JSON.parse(text);
  assert(data.found && data.found['credit-card'] >= 1, 'detect_pii found the Luhn-valid card over stdio');
  assert(!text.includes('4111'), 'PII value not echoed in the tool result');
} catch (e) {
  console.log('FAIL: exception', String(e));
  failed = true;
} finally {
  await client.close().catch(() => {});
}
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
