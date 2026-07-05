// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * PdfOpsBridge — executes AI tool calls against the imperative `CasualPdfApi`
 * (the same handle host menus use). The LLM never touches the viewer directly;
 * every tool goes through here and returns a discriminated result. See
 * `docs/AI.md` §5. Phase A is read-only + navigation.
 */

import type { CasualPdfApi } from '../modes';
import { chunkPages, rankChunks, type DocChunk } from './retrieve.ts';

export type PdfOpsResult =
  | { ok: true; data?: unknown }
  | { ok: false; code: string; message: string; retryable: boolean };

const bad = (code: string, message: string, retryable = false): PdfOpsResult => ({
  ok: false,
  code,
  message,
  retryable,
});

function asPageIndex(args: Record<string, unknown>): number | null {
  const p = Number((args as { page?: unknown }).page);
  return Number.isInteger(p) && p >= 0 ? p : null;
}

export class PdfOpsBridge {
  constructor(private readonly getApi: () => CasualPdfApi | null) {}

  /** Cache the chunked document text so multiple search_document calls in one
   *  turn share a single (expensive) extractAllText pass. */
  private chunksPromise: Promise<DocChunk[] | null> | null = null;
  private getChunks(api: CasualPdfApi): Promise<DocChunk[] | null> {
    if (!this.chunksPromise) {
      this.chunksPromise = api
        .extractAllText()
        .then((pages) => (pages.length ? chunkPages(pages.map((p) => ({ pageIndex: p.pageIndex, text: p.text }))) : null))
        .catch(() => null);
    }
    return this.chunksPromise;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<PdfOpsResult> {
    const api = this.getApi();
    if (!api) return bad('NO_DOCUMENT', 'No document is open.', true);

    switch (name) {
      case 'get_document_info': {
        const outline = await api.getOutline();
        return { ok: true, data: { pageCount: api.pageCount(), outline } };
      }
      case 'get_page_text': {
        const page = asPageIndex(args);
        if (page === null) return bad('BAD_ARGS', '`page` must be a non-negative integer.');
        if (page >= api.pageCount()) return bad('OUT_OF_RANGE', `page ${page} is past the last page.`);
        const pt = await api.extractText(page);
        if (!pt) return bad('NOT_READY', 'Text extraction is not ready yet.', true);
        return { ok: true, data: { page, text: pt.text, width: pt.width, height: pt.height } };
      }
      case 'goto_page': {
        const page = asPageIndex(args);
        if (page === null) return bad('BAD_ARGS', '`page` must be a non-negative integer.');
        api.gotoPage(page);
        return { ok: true, data: { page } };
      }
      case 'search_document': {
        const query = String((args as { query?: unknown }).query ?? '').trim();
        if (!query) return bad('BAD_ARGS', '`query` is required.');
        const chunks = await this.getChunks(api);
        if (chunks === null) return bad('NOT_READY', 'Document text is not ready yet.', true);
        const results = rankChunks(chunks, query, 6).map((c) => ({ page: c.page, text: c.text }));
        return { ok: true, data: { query, results } };
      }
      default:
        return bad('UNSUPPORTED', `Unknown tool: ${name}`);
    }
  }
}
