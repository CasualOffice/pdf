// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * PdfOpsBridge — executes AI tool calls against the imperative `CasualPdfApi`
 * (the same handle host menus use). The LLM never touches the viewer directly;
 * every tool goes through here and returns a discriminated result. See
 * `docs/AI.md` §5. Phase A is read-only + navigation.
 */

import type { CasualPdfApi } from '../modes';
import type { PageText } from '../extract';
import { chunkPages, hybridRankChunks, type DocChunk } from './retrieve.ts';
import { findRunsForText } from './highlight.ts';
import { detectPii } from './pii.ts';

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
      case 'get_document_text': {
        const pages = await api.extractAllText();
        if (pages.length === 0) return bad('NOT_READY', 'Document text is not ready yet.', true);
        const budget = Math.min(Math.max(Number((args as { maxChars?: unknown }).maxChars) || 24000, 1000), 200000);
        let text = '';
        let pagesIncluded = 0;
        let truncated = false;
        for (const pt of pages) {
          const block = `[Page ${pt.pageIndex + 1}]\n${pt.text}\n\n`;
          if (text.length + block.length > budget && text.length > 0) {
            truncated = true;
            break;
          }
          text += block;
          pagesIncluded += 1;
        }
        return { ok: true, data: { pages: pages.length, pagesIncluded, truncated, text } };
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
      case 'highlight_source': {
        const page = asPageIndex(args);
        if (page === null) return bad('BAD_ARGS', '`page` must be a non-negative integer.');
        if (page >= api.pageCount()) return bad('OUT_OF_RANGE', `page ${page} is past the last page.`);
        const text = String((args as { text?: unknown }).text ?? '').trim();
        if (!text) return bad('BAD_ARGS', '`text` is required.');
        const pt = await api.extractText(page);
        if (!pt) return bad('NOT_READY', 'Text extraction is not ready yet.', true);
        const runs = findRunsForText(pt.runs, text);
        if (runs.length === 0) return { ok: true, data: { page, highlighted: 0, note: 'text not found on that page' } };
        api.highlightRegion(page, runs.map((r) => r.userSpace));
        return { ok: true, data: { page, highlighted: runs.length } };
      }
      case 'detect_pii': {
        const note = 'Marked for redaction — the user must review and Apply to remove.';
        const found: Record<string, number> = {};
        const rawTypes = (args as { types?: unknown }).types;
        const wanted = Array.isArray(rawTypes) && rawTypes.length ? new Set(rawTypes.map((t) => String(t))) : null;
        const scan = (pt: PageText): number => {
          const matches = detectPii(pt.text).filter((m) => !wanted || wanted.has(m.type));
          const rects: { x: number; y: number; w: number; h: number }[] = [];
          for (const m of matches) {
            for (const r of pt.runs) if (r.charStart < m.end && r.charEnd > m.start) rects.push(r.frac);
            found[m.type] = (found[m.type] ?? 0) + 1; // TYPES only — never echo values
          }
          if (rects.length) api.addRedactionMarks(pt.pageIndex, rects);
          return rects.length;
        };
        // `page` omitted → scan the WHOLE document in one call.
        if ((args as { page?: unknown }).page == null) {
          const pages = await api.extractAllText();
          if (pages.length === 0) return bad('NOT_READY', 'Text extraction is not ready yet.', true);
          let marked = 0;
          for (const pt of pages) marked += scan(pt);
          return { ok: true, data: { pages: pages.length, found, marked, note } };
        }
        const page = asPageIndex(args);
        if (page === null) return bad('BAD_ARGS', '`page` must be a non-negative integer.');
        if (page >= api.pageCount()) return bad('OUT_OF_RANGE', `page ${page} is past the last page.`);
        const pt = await api.extractText(page);
        if (!pt) return bad('NOT_READY', 'Text extraction is not ready yet.', true);
        const marked = scan(pt);
        return { ok: true, data: { page, found, marked, note } };
      }
      case 'mark_redaction': {
        const page = asPageIndex(args);
        if (page === null) return bad('BAD_ARGS', '`page` must be a non-negative integer.');
        if (page >= api.pageCount()) return bad('OUT_OF_RANGE', `page ${page} is past the last page.`);
        const text = String((args as { text?: unknown }).text ?? '').trim();
        if (!text) return bad('BAD_ARGS', '`text` is required.');
        const pt = await api.extractText(page);
        if (!pt) return bad('NOT_READY', 'Text extraction is not ready yet.', true);
        const runs = findRunsForText(pt.runs, text);
        if (runs.length === 0) return { ok: true, data: { page, marked: 0, note: 'text not found on that page' } };
        api.addRedactionMarks(page, runs.map((r) => r.frac));
        return { ok: true, data: { page, marked: runs.length, note: 'Marked for redaction — the user must review and Apply to remove.' } };
      }
      case 'list_form_fields': {
        const fields = await api.listFormFields();
        return { ok: true, data: { fields } };
      }
      case 'fill_form': {
        const raw = (args as { fields?: unknown }).fields;
        if (!Array.isArray(raw) || raw.length === 0) return bad('BAD_ARGS', '`fields` must be a non-empty array of {name, value}.');
        const values = raw
          .map((f) => f as { name?: unknown; value?: unknown })
          .filter((f) => typeof f.name === 'string')
          .map((f) => ({
            name: f.name as string,
            value: f.value === 'true' ? true : f.value === 'false' ? false : String(f.value ?? ''),
          }));
        if (values.length === 0) return bad('BAD_ARGS', 'no valid {name, value} entries.');
        const res = await api.fillForm(values);
        return { ok: true, data: res };
      }
      case 'search_document': {
        const query = String((args as { query?: unknown }).query ?? '').trim();
        if (!query) return bad('BAD_ARGS', '`query` is required.');
        const chunks = await this.getChunks(api);
        if (chunks === null) return bad('NOT_READY', 'Document text is not ready yet.', true);
        // Hybrid (BM25 + dense) when the runtime provides an embedder; else BM25.
        const embedder = api.embedTexts ? (texts: string[]) => api.embedTexts!(texts) : undefined;
        const ranked = await hybridRankChunks(chunks, query, 6, embedder);
        const results = ranked.map((c) => ({ page: c.page, text: c.text }));
        return { ok: true, data: { query, results, retrieval: embedder ? 'hybrid' : 'bm25' } };
      }
      default:
        return bad('UNSUPPORTED', `Unknown tool: ${name}`);
    }
  }
}
