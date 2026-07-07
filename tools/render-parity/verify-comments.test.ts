// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the threaded-comments model (comments.ts) — thread lifecycle,
// replies, resolve/reopen, delete (single + root cascade), read/sort, @-mentions,
// and peer→peer sync through a simulated relay. Deterministic, no browser.
//
//   node --experimental-transform-types --test tools/render-parity/verify-comments.test.ts
//
import test from 'node:test';
import assert from 'node:assert/strict';
// Import Y from the SDK's re-export (not a bare 'yjs') so the test shares the
// SDK's single yjs instance — a second copy breaks Yjs constructor checks.
import { Y } from '../../packages/pdf-sdk/src/collab-binding.ts';
import { createCasualPdfDoc } from '../../packages/pdf-sdk/src/model.ts';
import { addComment, addReply, setResolved, deleteComment, readThreads, extractMentions } from '../../packages/pdf-sdk/src/comments.ts';

function make() {
  return createCasualPdfDoc('base-v1', new Y.Doc());
}
let n = 0;
const nextId = () => `c${++n}`;

test('addComment starts a thread; addReply threads under it (chronological)', () => {
  const m = make();
  const t = addComment(m, { id: 'root1', page: 0, rect: [10, 20, 100, 32], author: 'ada', body: 'Typo here?', createdAt: 1 });
  addReply(m, t, { id: 'r1', author: 'bob', body: 'Agreed', createdAt: 3 });
  addReply(m, t, { id: 'r2', author: 'ada', body: 'Fixing', createdAt: 2 });

  const threads = readThreads(m);
  assert.equal(threads.length, 1, 'one thread');
  assert.equal(threads[0].root.body, 'Typo here?');
  assert.equal(threads[0].page, 0);
  assert.deepEqual(threads[0].rect, [10, 20, 100, 32], 'anchor carried on the root');
  assert.deepEqual(threads[0].replies.map((r) => r.id), ['r2', 'r1'], 'replies sorted by createdAt');
});

test('resolve / reopen flips the thread flag', () => {
  const m = make();
  const t = addComment(m, { id: 'root1', page: 1, rect: null, author: 'ada', body: 'Check', createdAt: 1 });
  setResolved(m, t, true);
  assert.equal(readThreads(m)[0].resolved, true, 'resolved');
  setResolved(m, t, false);
  assert.equal(readThreads(m)[0].resolved, false, 'reopened');
});

test('deleting the root removes the whole thread; deleting a reply removes just it', () => {
  const m = make();
  const t = addComment(m, { id: 'root1', page: 0, rect: null, author: 'ada', body: 'Q', createdAt: 1 });
  addReply(m, t, { id: 'r1', author: 'bob', body: 'A1', createdAt: 2 });
  addReply(m, t, { id: 'r2', author: 'cara', body: 'A2', createdAt: 3 });

  deleteComment(m, 'r1');
  assert.deepEqual(readThreads(m)[0].replies.map((r) => r.id), ['r2'], 'reply deleted, others remain');

  deleteComment(m, 'root1');
  assert.equal(readThreads(m).length, 0, 'deleting the root removes root + remaining replies');
  assert.equal(m.comments.length, 0, 'no orphan entries left');
});

test('addReply to a missing thread is a no-op; orphan replies are dropped on read', () => {
  const m = make();
  assert.equal(addReply(m, 'nope', { id: 'x', author: 'a', body: 'b', createdAt: 1 }), null, 'no root → null');
  assert.equal(readThreads(m).length, 0);
});

test('threads sort by root createdAt', () => {
  const m = make();
  addComment(m, { id: 'a', page: 0, rect: null, author: 'x', body: 'second', createdAt: 5 });
  addComment(m, { id: 'b', page: 0, rect: null, author: 'x', body: 'first', createdAt: 2 });
  assert.deepEqual(readThreads(m).map((t) => t.root.body), ['first', 'second']);
});

test('extractMentions parses single-token @handles, de-duplicates, trims punctuation', () => {
  assert.deepEqual(extractMentions('hey @ada and @Bob, look'), ['ada', 'Bob']);
  assert.deepEqual(extractMentions('@ada @ada again'), ['ada']);
  assert.deepEqual(extractMentions('no mentions here'), []);
  // stored on the comment:
  const m = make();
  addComment(m, { id: 'r', page: 0, rect: null, author: 'x', body: 'ping @sam', createdAt: 1 });
  assert.deepEqual(readThreads(m)[0].root.mentions, ['sam']);
});

test('comments sync peer→peer over a shared Y.Doc (no plugin binding needed)', () => {
  const a = make();
  const b = createCasualPdfDoc('base-v1', new Y.Doc());
  // baseline + relay (both directions, origin-guarded), like Hocuspocus.
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
  a.doc.on('update', (u, o) => { if (o !== 'remote') Y.applyUpdate(b.doc, u, 'remote'); });
  b.doc.on('update', (u, o) => { if (o !== 'remote') Y.applyUpdate(a.doc, u, 'remote'); });

  const t = addComment(a, { id: 'root1', page: 2, rect: [1, 2, 3, 4], author: 'ada', body: 'Look here', createdAt: 1 });
  addReply(b, t, { id: 'r1', author: 'bob', body: 'On it @ada', createdAt: 2 });
  setResolved(a, t, true);

  for (const m of [a, b]) {
    const th = readThreads(m);
    assert.equal(th.length, 1, 'both converge to one thread');
    assert.equal(th[0].replies.length, 1, 'reply synced across');
    assert.equal(th[0].resolved, true, 'resolve synced across');
    assert.deepEqual(th[0].replies[0].mentions, ['ada'], 'reply mention synced');
  }
});

void nextId;
