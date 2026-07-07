// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the collab annotation binding (collab-binding.ts): two Yjs docs
// wired through a simulated Hocuspocus relay + a fake annotation plugin each,
// asserting create/update/delete propagate peer→peer and don't echo into a loop.
// Deterministic, no browser.
//
//   node --experimental-transform-types --test tools/render-parity/verify-collab-binding.test.ts
//
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCasualPdfDoc } from '../../packages/pdf-sdk/src/model.ts';
import { bindAnnotations, annotationBridge, seedAnnotations, SUGGESTION_OPACITY, Y, type AnnotationBridge, type BridgeEvent, type RawAnnotation, type AnnotationCapabilityLike, type PluginAnnotationEvent } from '../../packages/pdf-sdk/src/collab-binding.ts';
import { readPeers, initials, type AwarenessUserState } from '../../packages/pdf-sdk/src/presence.ts';

/** In-memory stand-in for the EmbedPDF annotation plugin. `create/update/delete`
 *  mutate the store AND emit an event (as the real plugin does), so the binding's
 *  echo guard is genuinely exercised. `userCreate/userDelete` simulate a local
 *  user action in this client. */
class FakeBridge implements AnnotationBridge {
  store = new Map<string, { pageIndex: number; annotation: RawAnnotation }>();
  calls: [string, string][] = [];
  private listeners: ((ev: BridgeEvent) => void)[] = [];

  onAnnotationEvent(cb: (ev: BridgeEvent) => void): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
  }
  listAnnotations() { return [...this.store.values()]; }
  createAnnotation(pageIndex: number, annotation: RawAnnotation) {
    this.calls.push(['create', annotation.id]);
    this.store.set(annotation.id, { pageIndex, annotation });
    this.emit({ type: 'create', committed: true, pageIndex, annotation });
  }
  updateAnnotation(pageIndex: number, id: string, annotation: RawAnnotation) {
    this.calls.push(['update', id]);
    this.store.set(id, { pageIndex, annotation });
    this.emit({ type: 'update', committed: true, pageIndex, annotation });
  }
  deleteAnnotation(pageIndex: number, id: string) {
    this.calls.push(['delete', id]);
    this.store.delete(id);
    this.emit({ type: 'delete', committed: true, pageIndex, annotation: { id } });
  }
  // Simulated local user actions.
  userCreate(pageIndex: number, annotation: RawAnnotation) {
    this.store.set(annotation.id, { pageIndex, annotation });
    this.emit({ type: 'create', committed: true, pageIndex, annotation });
  }
  userDelete(pageIndex: number, id: string) {
    this.store.delete(id);
    this.emit({ type: 'delete', committed: true, pageIndex, annotation: { id } });
  }
  private emit(ev: BridgeEvent) { for (const l of [...this.listeners]) l(ev); }
}

/** Wire two docs' updates to each other like the Hocuspocus relay would (origin
 *  'remote' so it's never the binding's LOCAL_ORIGIN). */
function relay(a: Y.Doc, b: Y.Doc) {
  a.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return; // avoid ping-pong of the same update
    Y.applyUpdate(b, u, 'remote');
  });
  b.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return;
    Y.applyUpdate(a, u, 'remote');
  });
}

function setup() {
  const docA = createCasualPdfDoc('base-v1', new Y.Doc());
  const docB = createCasualPdfDoc('base-v1', new Y.Doc());
  // Simulate the Hocuspocus join handshake: a full-state sync both ways gives the
  // two docs a shared baseline, after which incremental updates apply cleanly.
  Y.applyUpdate(docB.doc, Y.encodeStateAsUpdate(docA.doc), 'remote');
  Y.applyUpdate(docA.doc, Y.encodeStateAsUpdate(docB.doc), 'remote');
  relay(docA.doc, docB.doc);
  const bridgeA = new FakeBridge();
  const bridgeB = new FakeBridge();
  const offA = bindAnnotations(bridgeA, docA, { author: 'alice' });
  const offB = bindAnnotations(bridgeB, docB, { author: 'bob' });
  return { docA, docB, bridgeA, bridgeB, teardown: () => { offA(); offB(); } };
}

