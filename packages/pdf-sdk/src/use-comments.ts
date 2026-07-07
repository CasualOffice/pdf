// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * `useComments` — reactive threaded comments for one open document. Reads/writes
 * the Yjs overlay's `comments` array (comments.ts). When collab is on it uses the
 * SHARED model (so comments sync peer→peer); when off it uses a per-document local
 * model. Either way the UI just calls add/reply/resolve/remove and re-renders off
 * the observed thread list. Ids + timestamps are minted here (the model stays pure).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createCasualPdfDoc, type CasualPdfDoc } from './model';
import {
  addComment as modelAddComment,
  addReply as modelAddReply,
  setResolved,
  deleteComment,
  readThreads,
  type CommentThread,
} from './comments';

export interface CommentsState {
  threads: CommentThread[];
  /** Start a thread anchored to a page (0-based) + optional rect. */
  addComment(page: number, rect: [number, number, number, number] | null, body: string): void;
  addReply(threadId: string, body: string): void;
  resolve(threadId: string, resolved: boolean): void;
  remove(id: string): void;
}

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'c-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }
}

export function useComments(
  documentId: string,
  sharedModel: CasualPdfDoc | null,
  author: string,
): CommentsState {
  // A per-document local model for solo mode (recreated when the doc changes so
  // comments don't bleed across documents). Ignored when a shared model is present.
  const localRef = useRef<CasualPdfDoc | null>(null);
  const localIdRef = useRef<string>('');
  if (!sharedModel && (localRef.current === null || localIdRef.current !== documentId)) {
    localRef.current = createCasualPdfDoc(documentId);
    localIdRef.current = documentId;
  }
  const model = sharedModel ?? localRef.current!;

  const [threads, setThreads] = useState<CommentThread[]>([]);
  useEffect(() => {
    const refresh = () => setThreads(readThreads(model));
    model.comments.observeDeep(refresh);
    refresh();
    return () => model.comments.unobserveDeep(refresh);
  }, [model]);

  const addComment = useCallback(
    (page: number, rect: [number, number, number, number] | null, body: string) => {
      if (!body.trim()) return;
      modelAddComment(model, { id: uid(), page, rect, author, body: body.trim(), createdAt: Date.now() });
    },
    [model, author],
  );
  const addReply = useCallback(
    (threadId: string, body: string) => {
      if (!body.trim()) return;
      modelAddReply(model, threadId, { id: uid(), author, body: body.trim(), createdAt: Date.now() });
    },
    [model, author],
  );
  const resolve = useCallback((threadId: string, resolved: boolean) => setResolved(model, threadId, resolved), [model]);
  const remove = useCallback((id: string) => deleteComment(model, id), [model]);

  return { threads, addComment, addReply, resolve, remove };
}
