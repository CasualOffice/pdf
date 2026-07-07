// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * `useCollab` — attach live collaboration to the annotation plugin for one open
 * document. When `collab` is set it creates a Y.Doc, connects it to the
 * services/collab room (`attachCollab`), and binds it bidirectionally to the
 * EmbedPDF annotation plugin (`bindAnnotations`). A no-op (solo, local-only) when
 * `collab` is omitted — collab is an orthogonal runtime flag, not a build.
 *
 * Suggestions: annotations created in Suggest mode are stamped `state:'suggested'`
 * in the overlay; `suggestions` surfaces the pending ones and `acceptSuggestion`/
 * `rejectSuggestion` review them (accept → applied; reject → removed everywhere).
 *
 * NOTE (source-of-truth): with collab on, the Yjs overlay is authoritative for
 * annotations, so the base PDF should be annotation-free. Seeding a base doc's
 * existing annotations into the room on first connect is a tracked follow-up.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createCasualPdfDoc, readSuggestions, acceptSuggestion, rejectSuggestion, type CasualPdfDoc, type AnnotationData } from './model';
import { annotationBridge, bindAnnotations, seedAnnotations, Y, type AnnotationCapabilityLike } from './collab-binding';
import { attachCollab, type CollabHandle } from './collab';
import type { Peer } from './presence';
import type { CollabConfig, Identity, Mode } from './modes';

/** Live collab state exposed to the UI. Empty/no-op in solo mode. */
export interface CollabState {
  peers: Peer[];
  /** Pending suggestions in the room (Suggest-mode proposals awaiting review). */
  suggestions: AnnotationData[];
  /** Accept a suggestion by id → it becomes an applied edit (syncs to peers). */
  acceptSuggestion(id: string): void;
  /** Reject a suggestion by id → it is removed from the overlay (and all peers). */
  rejectSuggestion(id: string): void;
  /** Broadcast this client's current 1-based page to peers (presence "where"). */
  setActivePage(page: number): void;
}

export function useCollab(
  cap: AnnotationCapabilityLike | undefined,
  documentId: string,
  collab: CollabConfig | undefined,
  identity: Identity | undefined,
  mode?: Mode,
): CollabState {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [suggestions, setSuggestions] = useState<AnnotationData[]>([]);
  const modelRef = useRef<CasualPdfDoc | null>(null);
  const handleRef = useRef<CollabHandle | null>(null);
  // Live mode without re-running the connection effect — the binding reads it at
  // create-time to stamp `suggested` vs `applied`.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Hold the capability in a ref and gate the effect on its AVAILABILITY, not its
  // object identity — the plugin returns a fresh `provides` each render, so
  // depending on `cap` directly would tear down + reconnect every render (a
  // WebSocket storm). We connect once when it becomes available.
  const capRef = useRef(cap);
  capRef.current = cap;
  const hasCap = !!cap;

  const url = collab?.url;
  const room = collab?.room;
  const token = collab?.token;
  const name = identity?.name;
  const color = identity?.color;

  useEffect(() => {
    const cap = capRef.current;
    if (!cap || !url || !room) {
      setPeers([]);
      setSuggestions([]);
      return;
    }
    const cfg: CollabConfig = { url, room, token };
    const id: Identity | undefined = name ? { name, color } : undefined;

    const ydoc = new Y.Doc();
    const model = createCasualPdfDoc(room, ydoc);
    modelRef.current = model;
    const bridge = annotationBridge(cap, documentId);
    const unbind = bindAnnotations(bridge, model, {
      author: name ?? 'anonymous',
      getState: () => (modeRef.current === 'suggest' ? 'suggested' : 'applied'),
    });

    const refreshSuggestions = () => setSuggestions(readSuggestions(model));
    model.annotations.observeDeep(refreshSuggestions);
    refreshSuggestions();

    let handle: CollabHandle | null = null;
    let offPresence: (() => void) | null = null;
    let offSynced: (() => void) | null = null;
    let cancelled = false;
    attachCollab(ydoc, cfg, id)
      .then((h) => {
        if (cancelled) {
          h.disconnect();
          return;
        }
        handle = h;
        handleRef.current = h;
        offPresence = h.onPresence(setPeers);
        // Source-of-truth seed: once the room has synced, if it's empty and not
        // yet seeded, publish the base document's annotations (already loaded in
        // the plugin) so they're shared. `meta.seeded` guards against re-seeding.
        offSynced = h.onSynced(() => {
          if (model.meta.get('seeded') || model.annotations.length > 0) return;
          const base = bridge.listAnnotations();
          if (base.length) seedAnnotations(model, base, name ?? 'anonymous');
          model.doc.transact(() => model.meta.set('seeded', true));
        });
      })
      .catch(() => {
        /* offline / bad URL → the binding still keeps the local Y.Doc in sync */
      });

    return () => {
      cancelled = true;
      offPresence?.();
      offSynced?.();
      model.annotations.unobserveDeep(refreshSuggestions);
      unbind();
      handle?.disconnect();
      handleRef.current = null;
      ydoc.destroy();
      modelRef.current = null;
      setPeers([]);
      setSuggestions([]);
    };
    // Availability + primitive config only — NOT the `cap` object identity.
  }, [hasCap, documentId, url, room, token, name, color]);

  const accept = useCallback(
    (sid: string) => {
      if (modelRef.current) acceptSuggestion(modelRef.current, sid, name ?? 'anonymous');
    },
    [name],
  );
  const reject = useCallback((sid: string) => {
    if (modelRef.current) rejectSuggestion(modelRef.current, sid);
  }, []);
  const setActivePage = useCallback((page: number) => {
    handleRef.current?.setActivePage(page);
  }, []);

  return { peers, suggestions, acceptSuggestion: accept, rejectSuggestion: reject, setActivePage };
}