const anno = (id: string): RawAnnotation => ({
  id,
  type: 'highlight',
  rect: { origin: { x: 10, y: 20 }, size: { width: 100, height: 12 } },
});

test('a local create propagates to the peer', () => {
  const { docA, docB, bridgeA, bridgeB, teardown } = setup();
  bridgeA.userCreate(0, anno('a1'));

  assert.equal(docA.annotations.length, 1, 'written to the local model');
  assert.equal(docB.annotations.length, 1, 'synced into the peer model');
  assert.ok(bridgeB.store.has('a1'), 'applied to the peer plugin');
  assert.deepEqual(bridgeB.calls, [['create', 'a1']], 'peer created it exactly once (no echo)');
  assert.deepEqual(bridgeA.calls, [], 'the originating client did not re-apply its own create');
  teardown();
});

test('a local delete propagates to the peer', () => {
  const { docA, docB, bridgeA, bridgeB, teardown } = setup();
  bridgeA.userCreate(0, anno('a1'));
  bridgeB.calls.length = 0; // ignore the create-sync
  bridgeA.userDelete(0, 'a1');

  assert.equal(docA.annotations.length, 0, 'removed from the local model');
  assert.equal(docB.annotations.length, 0, 'removed from the peer model');
  assert.ok(!bridgeB.store.has('a1'), 'removed from the peer plugin');
  assert.deepEqual(bridgeB.calls, [['delete', 'a1']], 'peer deleted it once');
  teardown();
});

test('no echo loop: peer applying a change does not re-broadcast it', () => {
  const { docA, docB, bridgeA, bridgeB, teardown } = setup();
  // Two creates from A; B applies both. If B echoed, counts would inflate.
  bridgeA.userCreate(0, anno('a1'));
  bridgeA.userCreate(1, anno('a2'));

  assert.equal(docA.annotations.length, 2);
  assert.equal(docB.annotations.length, 2, 'peer has exactly the two annotations, not duplicates');
  assert.equal(bridgeB.calls.filter((c) => c[0] === 'create').length, 2, 'peer created each once');
  teardown();
});

test('concurrent creates from both peers converge (both annotations on both)', () => {
  const { docA, docB, bridgeA, bridgeB, teardown } = setup();
  bridgeA.userCreate(0, anno('a1'));
  bridgeB.userCreate(0, anno('b1'));

  for (const d of [docA, docB]) {
    const ids = d.annotations.toArray().map((m) => m.get('id')).sort();
    assert.deepEqual(ids, ['a1', 'b1'], 'both docs converge to the union');
  }
  assert.ok(bridgeA.store.has('b1'), 'A received B’s annotation');
  assert.ok(bridgeB.store.has('a1'), 'B received A’s annotation');
  teardown();
});

test('annotationBridge adapts the EmbedPDF capability (mapping + doc filter)', () => {
  const calls: unknown[][] = [];
  let listener: ((ev: PluginAnnotationEvent) => void) | null = null;
  const cap: AnnotationCapabilityLike = {
    onAnnotationEvent(cb) { listener = cb; return () => { listener = null; }; },
    getAnnotations() { return [{ object: { id: 'x', pageIndex: 2, foo: 1 } }]; },
    createAnnotation(pageIndex, a) { calls.push(['create', pageIndex, a.id]); },
    updateAnnotations(patches) { calls.push(['update', patches[0].id]); },
    deleteAnnotations(anns) { calls.push(['delete', anns[0].id]); },
  };
  const bridge = annotationBridge(cap, 'doc-1');

  assert.deepEqual(
    bridge.listAnnotations(),
    [{ pageIndex: 2, annotation: { id: 'x', pageIndex: 2, foo: 1 } }],
    'listAnnotations lifts .object → {pageIndex, annotation}',
  );

  bridge.createAnnotation(0, { id: 'a' });
  bridge.updateAnnotation(1, 'a', { id: 'a' });
  bridge.deleteAnnotation(1, 'a');
  assert.deepEqual(calls, [['create', 0, 'a'], ['update', 'a'], ['delete', 'a']], 'create/update/delete delegate');

  const got: BridgeEvent[] = [];
  bridge.onAnnotationEvent((ev) => got.push(ev));
  listener!({ type: 'create', documentId: 'other', annotation: { id: 'z' }, pageIndex: 0, committed: true });
  listener!({ type: 'loaded', documentId: 'doc-1', total: 3 });
  listener!({ type: 'create', documentId: 'doc-1', annotation: { id: 'z' }, pageIndex: 0, committed: true });
  assert.deepEqual(got.map((e) => e.type), ['loaded', 'create'], 'events for other documents are dropped');
});

