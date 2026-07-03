// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF merge via pdf-lib. Lazy-loads pdf-lib so the ~437 KB chunk is only
 * fetched when this function is first called (same pattern as page-furniture.ts
 * and redact.ts). Pure bytes-in / bytes-out — no EmbedPDF dependency.
 */

export interface MergeOptions {
  /** Where to insert the secondary document's pages. Default: 'append'. */
  position?: 'append' | 'prepend';
  /**
   * 0-based page indices from the secondary doc to include.
   * Omit to include all pages.
   */
  pages?: number[];
}

/**
 * Merge `secondary` pages into `primary`, returning new PDF bytes.
 *
 * The merged document contains all of `primary`'s pages with `secondary`'s
 * selected pages either prepended or appended. Both documents' annotations,
 * forms, and embedded resources are preserved by pdf-lib's page-copy logic.
 */
export async function mergePdfs(
  primary: Uint8Array,
  secondary: Uint8Array,
  options: MergeOptions = {},
): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const { position = 'append', pages: pageFilter } = options;

  const [primaryDoc, secondaryDoc] = await Promise.all([
    PDFDocument.load(primary, { ignoreEncryption: true }),
    PDFDocument.load(secondary, { ignoreEncryption: true }),
  ]);

  const secondaryPageCount = secondaryDoc.getPageCount();
  const indices =
    pageFilter ??
    Array.from({ length: secondaryPageCount }, (_, i) => i);
  const validIndices = indices.filter((i) => i >= 0 && i < secondaryPageCount);

  const copiedPages = await primaryDoc.copyPages(secondaryDoc, validIndices);

  if (position === 'prepend') {
    copiedPages.forEach((page, i) => primaryDoc.insertPage(i, page));
  } else {
    copiedPages.forEach((page) => primaryDoc.addPage(page));
  }

  const merged = await primaryDoc.save({ useObjectStreams: false });
  return new Uint8Array(merged);
}
