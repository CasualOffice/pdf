// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Casual PDF DocOps tool catalog — the tools the AI can call, sent verbatim as
 * the Anthropic `tools` array (and translated to OpenAI functions for local /
 * Ollama providers by the transport). See `docs/AI.md` §5.
 *
 * Phase A ships a READ-ONLY set — enough for "Ask this PDF", summarize, and
 * navigate, with zero risk of a hallucinated tool call mutating the document.
 * Write tools (annotate / redact / form-fill) are added behind confirmation in a
 * later phase. Sorted by name for prompt-cache stability (docs/AI.md §7).
 */

export interface PdfTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const PDF_CATALOG: PdfTool[] = [
  {
    name: 'get_document_info',
    description:
      'Return the page count and the document outline/bookmarks. Call this FIRST to orient yourself before answering anything about the document.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_page_text',
    description:
      'Return the full text of a single page (zero-based `page`). Call this to read the actual content before answering a question, summarizing, or quoting. Also returns the page width/height in points.',
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Zero-based page index to read.' },
      },
      required: ['page'],
    },
  },
  {
    name: 'goto_page',
    description:
      'Scroll the viewer to a zero-based `page` so the user sees it. Call this when the user asks to go to a page or when pointing them at where an answer came from.',
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Zero-based page index to scroll to.' },
      },
      required: ['page'],
    },
  },
  {
    name: 'search_document',
    description:
      'Search the WHOLE document and return the passages most relevant to a query, each with its zero-based page number. Prefer this over reading pages one by one when a question could be answered from anywhere in the document — it is one call instead of many. Use the returned page numbers to cite sources (present them 1-based to the user) or to goto_page.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for — a question or keywords.' },
      },
      required: ['query'],
    },
  },
];

/** Default system prompt for the "Ask this PDF" assistant. */
export const PDF_SYSTEM_PROMPT = [
  'You are the AI assistant inside Casual PDF, a PDF viewer/editor.',
  'You help the user understand and navigate the open document.',
  'Always ground answers in the actual document. For a question that could be',
  'answered from anywhere in the document, call search_document first to retrieve',
  'the most relevant passages (with page numbers), then read specific pages with',
  'get_page_text only if you need more. Use get_document_info for structure/length.',
  'Do not guess page contents. When you state a fact from the document, cite the',
  'page (1-based for the user). Be concise. If the document does not contain the',
  'answer, say so.',
].join(' ');
