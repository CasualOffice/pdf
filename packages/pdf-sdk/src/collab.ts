// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import type * as Y from 'yjs';
import type { CollabConfig, Identity } from './modes';

/** A live collab connection that can be torn down. */
export interface CollabHandle {
  disconnect(): void;
}

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
  };
}
