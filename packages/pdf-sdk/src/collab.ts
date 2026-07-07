// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import type * as Y from 'yjs';
import type { CollabConfig, Identity } from './modes';
import { readPeers, type Peer, type PeerCursor } from './presence';

/** A live collab connection that can be torn down. */
export interface CollabHandle {
  disconnect(): void;
  /** Subscribe to the room's remote peers (awareness). Fires immediately with the
   *  current set, then on every join/leave/identity change. Returns unsubscribe. */
  onPresence(cb: (peers: Peer[]) => void): () => void;
  /** Run `cb` once the initial server sync completes (fires immediately if already
   *  synced). Used to seed a fresh room from the base document. */
  onSynced(cb: () => void): () => void;
  /** Broadcast this client's current 1-based page to peers (via awareness), so
   *  presence can show WHERE each collaborator is, not just who's here. */
  setActivePage(page: number): void;
  /** Broadcast this client's live cursor position (page + fractional coords), or
   *  null to clear it (pointer left the canvas). Powers remote cursors. */
  setCursor(cursor: PeerCursor | null): void;
}

/** Awareness state shape we read (identity + active page + live cursor). */
type AwarenessState = { user?: { name?: string; color?: string }; page?: number; cursor?: PeerCursor };

/**
 * Attach a Y.Doc to a services/collab room for co-editing. Omitting this (the
 * default) keeps the editor single-user with local persistence — collab is an
 * orthogonal flag, not a different build (docs/ARCHITECTURE.md §2b, §6).
 *
 * The provider is imported lazily so solo builds don't pull the WebSocket
 * client into the bundle.
 */
export async function attachCollab(
  doc: Y.Doc,
  cfg: CollabConfig,
  identity?: Identity,
): Promise<CollabHandle> {
  const { HocuspocusProvider } = await import('@hocuspocus/provider');
  // services/collab's `onAuthenticate` reads the share token from the WS query
  // string (`?share=`), not the Hocuspocus auth message — see
  // services/collab/src/yjs.ts:101-134. Append it to the URL so the server
  // authenticates; also pass it via `token` for servers that read the auth message.
  let url = cfg.url;
  if (cfg.token) {
    try {
      const u = new URL(cfg.url);
      u.searchParams.set('share', cfg.token);
      url = u.toString();
    } catch {
      /* non-absolute URL — leave as-is; token still goes via the auth message */
    }
  }
  const provider = new HocuspocusProvider({
    url,
    name: cfg.room,
    token: cfg.token,
    document: doc,
  });
  if (identity) {
    provider.awareness?.setLocalStateField('user', {
      name: identity.name,
      color: identity.color,
    });
  }
  return {
    disconnect: () => provider.destroy(),
    onPresence: (cb) => {
      const aw = provider.awareness;
      if (!aw) return () => {};
      const emit = () => cb(readPeers(aw.getStates() as Map<number, AwarenessState>, aw.clientID));
      aw.on('change', emit);
      emit(); // fire with the current set immediately
      return () => aw.off('change', emit);
    },
    onSynced: (cb) => {
      // The provider fires `synced` with `{ state }` once step-2 sync completes.
      const h = (data: { state: boolean }) => { if (data.state) cb(); };
      provider.on('synced', h);
      if (provider.synced) cb(); // already synced by the time we subscribe
      return () => provider.off('synced', h);
    },
    setActivePage: (page) => provider.awareness?.setLocalStateField('page', page),
    setCursor: (cursor) => provider.awareness?.setLocalStateField('cursor', cursor),
  };
}
