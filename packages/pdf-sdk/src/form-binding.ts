// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Co-editing binding for AcroForm field values: keeps the EmbedPDF form plugin and
 * the Yjs overlay's `formValues` map in sync, so filling a field on one client
 * appears on the others. Values are a flat `name → string` map (the plugin's
 * `getFormValues`/`setFormValues` shape), which merges conflict-free in Yjs.
 *
 * Echo safety is by CONTENT-EQUALITY, not a timing flag: local→model only writes a
 * field whose value actually differs from the model, and model→local only pushes to
 * the plugin when the plugin differs — so a change that bounces back (the plugin's
 * event fires asynchronously after `setFormValues`) is a no-op and can't loop. This
 * is the lesson from the annotation-binding hardening, applied up front.
 */
import type * as Y from 'yjs';
import type { CasualPdfDoc } from './model';

export const FORM_LOCAL_ORIGIN = 'casual-pdf-local-form';

/** The slice of the EmbedPDF form capability the binding needs, adapted for one
 *  document + made testable (a fake implements this in Node). */
export interface FormBridge {
  /** Subscribe to field-value changes; returns an unsubscribe fn. */
  onFieldValueChange(cb: () => void): () => void;
  /** Current field values as a flat name → string map. */
  getValues(): Record<string, string>;
  /** Push field values into the plugin. */
  setValues(values: Record<string, string>): void;
}

/** Bind form field values bidirectionally. Returns a teardown fn. */
export function bindFormValues(bridge: FormBridge, model: CasualPdfDoc): () => void {
  // ── local plugin → Yjs model ───────────────────────────────────────────────
  const offEvent = bridge.onFieldValueChange(() => {
    const values = bridge.getValues();
    const changed: [string, string][] = [];
    for (const [k, v] of Object.entries(values)) {
      if (model.formValues.get(k) !== v) changed.push([k, v]);
    }
    if (!changed.length) return; // nothing new — an echo of a remote apply
    model.doc.transact(() => {
      for (const [k, v] of changed) model.formValues.set(k, v);
    }, FORM_LOCAL_ORIGIN);
  });

  // ── Yjs model → local plugin ───────────────────────────────────────────────
  const observer = (_events: unknown, txn: Y.Transaction) => {
    if (txn.origin === FORM_LOCAL_ORIGIN) return; // our own write (echo guard)
    const current = bridge.getValues();
    const values: Record<string, string> = {};
    let differs = false;
    model.formValues.forEach((v, k) => {
      const s = String(v);
      values[k] = s;
      if (current[k] !== s) differs = true;
    });
    if (differs) bridge.setValues(values);
  };
  model.formValues.observe(observer);

  return () => {
    offEvent();
    model.formValues.unobserve(observer);
  };
}

/** Shape of the real EmbedPDF form capability we depend on (structural — avoids a
 *  hard import of the plugin's types in this pure module). */
export interface FormCapabilityLike {
  onFieldValueChange(cb: (e: { documentId: string }) => void): () => void;
  getFormValues(documentId?: string): Record<string, string>;
  setFormValues(values: Record<string, string>, documentId?: string): unknown;
}

/** Adapt the real form capability to a `FormBridge` scoped to one document. */
export function formBridge(cap: FormCapabilityLike, documentId: string): FormBridge {
  return {
    onFieldValueChange: (cb) =>
      cap.onFieldValueChange((e) => {
        if (e.documentId === documentId) cb();
      }),
    getValues: () => cap.getFormValues(documentId),
    setValues: (values) => {
      cap.setFormValues(values, documentId); // fire-and-forget (PdfTask)
    },
  };
}
