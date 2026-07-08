// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the form co-editing binding (form-binding.ts): two Yjs docs
// through a simulated relay + a fake form plugin each, asserting field values
// sync peer→peer and don't echo into a loop. Deterministic, no browser.
//
//   node --experimental-transform-types --test tools/render-parity/verify-form-binding.test.ts
//
import test from 'node:test';
import assert from 'node:assert/strict';
import { Y } from '../../packages/pdf-sdk/src/collab-binding.ts';
import { createCasualPdfDoc } from '../../packages/pdf-sdk/src/model.ts';
import { bindFormValues, type FormBridge } from '../../packages/pdf-sdk/src/form-binding.ts';

/** In-memory stand-in for the EmbedPDF form plugin. `setValues` (a remote apply)
 *  emits a change event just like the real plugin, so the echo guard is exercised. */
class FakeFormBridge implements FormBridge {
  values: Record<string, string> = {};
  applyCount = 0;
  private listeners: (() => void)[] = [];
  onFieldValueChange(cb: () => void) {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
  }
  getValues() { return { ...this.values }; }
  setValues(v: Record<string, string>) {
    this.applyCount++;
    this.values = { ...v };
    this.emit();
  }
  /** Simulate a local user filling a field (mutates + emits, as the plugin does). */
  userFill(name: string, value: string) {
    this.values[name] = value;
    this.emit();
  }
  private emit() { for (const l of [...this.listeners]) l(); }
}

function relay(a: Y.Doc, b: Y.Doc) {
  a.on('update', (u: Uint8Array, o: unknown) => { if (o !== 'remote') Y.applyUpdate(b, u, 'remote'); });
  b.on('update', (u: Uint8Array, o: unknown) => { if (o !== 'remote') Y.applyUpdate(a, u, 'remote'); });
}

function setup() {
  const a = createCasualPdfDoc('v1', new Y.Doc());
  const b = createCasualPdfDoc('v1', new Y.Doc());
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
  relay(a.doc, b.doc);
  const fa = new FakeFormBridge();
  const fb = new FakeFormBridge();
  const offA = bindFormValues(fa, a);
  const offB = bindFormValues(fb, b);
  return { a, b, fa, fb, teardown: () => { offA(); offB(); } };
}

test('a field filled on A syncs to B (model + plugin)', () => {
  const { a, b, fa, fb, teardown } = setup();
  fa.userFill('fullName', 'Ada Lovelace');
  assert.equal(a.formValues.get('fullName'), 'Ada Lovelace', 'written to A model');
  assert.equal(b.formValues.get('fullName'), 'Ada Lovelace', 'synced into B model');
  assert.equal(fb.values.fullName, 'Ada Lovelace', 'applied to B plugin');
  assert.equal(fa.applyCount, 0, 'the originator never re-applies its own edit');
  teardown();
});

test('concurrent fills of different fields converge on both peers', () => {
  const { fa, fb, teardown } = setup();
  fa.userFill('name', 'Ada');
  fb.userFill('email', 'ada@x.com');
  assert.deepEqual(fa.values, { name: 'Ada', email: 'ada@x.com' }, 'A has both fields');
  assert.deepEqual(fb.values, { name: 'Ada', email: 'ada@x.com' }, 'B has both fields');
  teardown();
});

test('no echo loop: applying a remote value does not bounce back', () => {
  const { fb, teardown } = setup();
  fb.userFill('city', 'Paris'); // originates on B → syncs to A → A applies once
  // The value settles; a second identical fill is a no-op (content-equality guard).
  const applyBefore = fb.applyCount;
  fb.userFill('city', 'Paris');
  assert.equal(fb.applyCount, applyBefore, 'an unchanged value causes no re-apply (no loop)');
  teardown();
});

test('a later edit overwrites an earlier one (last write wins per field)', () => {
  const { a, b, fa, fb, teardown } = setup();
  fa.userFill('status', 'draft');
  assert.equal(fb.values.status, 'draft');
  fb.userFill('status', 'final');
  assert.equal(fa.values.status, 'final', 'B’s later edit reaches A');
  assert.equal(a.formValues.get('status'), 'final');
  teardown();
});

test('a remote edit to one field does NOT clobber an in-progress local edit to another', () => {
  const { fa, fb, teardown } = setup();
  // B has an in-progress edit to 'notes' that hasn't been flushed to the model yet.
  fb.values.notes = 'draft in progress';
  // A edits a DIFFERENT field → syncs to B.
  fa.userFill('name', 'Ada');
  assert.equal(fb.values.name, 'Ada', 'the remotely-changed field is applied');
  assert.equal(fb.values.notes, 'draft in progress', 'the in-progress local field is PRESERVED (not clobbered)');
  teardown();
});
