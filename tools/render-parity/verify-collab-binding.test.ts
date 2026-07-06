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
import { bindAnnotations, annotationBridge, Y, type AnnotationBridge, type BridgeEvent, type RawAnnotation, type AnnotationCapabilityLike, type PluginAnnotationEvent } from '../../packages/pdf-sdk/src/collab-binding.ts';

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
