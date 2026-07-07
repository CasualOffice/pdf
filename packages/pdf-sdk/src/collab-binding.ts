// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Bidirectional binding between the EmbedPDF annotation plugin and the Yjs
 * overlay model (`model.ts`). This is the CRDT binding the collab agents flagged
 * as necessary — `y-prosemirror` is rich-text-only, so a PDF annotation overlay
 * (a Yjs collection of annotation entries) needs a custom binding.
 *
 * Two directions, each guarded against echoing the other into a loop:
 *   - **local → model**: subscribe the plugin's `onAnnotationEvent`; on a
 *     *committed* create/update/delete, upsert/remove the entry in the Yjs
 *     `annotations` array (in a transaction tagged with the `LOCAL_ORIGIN` so the
 *     model observer below ignores it).
 *   - **model → local**: observe the Yjs array; on a change that did NOT originate
 *     locally (i.e. a remote peer), reconcile the plugin's annotations to match —
 *     create missing, update changed, delete removed. Reconcile (diff current
 *     state) rather than replaying deltas, so it's robust to any update shape.
 *
 * The binding is decoupled from EmbedPDF via the `AnnotationBridge` interface so
 * it unit-tests in Node without a browser; the wiring layer adapts the real
 * `useAnnotation` capability to this interface.
 */
import * as Y from 'yjs';
import type { CasualPdfDoc, AnnotationData, AnnotationType, EntryState } from './model';

// Re-export the Yjs namespace so consumers/tests that only depend on this SDK can
// construct docs + apply updates without a direct `yjs` dependency of their own.
export * as Y from 'yjs';

/** The raw EmbedPDF annotation object. Shape-opaque — we round-trip the whole
 *  thing through `props` so no type-specific field is lost, and only require an
 *  `id` (the plugin's stable uid) to key upserts/deletes. */
export interface RawAnnotation {
  id: string;
  /** EmbedPDF subtype enum (number) or name. */
  type?: number | string;
  rect?: { origin: { x: number; y: number }; size: { width: number; height: number } };
  [k: string]: unknown;
}

/** A committed change the plugin emitted, or `loaded` (initial batch — ignored). */
export type BridgeEvent =
  | { type: 'create' | 'update' | 'delete'; committed: boolean; pageIndex: number; annotation: RawAnnotation }
  | { type: 'loaded'; total: number };

/** The minimal annotation-plugin surface the binding needs. The wiring layer
 *  adapts EmbedPDF's `useAnnotation` capability to this. */
export interface AnnotationBridge {
  /** Subscribe to committed annotation changes. Returns an unsubscribe fn. */
  onAnnotationEvent(cb: (ev: BridgeEvent) => void): () => void;
  /** Every annotation currently in the plugin, with its page index. */
  listAnnotations(): { pageIndex: number; annotation: RawAnnotation }[];
  createAnnotation(pageIndex: number, annotation: RawAnnotation): void;
  updateAnnotation(pageIndex: number, id: string, annotation: RawAnnotation): void;
  deleteAnnotation(pageIndex: number, id: string): void;
}

export interface BindOptions {
  /** Author recorded on entries this client creates. */
  author: string;
  /** State stamped on entries this client CREATES (updates preserve the existing
   *  state). In Suggest mode return `'suggested'`; defaults to `'applied'`. */
  getState?: () => EntryState;
}

/** Yjs transaction origin marking writes the binding made from local plugin
 *  events — so the model observer skips them (they're already in the plugin). */
export const LOCAL_ORIGIN = 'casual-pdf-local-annotation';

/** Map an EmbedPDF subtype to the overlay model's coarse `AnnotationType`. The
 *  full raw object is preserved in `props`; this is only for the structured view
 *  (suggestions/filtering). Unknown subtypes fall back to `shape`. */
function coarseType(raw: RawAnnotation): AnnotationType {
  const t = String(raw.type ?? '').toLowerCase();
  if (t.includes('highlight')) return 'highlight';
  if (t.includes('ink')) return 'ink';
  if (t.includes('freetext') || t === 'text') return 'text';
  if (t.includes('text')) return 'note';
  if (t.includes('stamp')) return 'stamp';
  if (t.includes('redact')) return 'redaction';
  return 'shape';
}

