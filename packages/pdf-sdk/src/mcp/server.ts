#!/usr/bin/env node
// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Casual PDF MCP server (docs/AI.md §6) — exposes local, offline PDF operations
 * to any MCP client (Claude Desktop, etc.) over stdio. It wraps the same
 * pure-bytes SDK ops the app uses (watermark / header-footer / Bates, merge,
 * signature verification, PII detection) so a chat agent can operate on files on
 * disk without a server or network.
 *
 * Run (after build):  node dist/mcp/server.js
 * Claude Desktop config:  { "mcpServers": { "casual-pdf": { "command": "node",
 *   "args": ["/abs/path/dist/mcp/server.js"] } } }
 *
 * The tool registry (MCP_TOOLS) is exported and unit-tested; this file only adds
 * the stdio transport. JSON-Schema inputs (no zod authoring).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { watermarkFile, headerFooterFile, batesFile, mergeFiles, verifyFile, detectPiiText } from './handlers.ts';

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

const pdfPath = { type: 'string', description: 'Absolute path to a PDF file.' };

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'add_bates',
    description: 'Stamp sequential Bates numbers on a PDF (legal numbering). Writes a new file.',
    inputSchema: {
      type: 'object',
      properties: {
        input: pdfPath,
        output: { type: 'string', description: 'Absolute path for the output PDF.' },
        prefix: { type: 'string', description: 'Text before the number, e.g. "CASE-".' },
        startNumber: { type: 'number', description: 'First number (default 1).' },
        digits: { type: 'number', description: 'Zero-pad width (default 6).' },
        position: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'] },
      },
      required: ['input', 'output'],
    },
    run: (a) => batesFile(a as never),
  },
  {
    name: 'add_header_footer',
    description: 'Add header/footer text bands (left/center/right, {page}/{pages}/{date} variables). Writes a new file.',
    inputSchema: {
      type: 'object',
      properties: {
        input: pdfPath,
        output: { type: 'string', description: 'Absolute path for the output PDF.' },
        header: { type: 'object', description: '{ left?, center?, right? } text.' },
        footer: { type: 'object', description: '{ left?, center?, right? } text.' },
        skipFirstPage: { type: 'boolean' },
      },
      required: ['input', 'output'],
    },
    run: (a) => headerFooterFile(a as never),
  },
  {
    name: 'add_watermark',
    description: 'Overlay a diagonal text watermark on every (or selected) page. Writes a new file.',
    inputSchema: {
      type: 'object',
      properties: {
        input: pdfPath,
        output: { type: 'string', description: 'Absolute path for the output PDF.' },
        text: { type: 'string', description: 'Watermark text.' },
        opacity: { type: 'number', description: '0–1 (default 0.3).' },
        rotation: { type: 'number', description: 'Degrees (default 45).' },
        color: { type: 'string', description: "Hex color (default '#808080')." },
      },
      required: ['input', 'output', 'text'],
    },
    run: (a) => watermarkFile(a as never),
  },
  {
    name: 'detect_pii',
    description: 'Scan text for structured PII (credit cards via Luhn, Aadhaar via Verhoeff, SSN, IBAN, emails, and more). Returns type counts only — never the values.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to scan.' } },
      required: ['text'],
    },
    run: (a) => detectPiiText(a as never),
  },
  {
    name: 'merge_pdfs',
    description: 'Concatenate several PDFs into one, in order. Writes a new file.',
    inputSchema: {
      type: 'object',
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: 'Absolute paths, in merge order.' },
        output: { type: 'string', description: 'Absolute path for the merged PDF.' },
      },
      required: ['inputs', 'output'],
    },
    run: (a) => mergeFiles(a as never),
  },
  {
    name: 'verify_signatures',
    description: 'Verify the PKCS#7 digital signatures in a PDF (digest + signature). Returns signer, validity window, and a trust verdict.',
    inputSchema: {
      type: 'object',
      properties: { input: pdfPath },
      required: ['input'],
    },
    run: (a) => verifyFile(a as never),
  },
];

/** Build the MCP server with all Casual PDF tools registered (no transport). */
export function createServer(): Server {
  const server = new Server(
    { name: 'casual-pdf', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = MCP_TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
    try {
      const result = await tool.run((req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  });
  return server;
}

/** Connect the server over stdio (entry point for the bin). */
export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

// Run when invoked directly (node dist/mcp/server.js), not when imported.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
