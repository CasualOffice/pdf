// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Bundle the Casual PDF MCP server into a single self-contained, executable
// dist/mcp/server.mjs the desktop shell (or Claude Desktop) can spawn with plain
// `node` — no --experimental-transform-types, no workspace resolution. esbuild
// rewrites the .ts-extension imports and inlines the in-policy deps (pdf-lib,
// @signpdf, node-forge, @modelcontextprotocol/sdk); Node built-ins stay external.
//
//   node scripts/build-mcp.mjs   (or: pnpm --filter @casualoffice/pdf build:mcp)
//
import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const outfile = fileURLToPath(new URL('dist/mcp/server.mjs', root));

await build({
  entryPoints: [fileURLToPath(new URL('src/mcp/server.ts', root))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // ESM output → import.meta.url is native (the entry guard needs it). Shim the
  // CJS globals a few bundled deps (node-forge) reference under ESM output.
  banner: { js: "#!/usr/bin/env node\nimport{createRequire as __cr}from'node:module';import{fileURLToPath as __ftp}from'node:url';import{dirname as __dn}from'node:path';const require=__cr(import.meta.url);const __filename=__ftp(import.meta.url);const __dirname=__dn(__filename);" },
  logLevel: 'warning',
});
await chmod(outfile, 0o755);
console.log('built', outfile);
