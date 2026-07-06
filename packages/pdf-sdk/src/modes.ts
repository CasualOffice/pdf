// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import type { CSSProperties, MutableRefObject } from 'react';
import type { PageText } from './extract';
import type { FormFieldInfo, FillValue } from './ai/form';

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

/** Map a granted role to the HIGHEST mode it permits. */
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

/** Every mode a role may use, least- to most-privileged. `view` is always allowed.
 *  The UI uses this to disable higher modes; the collab server enforces the real
 *  gate (`connection.readOnly`), so this is a reflection, not the security boundary. */
export function allowedModes(role: Role): Mode[] {
  switch (role) {
    case 'viewer':
      return ['view'];
    case 'commenter':
      return ['view', 'suggest'];
    case 'editor':
    case 'signer':
      return ['view', 'suggest', 'edit'];
  }
}

/** Clamp a requested mode to what `role` permits — a viewer asked to `edit` gets
 *  `view`. Defense-in-depth so the editor never renders write UI above the role. */
export function clampMode(mode: Mode, role: Role): Mode {
  return allowedModes(role).includes(mode) ? mode : roleToMode(role);
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
  /** True when there is at least one annotation-history entry to undo. */
  canUndo(): boolean;
  /** True when there is at least one annotation-history entry to redo. */
  canRedo(): boolean;
  /** Delete the currently selected annotation(s). */
  deleteSelection(): void;
  /** Activate an annotation tool by id, or null to return to select. */
  setTool(toolId: string | null): void;
  /** Open the in-viewer find/search bar. */
  openSearch(): void;
  /** Open the visible signature flow: draw/type a signature, then click a page
   *  to place it. The host should switch to edit mode before calling this. */
  openSignature(): void;
  /** True when the document already has a visible signature annotation. */
  hasVisibleSignature(): boolean;
  /** Current document bytes (annotations/signatures baked in) for the host to
   *  post-process — e.g. apply a certified digital signature. Null if export
   *  isn't ready. */
  getBytes(): Promise<Uint8Array | null>;

  // ── Read / navigation surface (Phase A0 — the AI DocOps tool bridge) ────────
  /** Total page count, or 0 before the document is ready. */
  pageCount(): number;
  /** Scroll the viewer to a zero-based page index. */
  gotoPage(pageIndex: number): void;
  /** The document outline/bookmarks, flattened to `{ title, pageIndex, children }`
   *  (empty when the PDF has none). */
  getOutline(): Promise<OutlineNode[]>;
  /** Canonical text-with-coordinates for a page — the AI grounding / citation
   *  primitive (see `extract.ts`). Null if export isn't ready. */
  extractText(pageIndex: number): Promise<PageText | null>;
  /** Text for EVERY page in one pass (a single export). Used by whole-document
   *  AI retrieval (RAG-lite). Empty array if export isn't ready. */
  extractAllText(): Promise<PageText[]>;
  /** Highlight text regions on a page (AI citation source-span highlighting).
   *  `rects` are PDF user-space bounds (bottom-left), as returned by
   *  {@link extractText}. Adds a highlight annotation and scrolls to the page. */
  highlightRegion(pageIndex: number, rects: { left: number; bottom: number; right: number; top: number }[]): void;
  /** Add redaction MARKS on a page (AI PII redaction). `rects` are fractional
   *  top-left `{x,y,w,h}`, as returned by {@link extractText} run `frac`. This
   *  only proposes marks and enters redaction review — it NEVER removes content;
   *  the user must confirm Apply. */
  addRedactionMarks(pageIndex: number, rects: { x: number; y: number; w: number; h: number }[]): void;
  /** List the document's AcroForm fields (name, type, value, options). Empty
   *  array if there is no form or export isn't ready. */
  listFormFields(): Promise<FormFieldInfo[]>;
  /** Fill AcroForm fields by name and reload the viewer with the filled bytes.
   *  Returns which fields were filled vs skipped. */
  fillForm(values: FillValue[]): Promise<{ filled: string[]; skipped: string[] }>;
  /** Optional embedder for semantic (dense) retrieval — supplied by the runtime
   *  (desktop llama.cpp worker / collab server), NOT bundled in the client. When
   *  absent, `search_document` uses BM25 alone; when present, BM25 + dense fused
   *  via RRF. Returns one vector per input text. */
  embedTexts?(texts: string[]): Promise<number[][]>;
}

/** A node in the document outline returned by {@link CasualPdfApi.getOutline}. */
export interface OutlineNode {
  title: string;
  /** Destination page (zero-based), or null for a non-page target. */
  pageIndex: number | null;
  children: OutlineNode[];
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
  /** The viewer's granted role. When set, the effective mode is clamped to what
   *  the role permits (`allowedModes`) — a reflection of the server-enforced
   *  rights, not the security boundary. Omit → all modes available (solo). */
  role?: Role;
  /** Receives an imperative API once the document is ready (for host menus). */
  apiRef?: MutableRefObject<CasualPdfApi | null>;
  /** Fired the first time the document is edited (annotation added/changed,
   *  pages organized, redaction applied). Lets the host warn before discarding
   *  unsaved work (e.g. on Open or tab close). */
  onEdited?: () => void;
  /**
   * Fired when the document bytes are replaced by an operation (redaction,
   * organize pages, or when the user exits the text-edit tool after making edits).
   * The host should reload the viewer with these bytes (e.g. via a new Blob URL
   * as the `src` prop) so that EmbedPDF's text layer re-indexes — `openDocumentBuffer`
   * skips that step. Text-edit commits use `openDocumentBuffer` internally for a
   * seamless editing experience; `onDocumentReplaced` fires once on tool deactivation.
   */
  onDocumentReplaced?: (bytes: Uint8Array) => void;
  /** Called when the undo button or Ctrl+Z is triggered from within the viewer
   *  chrome. Lets the host inject two-level undo (annotation-history first, then
   *  document-version undo). When omitted, the rail button calls annotation undo. */
  onUndo?: () => void;
  /** Symmetric with `onUndo` — called for redo actions from the viewer chrome. */
  onRedo?: () => void;
  className?: string;
  style?: CSSProperties;
}
