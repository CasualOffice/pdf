// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import type { CSSProperties, MutableRefObject } from 'react';

/**
 * Interaction mode — what the user may do. Orthogonal to collab (single-user vs
 * multiplayer). See docs/ARCHITECTURE.md §2b.
 *
 *  - `view`    read-only: render, scroll, search, print.
 *  - `edit`    direct manipulation: changes apply to the overlay immediately.
 *  - `suggest` proposals: edits are recorded as pending suggestions an owner
 *              accepts (apply) or rejects (discard) — Google-Docs-style.
 */
export type Mode = 'view' | 'edit' | 'suggest';

/** Role granted on a share link / room, enforced server-side by services/collab. */
export type Role = 'viewer' | 'commenter' | 'editor' | 'signer';

/** Map a granted role to the mode it permits. */
export function roleToMode(role: Role): Mode {
  switch (role) {
    case 'viewer':
      return 'view';
    case 'commenter':
      return 'suggest';
    case 'editor':
    case 'signer':
      return 'edit';
  }
}

/** Collab connection. Omit on `CasualPdfProps` for solo / local-persistence mode. */
export interface CollabConfig {
  /** Hocuspocus WebSocket URL of services/collab, e.g. `wss://collab.example/yjs`. */
  url: string;
  /** Room / document name. */
  room: string;
  /** Optional share token (resolved to a role server-side). */
  token?: string;
}

/** Local user identity — used for suggestion authorship and collab presence. */
export interface Identity {
  name: string;
  color?: string;
}

/** Imperative handle the host can call (e.g. from app menus) once the viewer is
 *  ready. Populated on the `apiRef` prop. Null until a document is loaded. */
export interface CasualPdfApi {
  /** Download the current document (annotations baked in). */
  download(): void;
  undo(): void;
  redo(): void;
  /** Delete the currently selected annotation(s). */
  deleteSelection(): void;
  /** Activate an annotation tool by id, or null to return to select. */
  setTool(toolId: string | null): void;
}

export interface CasualPdfProps {
  /** PDF source URL. (Byte-array sources land in Phase 1.) */
  src: string;
  /** Interaction mode. Defaults to `view`. */
  mode?: Mode;
  /** Called when the user changes mode via the toolbar's mode dropdown. When
   *  omitted, the dropdown renders as a static (read-only) indicator. */
  onModeChange?: (mode: Mode) => void;
  /** Attach to a collab server for co-editing. Omit → solo, persisted locally. */
  collab?: CollabConfig;
  /** Local user identity (authorship + presence). */
  identity?: Identity;
  /** Receives an imperative API once the document is ready (for host menus). */
  apiRef?: MutableRefObject<CasualPdfApi | null>;
  className?: string;
  style?: CSSProperties;
}
