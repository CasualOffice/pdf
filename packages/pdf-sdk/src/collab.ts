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
  const provider = new HocuspocusProvider({
    url: cfg.url,
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