function toRect(raw: RawAnnotation): [number, number, number, number] {
  const r = raw.rect;
  if (r && r.origin && r.size) {
    return [r.origin.x, r.origin.y, r.origin.x + r.size.width, r.origin.y + r.size.height];
  }
  return [0, 0, 0, 0];
}

/** Build the structured overlay fields for an annotation entry, keeping the raw
 *  object under `props` for lossless round-tripping back to the plugin. `state` is
 *  set separately (create-time only) so updates don't clobber a suggestion. */
function toEntryFields(raw: RawAnnotation, pageIndex: number, author: string): Partial<AnnotationData> {
  return {
    id: raw.id,
    type: coarseType(raw),
    page: pageIndex,
    rect: toRect(raw),
    props: raw as unknown as Record<string, unknown>,
    author,
  };
}

/**
 * Bind the plugin (`bridge`) to the Yjs overlay (`model`). Returns a teardown fn
 * that detaches both directions. Call once per (document, connection).
 */
export function bindAnnotations(bridge: AnnotationBridge, model: CasualPdfDoc, opts: BindOptions): () => void {
  // Set while applying remote model changes to the plugin, so the plugin events
  // those calls emit aren't written straight back into the model (echo guard #1).
  let applyingRemote = false;

  const indexOfId = (id: string): number => {
    for (let i = 0; i < model.annotations.length; i++) {
      if (model.annotations.get(i).get('id') === id) return i;
    }
    return -1;
  };

  // ── local plugin → Yjs model ───────────────────────────────────────────────
  const offEvent = bridge.onAnnotationEvent((ev) => {
    if (applyingRemote) return; // don't re-record a change we just applied remotely
    if (ev.type === 'loaded') return; // initial batch is already in the model/base
    if (!ev.committed) return; // only sync final commits, not in-progress previews

    model.doc.transact(() => {
      if (ev.type === 'delete') {
        const i = indexOfId(ev.annotation.id);
        if (i >= 0) model.annotations.delete(i, 1);
        return;
      }
      const fields = toEntryFields(ev.annotation, ev.pageIndex, opts.author);
      const i = indexOfId(ev.annotation.id);
      if (i >= 0) {
        // Update: overwrite geometry/props but PRESERVE the entry's state (an
        // edit to a pending suggestion stays pending).
        const entry = model.annotations.get(i);
        for (const [k, v] of Object.entries(fields)) entry.set(k, v);
      } else {
        // Create: stamp the create-time state (Suggest mode → 'suggested').
        const entry = new Y.Map<unknown>();
        entry.set('createdAt', 0); // stamped by the app; kept stable for tests
        entry.set('state', opts.getState ? opts.getState() : 'applied');
        for (const [k, v] of Object.entries(fields)) entry.set(k, v);
        model.annotations.push([entry]);
      }
    }, LOCAL_ORIGIN);
  });

  // ── Yjs model → local plugin (reconcile) ───────────────────────────────────
  const reconcile = () => {
    applyingRemote = true;
    try {
      const modelById = new Map<string, { pageIndex: number; annotation: RawAnnotation }>();
      for (const entry of model.annotations.toArray()) {
        const data = entry.toJSON() as AnnotationData;
        const raw = (data.props as unknown as RawAnnotation) ?? { id: data.id };
        modelById.set(data.id, { pageIndex: data.page, annotation: raw });
      }
      const bridgeById = new Map(bridge.listAnnotations().map((a) => [a.annotation.id, a]));

      for (const [id, m] of modelById) {
        const b = bridgeById.get(id);
        if (!b) bridge.createAnnotation(m.pageIndex, m.annotation);
        else if (JSON.stringify(b.annotation) !== JSON.stringify(m.annotation)) {
          bridge.updateAnnotation(m.pageIndex, id, m.annotation);
        }
      }
      for (const [id, b] of bridgeById) {
        if (!modelById.has(id)) bridge.deleteAnnotation(b.pageIndex, id);
      }
    } finally {
      applyingRemote = false;
    }
  };

  const observer = (_events: Y.YEvent<Y.Map<unknown>>[], txn: Y.Transaction) => {
    if (txn.origin === LOCAL_ORIGIN) return; // our own local write (echo guard #2)
    reconcile();
  };
  model.annotations.observeDeep(observer);

  return () => {
    offEvent();
    model.annotations.unobserveDeep(observer);
  };
}

