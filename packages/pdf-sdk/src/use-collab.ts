// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * `useCollab` — attach live collaboration to the annotation plugin for one open
 * document. When `collab` is set it creates a Y.Doc, connects it to the
 * services/collab room (`attachCollab`), and binds it bidirectionally to the
 * EmbedPDF annotation plugin (`bindAnnotations`). A no-op (solo, local-only) when
 * `collab` is omitted — collab is an orthogonal runtime flag, not a build.
 *
 * NOTE (source-of-truth): with collab on, the Yjs overlay is authoritative for
 * annotations, so the base PDF should be annotation-free (annotations live in the
 * room). Seeding a base doc's existing annotations into the room on first connect
 * is a tracked follow-up; today the base's own annotations render locally but
 * aren't shared (the binding ignores the plugin's initial `loaded` batch).
 */
import { useEffect, useState } from 'react';
import { createCasualPdfDoc } from './model';
import { annotationBridge, bindAnnotations, Y, type AnnotationCapabilityLike } from './collab-binding';
import { attachCollab, type CollabHandle } from './collab';
import type { Peer } from './presence';
import type { CollabConfig, Identity } from './modes';

/** Live collab state exposed to the UI. `peers` is empty in solo mode. */
export interface CollabState {
  peers: Peer[];
}

export function useCollab(
  cap: AnnotationCapabilityLike | undefined,
  documentId: string,
  collab: CollabConfig | undefined,
  identity: Identity | undefined,
): CollabState {
  const [peers, setPeers] = useState<Peer[]>([]);
  const url = collab?.url;
  const room = collab?.room;
  const token = collab?.token;
  const name = identity?.name;
  const color = identity?.color;

  useEffect(() => {
    if (!cap || !url || !room) return;
    const cfg: CollabConfig = { url, room, token };
    const id: Identity | undefined = name ? { name, color } : undefined;

    const ydoc = new Y.Doc();
    const model = createCasualPdfDoc(room, ydoc);
    const unbind = bindAnnotations(annotationBridge(cap, documentId), model, {
      author: name ?? 'anonymous',
    });

    let handle: CollabHandle | null = null;
    let offPresence: (() => void) | null = null;
    let cancelled = false;
    attachCollab(ydoc, cfg, id)
      .then((h) => {
        if (cancelled) {
          h.disconnect();
          return;
        }
        handle = h;
        offPresence = h.onPresence(setPeers);
      })
      .catch(() => {
        /* offline / bad URL → the binding still keeps the local Y.Doc in sync */
      });

    return () => {
      cancelled = true;
      offPresence?.();
      unbind();
      handle?.disconnect();
      ydoc.destroy();
      setPeers([]);
    };
    // Primitive deps so a new-but-equal collab/identity object doesn't reconnect.
  }, [cap, documentId, url, room, token, name, color]);

  return { peers };
}