test('the raw annotation round-trips losslessly through the model', () => {
  const { bridgeB, bridgeA, teardown } = setup();
  const rich: RawAnnotation = {
    id: 'x1',
    type: 'ink',
    rect: { origin: { x: 1, y: 2 }, size: { width: 3, height: 4 } },
    inkList: [[{ x: 0, y: 0 }, { x: 5, y: 5 }]],
    color: '#ff0000',
    opacity: 0.7,
  };
  bridgeA.userCreate(2, rich);
  const got = bridgeB.store.get('x1');
  assert.ok(got, 'peer received it');
  assert.equal(got!.pageIndex, 2, 'page index preserved');
  assert.deepEqual(got!.annotation, rich, 'every field (inkList, color, opacity) preserved');
  teardown();
});

test('readPeers excludes self + nameless entries, sorted by clientId', () => {
  const states = new Map<number, AwarenessUserState>([
    [5, { user: { name: 'Eve' } }],
    [1, { user: { name: 'Alice', color: '#f00' } }],
    [2, {}],
    [3, { user: {} }],
    [9, { user: { name: 'Self' } }],
  ]);
  assert.deepEqual(readPeers(states, 9), [
    { clientId: 1, name: 'Alice', color: '#f00' },
    { clientId: 5, name: 'Eve', color: undefined },
  ]);
  assert.deepEqual(readPeers(new Map(), 1), [], 'empty room → no peers');
});

test('initials builds up to two uppercase letters', () => {
  assert.equal(initials('Ada Lovelace'), 'AL');
  assert.equal(initials('Grace'), 'GR');
  assert.equal(initials('a b c'), 'AC');
  assert.equal(initials('   '), '?');
});

import { roleToMode, allowedModes, clampMode } from '../../packages/pdf-sdk/src/modes.ts';

test('allowedModes + clampMode reflect the role ladder', () => {
  assert.deepEqual(allowedModes('viewer'), ['view']);
  assert.deepEqual(allowedModes('commenter'), ['view', 'suggest']);
  assert.deepEqual(allowedModes('editor'), ['view', 'suggest', 'edit']);
  assert.deepEqual(allowedModes('signer'), ['view', 'suggest', 'edit']);
  // clamp: a viewer asked to edit gets view; commenter asked to edit gets suggest.
  assert.equal(clampMode('edit', 'viewer'), 'view');
  assert.equal(clampMode('suggest', 'viewer'), 'view');
  assert.equal(clampMode('edit', 'commenter'), 'suggest');
  assert.equal(clampMode('suggest', 'commenter'), 'suggest');
  assert.equal(clampMode('edit', 'editor'), 'edit');
  // roleToMode is the highest allowed.
  assert.equal(roleToMode('viewer'), 'view');
  assert.equal(roleToMode('signer'), 'edit');
});

import { readSuggestions, acceptSuggestion, rejectSuggestion } from '../../packages/pdf-sdk/src/model.ts';

/** Like setup(), but bridgeA authors in Suggest mode (creates → 'suggested'). */
function setupSuggest() {
  const docA = createCasualPdfDoc('base-v1', new Y.Doc());
  const docB = createCasualPdfDoc('base-v1', new Y.Doc());
  Y.applyUpdate(docB.doc, Y.encodeStateAsUpdate(docA.doc), 'remote');
  Y.applyUpdate(docA.doc, Y.encodeStateAsUpdate(docB.doc), 'remote');
  relay(docA.doc, docB.doc);
  const bridgeA = new FakeBridge();
  const bridgeB = new FakeBridge();
  const offA = bindAnnotations(bridgeA, docA, { author: 'alice', getState: () => 'suggested' });
  const offB = bindAnnotations(bridgeB, docB, { author: 'bob' });
  return { docA, docB, bridgeA, bridgeB, teardown: () => { offA(); offB(); } };
}
const stateOf = (d: ReturnType<typeof createCasualPdfDoc>, id: string) =>
  d.annotations.toArray().find((m) => m.get('id') === id)?.get('state');

