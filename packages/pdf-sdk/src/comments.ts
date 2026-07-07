// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Threaded comments over the Yjs overlay (`CasualPdfDoc.comments`). A comment is
 * anchored to a page region; replies form a thread; a thread can be resolved and
 * reopened; bodies can @-mention collaborators. Because comments live in the same
 * Y.Doc as annotations, they sync peer→peer for free when collab is on and persist
 * locally (y-indexeddb / bytes snapshot) when it's off — no EmbedPDF plugin binding
 * needed (unlike annotations, which the plugin owns).
 *
 * The model is a PURE function set (ids + timestamps are supplied by the caller,
 * not minted here) so the whole thread lifecycle is unit-testable without a clock.
 */

import * as Y from 'yjs';
import type { CasualPdfDoc } from './model';

/** A single comment — either a thread root (`id === threadId`) or a reply. */
export interface CommentData {
  id: string;
  /** The thread's root id. A top-level comment's own id; a reply points to it. */
  threadId: string;
  /** 0-based page index the thread is anchored to (root carries the anchor). */
  page: number;
  /** Anchor rect [x0,y0,x1,y1] in PDF page coords (root only; replies are null). */
  rect: [number, number, number, number] | null;
  author: string;
  body: string;
  createdAt: number;
  /** Thread-level resolved flag — meaningful on the root. */
  resolved: boolean;
  /** @-mentioned collaborator names parsed from the body. */
  mentions: string[];
}

/** A resolved view of one thread: its root, replies (chronological), status. */
export interface CommentThread {
  root: CommentData;
  replies: CommentData[];
  resolved: boolean;
  page: number;
  rect: [number, number, number, number] | null;
}

/** Parse single-token `@handle` mentions from a comment body (GitHub/Slack style —
 *  no internal spaces, since multi-word names are ambiguous in free text). Trailing
 *  punctuation is trimmed; de-duplicated. The UI resolves handles to peers. */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/@([A-Za-z0-9._-]+)/g)) {
    const name = m[1].replace(/[.,;:!?]+$/, '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function toData(m: Y.Map<unknown>): CommentData {
  const rect = m.get('rect') as [number, number, number, number] | null | undefined;
  return {
    id: String(m.get('id')),
    threadId: String(m.get('threadId')),
    page: Number(m.get('page') ?? 0),
    rect: rect ?? null,
    author: String(m.get('author') ?? 'anonymous'),
    body: String(m.get('body') ?? ''),
    createdAt: Number(m.get('createdAt') ?? 0),
    resolved: Boolean(m.get('resolved')),
    mentions: (m.get('mentions') as string[] | undefined) ?? [],
  };
}

function indexOfId(model: CasualPdfDoc, id: string): number {
  for (let i = 0; i < model.comments.length; i++) {
    if (model.comments.get(i).get('id') === id) return i;
  }
  return -1;
}

function findById(model: CasualPdfDoc, id: string): Y.Map<unknown> | null {
  const i = indexOfId(model, id);
  return i >= 0 ? model.comments.get(i) : null;
}

/** Input for a new top-level comment (a fresh thread). */
export interface NewComment {
  id: string;
  page: number;
  rect: [number, number, number, number] | null;
  author: string;
  body: string;
  createdAt: number;
}

/** Start a new thread. Returns the thread/root id. */
export function addComment(model: CasualPdfDoc, c: NewComment): string {
  const entry = new Y.Map<unknown>();
  const fields: CommentData = {
    id: c.id,
    threadId: c.id,
    page: c.page,
    rect: c.rect,
    author: c.author,
    body: c.body,
    createdAt: c.createdAt,
    resolved: false,
    mentions: extractMentions(c.body),
  };
  model.doc.transact(() => {
    // Yjs Y.Map.set rejects `null`/`undefined` ("Unexpected content type"); skip
    // them — toData() reads a missing key back as null.
    for (const [k, v] of Object.entries(fields)) if (v != null) entry.set(k, v);
    model.comments.push([entry]);
  });
  return c.id;
}

/** Input for a reply on an existing thread. */
export interface NewReply {
  id: string;
  author: string;
  body: string;
  createdAt: number;
}

/** Reply to a thread. No-op (returns null) if the thread root is gone. */
export function addReply(model: CasualPdfDoc, threadId: string, r: NewReply): string | null {
  const root = findById(model, threadId);
  if (!root) return null;
  const page = Number(root.get('page') ?? 0);
  const entry = new Y.Map<unknown>();
  const fields: CommentData = {
    id: r.id,
    threadId,
    page,
    rect: null,
    author: r.author,
    body: r.body,
    createdAt: r.createdAt,
    resolved: false,
    mentions: extractMentions(r.body),
  };
  model.doc.transact(() => {
    // Yjs Y.Map.set rejects `null`/`undefined` ("Unexpected content type"); skip
    // them — toData() reads a missing key back as null.
    for (const [k, v] of Object.entries(fields)) if (v != null) entry.set(k, v);
    model.comments.push([entry]);
  });
  return r.id;
}

/** Resolve or reopen a thread (sets the flag on the root). */
export function setResolved(model: CasualPdfDoc, threadId: string, resolved: boolean): void {
  const root = findById(model, threadId);
  if (root) model.doc.transact(() => root.set('resolved', resolved));
}

/** Delete a single comment. Deleting a thread root removes the whole thread
 *  (root + all replies). Removes every entry with the id (dup-safe). */
export function deleteComment(model: CasualPdfDoc, id: string): void {
  const target = findById(model, id);
  if (!target) return;
  const isRoot = target.get('id') === target.get('threadId');
  model.doc.transact(() => {
    // Iterate from the end so index-based deletes don't shift under us.
    for (let i = model.comments.length - 1; i >= 0; i--) {
      const m = model.comments.get(i);
      if (m.get('id') === id || (isRoot && m.get('threadId') === id)) model.comments.delete(i, 1);
    }
  });
}

/** Read all threads, roots sorted by creation time, replies chronological.
 *  Orphan replies (root deleted) are dropped. */
export function readThreads(model: CasualPdfDoc): CommentThread[] {
  const roots = new Map<string, CommentData>();
  const replies = new Map<string, CommentData[]>();
  for (const m of model.comments.toArray()) {
    const c = toData(m);
    if (c.id === c.threadId) roots.set(c.threadId, c);
    else (replies.get(c.threadId) ?? replies.set(c.threadId, []).get(c.threadId)!).push(c);
  }
  const threads: CommentThread[] = [];
  for (const [tid, root] of roots) {
    const rs = (replies.get(tid) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    threads.push({ root, replies: rs, resolved: root.resolved, page: root.page, rect: root.rect });
  }
  return threads.sort((a, b) => a.root.createdAt - b.root.createdAt);
}
