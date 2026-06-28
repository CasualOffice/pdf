// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

export { CasualPdf } from './CasualPdf';
export { Icon } from './ui/icons';
export type { IconName } from './ui/icons';
export { attachCollab } from './collab';
export type { CollabHandle } from './collab';
export { roleToMode } from './modes';
export type { Mode, Role, CollabConfig, Identity, CasualPdfProps, CasualPdfApi } from './modes';
// Certified signing lives behind the `@casualoffice/pdf/sign` subpath so the
// crypto stack (node-forge, ~90 KB gz) only loads when a host imports it
// (lazily). Types are re-exported here for convenience without pulling runtime.
export type { SignPdfOptions, SelfSignedOptions } from './sign';
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
