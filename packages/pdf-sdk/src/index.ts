// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

export { CasualPdf } from './CasualPdf';
export { Icon } from './ui/icons';
export type { IconName } from './ui/icons';
export { attachCollab } from './collab';
export type { CollabHandle } from './collab';
export { roleToMode, allowedModes, clampMode } from './modes';
export type { Mode, Role, CollabConfig, Identity, CasualPdfProps, CasualPdfApi } from './modes';
// Certified signing lives behind the `@casualoffice/pdf/sign` subpath so the
// signing core only loads when a host imports it lazily.
export type { SignPdfOptions } from './sign';
export {
  createCasualPdfDoc,
  addAnnotation,
  acceptSuggestion,
  rejectSuggestion,
  readAnnotations,
  modeToState,
} from './model';
export type {
  CasualPdfDoc,
  AnnotationData,
  AnnotationType,
  EntryState,
} from './model';
// PDFium-backed text editing (Tier 2) lives in ./textedit-pdfium and is
// dynamically imported where used (chrome.tsx) so the PDFium edit path stays a
// lazy chunk; only the type is surfaced here.
export type { PdfTextRun } from './textedit-pdfium';