test('a Suggest-mode create is tagged suggested + the state syncs to the peer', () => {
  const { docA, docB, bridgeB, bridgeA, teardown } = setupSuggest();
  bridgeA.userCreate(0, anno('s1'));
  assert.equal(stateOf(docA, 's1'), 'suggested', 'author records it as a suggestion');
  assert.equal(stateOf(docB, 's1'), 'suggested', 'suggestion state syncs to the peer');
  assert.ok(bridgeB.store.has('s1'), 'still rendered on the peer plugin');
  assert.equal(readSuggestions(docA).length, 1, 'readSuggestions surfaces the pending one');
  teardown();
});

test('accepting a suggestion flips it to applied everywhere; annotation stays', () => {
  const { docA, docB, bridgeA, bridgeB, teardown } = setupSuggest();
  bridgeA.userCreate(0, anno('s1'));
  acceptSuggestion(docB, 's1', 'bob'); // reviewer on the peer accepts
  assert.equal(stateOf(docB, 's1'), 'applied');
  assert.equal(stateOf(docA, 's1'), 'applied', 'accept syncs back to the author');
  assert.ok(bridgeA.store.has('s1') && bridgeB.store.has('s1'), 'the annotation remains rendered');
  assert.equal(readSuggestions(docA).length, 0, 'no longer pending');
  teardown();
});

test('rejecting a suggestion removes it everywhere (model + both plugins)', () => {
  const { docA, docB, bridgeA, bridgeB, teardown } = setupSuggest();
  bridgeA.userCreate(0, anno('s1'));
  rejectSuggestion(docB, 's1'); // reviewer rejects
  assert.equal(docA.annotations.length, 0, 'gone from the author model');
  assert.equal(docB.annotations.length, 0, 'gone from the reviewer model');
  assert.ok(!bridgeA.store.has('s1'), 'removed from the author plugin');
  assert.ok(!bridgeB.store.has('s1'), 'removed from the reviewer plugin');
  teardown();
});

test('seedAnnotations publishes base annotations into an empty room + syncs, idempotently', () => {
  const { docA, docB, bridgeA, bridgeB, teardown } = setup();
  // A base annotation already loaded in A's plugin (from the PDF), not in the model.
  bridgeA.store.set('base1', { pageIndex: 0, annotation: anno('base1') });
  seedAnnotations(docA, bridgeA.listAnnotations(), 'alice');
  assert.equal(docA.annotations.length, 1, 'seeded into the model');
  assert.equal(docB.annotations.length, 1, 'synced to the peer');
  assert.ok(bridgeB.store.has('base1'), 'applied to the peer plugin');
  // Idempotent by id — a second seed adds nothing.
  seedAnnotations(docA, bridgeA.listAnnotations(), 'alice');
  assert.equal(docA.annotations.length, 1, 'seeding is idempotent (id already present)');
  teardown();
});

test('readPeers surfaces each peer active page when broadcast', () => {
  const states = new Map<number, AwarenessUserState>([
    [1, { user: { name: 'Alice' }, page: 5 }],
    [2, { user: { name: 'Bob' } }],
    [9, { user: { name: 'Self' }, page: 3 }],
  ]);
  const peers = readPeers(states, 9);
  assert.equal(peers.find((p) => p.name === 'Alice')?.page, 5, 'page read from awareness');
  assert.equal(peers.find((p) => p.name === 'Bob')?.page, undefined, 'no page → undefined');
});

test('a pending suggestion renders translucent on the peer; accepting restores opacity', () => {
  const { docB, bridgeA, bridgeB, teardown } = setupSuggest();
  bridgeA.userCreate(0, anno('s1'));
  assert.equal(
    (bridgeB.store.get('s1')?.annotation as { opacity?: number })?.opacity,
    SUGGESTION_OPACITY,
    'suggestion is translucent (display-only) on the peer',
  );
  acceptSuggestion(docB, 's1', 'bob');
  assert.equal(
    (bridgeB.store.get('s1')?.annotation as { opacity?: number })?.opacity,
    undefined,
    'accepted → full opacity restored',
  );
  teardown();
});
