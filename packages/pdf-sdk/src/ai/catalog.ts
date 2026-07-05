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
    name: 'detect_pii',
    description:
      'Scan for structured personal data — credit cards (Luhn-validated so random digits are not flagged), Aadhaar, SSN, passports, IBAN, emails, phones, and more — and MARK every hit for redaction. Omit `page` to scan the WHOLE document in one call (preferred for "redact my PII"); pass a zero-based `page` to scan just that page. This only PROPOSES marks; the user must review and click Apply to permanently remove them. Returns counts by type (never the values).',
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Zero-based page to scan. Omit to scan the whole document.' },
      },
    },
  },
  {
    name: 'fill_form',
    description:
      'Fill the document AcroForm fields and reload with the filled values. Call list_form_fields first to see the field names, types, and options. Pass an array of {name, value}: text takes a string, checkbox takes true/false, radio/dropdown take the option to select. Returns which fields were filled vs skipped.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: 'Fields to fill.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Exact field name from list_form_fields.' },
              value: { type: 'string', description: 'Value: text, "true"/"false" for a checkbox, or the option to select.' },
            },
            required: ['name', 'value'],
          },
        },
      },
      required: ['fields'],
    },
  },
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
    name: 'highlight_source',
    description:
      'Highlight the exact text on a zero-based `page` that supports your answer, so the user can see where it came from, and scroll there. Pass the verbatim quote (as it appears in the document). Call this after you have found and quoted a source passage.',
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Zero-based page index the text is on.' },
        text: { type: 'string', description: 'The verbatim passage to highlight (as written in the document).' },
      },
      required: ['page', 'text'],
    },
  },
  {
    name: 'list_form_fields',
    description:
      'List the document AcroForm fields (name, type, current value, and allowed options for radio/dropdown). Call before fill_form. Returns an empty list if the document has no form.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'mark_redaction',
    description:
      'Mark specific text on a zero-based `page` for redaction (e.g. a name or sensitive phrase that detect_pii would not catch). This only PROPOSES a mark; the user must review and Apply to remove it. Pass the verbatim text. Never claim the text has been removed — you only propose marks.',
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Zero-based page index the text is on.' },
        text: { type: 'string', description: 'The verbatim text to mark for redaction.' },
      },
      required: ['page', 'text'],
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
  'page (1-based for the user), and call highlight_source(page, verbatim quote) to',
  'show where it came from. To redact: call detect_pii(page) for STRUCTURED PII',
  '(credit cards, Aadhaar, SSN, passport, EIN, IBAN, emails, phones, URLs, IDs —',
  'validated by checksums), and mark_redaction(page, text) for CONTEXTUAL PII the',
  'scan cannot catch: person names, company names, places/addresses, signatures,',
  'and role-tagged dates (date of birth/death, signing dates). Both only PROPOSE',
  'marks the user must Apply, so never say anything has been removed. To fill a',
  'form, call list_form_fields to see the field names/types/options, then fill_form',
  'with {name, value} entries. Be concise. If the document does not contain the',
  'answer, say so.',
].join(' ');
