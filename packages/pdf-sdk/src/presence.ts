// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Collab presence — the remote peers in a room, derived from Yjs/Hocuspocus
 * awareness. Awareness is format-agnostic (the collab agents confirmed it
 * transfers directly from the Docs setup), so this is just: read the awareness
 * states, drop our own client, and surface each peer's identity.
 *
 * The read is a pure function so it unit-tests without a live provider.
 */

/** A peer's live cursor position: a page index (0-based) + fractional coords
 *  (0..1, top-left) within that page, so it maps to the same spot on any zoom. */
export interface PeerCursor {
  page: number;
  x: number;
  y: number;
}

/** A remote collaborator currently connected to the room. */
export interface Peer {
  /** Yjs awareness client id (stable per connection). */
  clientId: number;
  name: string;
  color?: string;
  /** The peer's current 1-based page, if they've broadcast it (see `setActivePage`). */
  page?: number;
  /** The peer's live cursor position on the canvas, if broadcast (see `setCursor`). */
  cursor?: PeerCursor;
}

/** The shape of an awareness state entry we care about: the identity (set by
 *  `attachCollab` as `setLocalStateField('user', …)`) and the active page (set by
 *  `setActivePage` as `setLocalStateField('page', n)`). */
export interface AwarenessUserState {
  user?: { name?: string; color?: string };
  page?: number;
  cursor?: PeerCursor;
}

/** Extract the remote peers from an awareness state map, excluding our own client
 *  and any entry without a user name. Sorted by client id for stable rendering. */
export function readPeers(
  states: Map<number, AwarenessUserState>,
  selfClientId: number,
): Peer[] {
  const peers: Peer[] = [];
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const user = state?.user;
    if (user?.name) {
      const peer: Peer = { clientId, name: user.name, color: user.color };
      if (typeof state.page === 'number') peer.page = state.page;
      const c = state.cursor;
      if (c && typeof c.page === 'number' && typeof c.x === 'number' && typeof c.y === 'number') peer.cursor = c;
      peers.push(peer);
    }
  }
  return peers.sort((a, b) => a.clientId - b.clientId);
}

/** Up-to-two uppercase initials for an avatar (e.g. "Ada Lovelace" → "AL"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
