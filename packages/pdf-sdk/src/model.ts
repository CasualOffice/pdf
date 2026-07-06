// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import * as Y from 'yjs';
import type { Mode } from './modes';

/**
 * The editable overlay model. The base PDF bytes are immutable and
 * content-addressed; everything a user can change collaboratively lives in this
 * Yjs document. Merging two annotation inserts is conflict-free; merging raw PDF
 * bytes is not — hence the split (docs/ARCHITECTURE.md §1, §4).
 *
 * Suggestions are not a separate subsystem: every entry carries a `state`.
 * Edit mode writes `applied`; Suggest mode writes `suggested`; accepting a
 * suggestion flips it to `applied`; rejecting removes it. One mechanism unifies
 * comments, suggestions, and tracked-changes.
 */

export type EntryState = 'applied' | 'suggested';

export type AnnotationType =
  | 'highlight'
  | 'ink'
  | 'note'
  | 'text'
  | 'shape'
  | 'stamp'
  | 'redaction';

/** A plain (non-CRDT) view of an annotation, as read/written by the UI. */
export interface AnnotationData {
  id: string;
  type: AnnotationType;
  page: number;
  /** [x0, y0, x1, y1] in PDF page coordinates. */
  rect: [number, number, number, number];
  props: Record<string, unknown>;
  author: string;
  state: EntryState;
  reviewedBy?: string;
  createdAt: number;
}

/** Handles to the shared types inside one Casual PDF Y.Doc. */
export interface CasualPdfDoc {
  doc: Y.Doc;
  meta: Y.Map<unknown>;
  annotations: Y.Array<Y.Map<unknown>>;
  formValues: Y.Map<unknown>;
  comments: Y.Array<Y.Map<unknown>>;
  signing: Y.Map<unknown>;
}

/** The mode under which a new edit is recorded. */
export function modeToState(mode: Mode): EntryState {
  return mode === 'suggest' ? 'suggested' : 'applied';
}

/** Create (or adopt) the standard Casual PDF document structure. */
export function createCasualPdfDoc(baseVersionId: string, doc: Y.Doc = new Y.Doc()): CasualPdfDoc {
  const meta = doc.getMap('meta');
  if (!meta.has('baseVersionId')) meta.set('baseVersionId', baseVersionId);
  if (!meta.has('pageOrder')) meta.set('pageOrder', new Y.Array<number>());
  return {
    doc,
    meta,
    annotations: doc.getArray<Y.Map<unknown>>('annotations'),
    formValues: doc.getMap('formValues'),
    comments: doc.getArray<Y.Map<unknown>>('comments'),
    signing: doc.getMap('signing'),
  };
}

function findAnnotationIndex(model: CasualPdfDoc, id: string): number {
  for (let i = 0; i < model.annotations.length; i++) {
    if (model.annotations.get(i).get('id') === id) return i;
  }
  return -1;
}

/** Add an annotation. In `suggest` mode it is recorded as a pending suggestion. */
export function addAnnotation(
  model: CasualPdfDoc,
  data: Omit<AnnotationData, 'state'>,
  mode: Mode,
): void {
  const entry = new Y.Map<unknown>();
  const full: AnnotationData = { ...data, state: modeToState(mode) };
  for (const [k, v] of Object.entries(full)) entry.set(k, v);
  model.annotations.push([entry]);
}

/** Accept a pending suggestion: flip `suggested → applied`. */
export function acceptSuggestion(model: CasualPdfDoc, id: string, reviewer: string): void {
  const i = findAnnotationIndex(model, id);
  if (i < 0) return;
  const entry = model.annotations.get(i);
  if (entry.get('state') !== 'suggested') return;
  entry.set('state', 'applied');
  entry.set('reviewedBy', reviewer);
}

/** Reject a pending suggestion: remove it from the overlay. */
export function rejectSuggestion(model: CasualPdfDoc, id: string): void {
  const i = findAnnotationIndex(model, id);
  if (i < 0) return;
  if (model.annotations.get(i).get('state') !== 'suggested') return;
  model.annotations.delete(i, 1);
}

/** Read all annotations as plain objects (e.g. to paint the overlay). */
export function readAnnotations(model: CasualPdfDoc): AnnotationData[] {
  return model.annotations.toArray().map((m) => m.toJSON() as AnnotationData);
}

/** The pending suggestions (entries in the `suggested` state), for a review UI. */
export function readSuggestions(model: CasualPdfDoc): AnnotationData[] {
  return readAnnotations(model).filter((a) => a.state === 'suggested');
}
