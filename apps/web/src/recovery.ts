// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Crash-recovery persistence (gate UX-I5) for the web surface.
 *
 * The architecture makes the host own file I/O: desktop uses the Tauri atomic
 * sidecar, web persists locally. This is the web half — a single-slot IndexedDB
 * snapshot of the *edited* PDF bytes (annotations/signatures already baked via
 * the export plugin), so a tab crash or accidental close can be recovered even
 * for picker-opened files whose object URLs don't survive a reload.
 *
 * It is deliberately a full-bytes snapshot rather than an overlay diff: it
 * captures everything (including image stamps a JSON overlay can't reconstruct)
 * and restores by simply reopening the bytes. When the Yjs overlay model lands
 * (Phase 3) recovery can ride on y-indexeddb instead; until then this is the
 * robust, self-contained solution.
 */

const DB_NAME = 'casual-pdf';
const STORE = 'recovery';
const SLOT = 'latest';

export interface RecoverySnapshot {
  /** Document title at snapshot time (for the recovery prompt). */
  title: string;
  /** Edited PDF bytes (base + baked overlay). */
  bytes: ArrayBuffer;
  /** Epoch ms the snapshot was taken. */
  savedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const store = db.transaction(STORE, mode).objectStore(STORE);
      const req = run(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Write (overwrite) the recovery snapshot. Best-effort: storage errors (quota,
 *  private mode) are swallowed so autosave never disrupts editing. */
export async function saveSnapshot(snap: RecoverySnapshot): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(snap, SLOT));
  } catch {
    /* storage unavailable — recovery is best-effort */
  }
}

/** Read the recovery snapshot, or null if none / storage unavailable. */
export async function loadSnapshot(): Promise<RecoverySnapshot | null> {
  try {
    const snap = await tx<RecoverySnapshot | undefined>('readonly', (s) => s.get(SLOT));
    return snap && snap.bytes && snap.bytes.byteLength > 0 ? snap : null;
  } catch {
    return null;
  }
}

/** Drop the recovery snapshot (after a clean Download, or an explicit discard). */
export async function clearSnapshot(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(SLOT));
  } catch {
    /* ignore */
  }
}

/** "3 minutes ago" / "just now" — for the recovery prompt. */
export function relativeTime(savedAt: number, now: number): string {
  const secs = Math.max(0, Math.round((now - savedAt) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