/**
 * Seed a fresh room with annotations already present in the base document (the
 * plugin's loaded batch) so they become shared. Idempotent by id — only adds ids
 * not already in the overlay, so it's safe to call more than once. Writes under
 * `LOCAL_ORIGIN` so the LOCAL binding doesn't re-apply them to the plugin (they're
 * already there); they still sync to peers, whose reconcile creates them.
 *
 * Caller must gate this to avoid double-seeding a room (see `useCollab`'s
 * `meta.seeded` guard). A rare simultaneous first-join race can still add
 * duplicate entries; the reconcile de-dups by id for rendering, so they never
 * paint twice — a follow-up would move seeding server-side to remove the race.
 */
export function seedAnnotations(
  model: CasualPdfDoc,
  entries: { pageIndex: number; annotation: RawAnnotation }[],
  author: string,
): void {
  const present = new Set(model.annotations.toArray().map((m) => m.get('id')));
  model.doc.transact(() => {
    for (const { pageIndex, annotation } of entries) {
      if (present.has(annotation.id)) continue;
      const entry = new Y.Map<unknown>();
      entry.set('createdAt', 0);
      entry.set('state', 'applied');
      for (const [k, v] of Object.entries(toEntryFields(annotation, pageIndex, author))) entry.set(k, v);
      model.annotations.push([entry]);
      present.add(annotation.id);
    }
  }, LOCAL_ORIGIN);
}

/* ── EmbedPDF adapter ─────────────────────────────────────────────────────────
   Adapt the real `useAnnotation` capability to the `AnnotationBridge` the binding
   consumes. Kept a pure function (not a hook) so it unit-tests without React. */

/** A raw annotation as the plugin tracks it (carries its own `pageIndex`). */
type TrackedLike = { object: RawAnnotation & { pageIndex: number } };

/** The EmbedPDF annotation-plugin event shape (a superset of `BridgeEvent`). */
export interface PluginAnnotationEvent {
  type: 'create' | 'update' | 'delete' | 'loaded';
  documentId?: string;
  annotation?: RawAnnotation;
  pageIndex?: number;
  committed?: boolean;
  total?: number;
}

/** The subset of EmbedPDF's `useAnnotation` capability the adapter consumes. */
export interface AnnotationCapabilityLike {
  onAnnotationEvent(cb: (ev: PluginAnnotationEvent) => void): () => void;
  getAnnotations(): TrackedLike[];
  createAnnotation(pageIndex: number, annotation: RawAnnotation): void;
  updateAnnotations(patches: { pageIndex: number; id: string; patch: RawAnnotation }[]): void;
  deleteAnnotations(annotations: { pageIndex: number; id: string }[]): void;
}

/** Wrap the plugin capability as an `AnnotationBridge`. Events for other documents
 *  (the capability is doc-scoped, but events carry a `documentId`) are dropped. */
export function annotationBridge(cap: AnnotationCapabilityLike, documentId: string): AnnotationBridge {
  return {
    onAnnotationEvent(cb) {
      return cap.onAnnotationEvent((ev) => {
        if (ev.documentId && ev.documentId !== documentId) return;
        if (ev.type === 'loaded') {
          cb({ type: 'loaded', total: ev.total ?? 0 });
          return;
        }
        if (!ev.annotation || ev.pageIndex == null) return;
        cb({ type: ev.type, committed: !!ev.committed, pageIndex: ev.pageIndex, annotation: ev.annotation });
      });
    },
    listAnnotations() {
      return cap.getAnnotations().map((t) => ({ pageIndex: t.object.pageIndex, annotation: t.object }));
    },
    createAnnotation(pageIndex, annotation) {
      cap.createAnnotation(pageIndex, annotation);
    },
    updateAnnotation(pageIndex, id, annotation) {
      cap.updateAnnotations([{ pageIndex, id, patch: annotation }]);
    },
    deleteAnnotation(pageIndex, id) {
      cap.deleteAnnotations([{ pageIndex, id }]);
    },
  };
}
