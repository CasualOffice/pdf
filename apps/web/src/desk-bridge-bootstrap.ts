// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * deskApp host bridge — Casual PDF edition.
 *
 * Desktop mode is opt-in and default-OFF: it activates only when the page is
 * loaded with `?desk=1`, which the Casual Office Tauri shell appends when it
 * spawns the PDF window (mounted at `/pdf/index.html?desk=1&file=<path>&theme=…`).
 * In a plain browser the flag is absent, `isDesktop()` is false, and this module
 * is a no-op — so it never changes the web build's behavior.
 *
 * When active, it defines `window.__deskApp__`, wiring native file I/O to the
 * shell's Tauri commands (top-level Tauri-window mode: `withGlobalTauri: true`,
 * so `window.__TAURI__.core.invoke` is called directly — no postMessage hop).
 * This mirrors services/desktop's docx + sheets bridges, using the same
 * commands: document_size / read_document_chunk (chunked load), begin/write/
 * commit_save_document (atomic chunked save), pick_save_path / pick_open_document,
 * set_window_dirty, {write,read,clear}_recovery, open_document_window.
 *
 * Save semantics (desktop spec): Save writes back to the bound path with no
 * prompt; Save on an untitled doc, or Save As, prompts once via pick_save_path
 * then binds the chosen path. Never a browser `<a download>` — the app routes
 * its Save / export flows through this bridge on desktop.
 */

/** True only inside the Casual Office desktop shell (signalled by `?desk=1`). */
export function isDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URL(window.location.href).searchParams.get('desk') === '1';
  } catch {
    return false;
  }
}

/** The bridge surface the app consumes on desktop. */
export interface DeskApp {
  readonly isDesktop: true;
  /** Absolute path this window is bound to (null until a Save As binds one). */
  filePath: string | null;
  /** Read the bound (or given) file into bytes via chunked native reads. */
  loadDocument(path?: string): Promise<ArrayBuffer>;
  /** Write bytes back to the bound path (atomic). Untitled → falls back to saveAs. */
  save(bytes: ArrayBuffer, baselineSeq?: number): Promise<string | null>;
  /** Prompt for a path, write there, and bind it. Returns null if cancelled. */
  saveAs(suggestedName: string, bytes: ArrayBuffer, baselineSeq?: number): Promise<string | null>;
  /** Native open dialog → spawn a new document window for the picked file. */
  openFile(): Promise<void>;
  /** Signal unsaved state to the shell (drives the close-guard prompt). */
  setDirty(dirty: boolean): void;
  /** Monotonic edit counter, so an in-flight save can detect a mid-write edit. */
  currentEditSeq(): number;
  /** Raw launcher preference and the resolved light/dark value. */
  themeMode: 'system' | 'light' | 'dark';
  theme: 'light' | 'dark';
  /** Hide any boot splash once the document is ready (no-op if none). */
  dismissBoot(): void;
  /** Crash-recovery sidecar (native), parallel to the web IndexedDB snapshot. */
  writeRecovery(bytes: ArrayBuffer): Promise<void>;
  readRecovery(): Promise<ArrayBuffer | null>;
  clearRecovery(): Promise<void>;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
interface TauriGlobal {
  core?: { invoke?: Invoke };
  window?: {
    getCurrentWindow?: () => {
      setTitle?: (t: string) => Promise<void>;
      show?: () => Promise<void>;
      onDragDropEvent?: (cb: (e: { payload: { type: string; paths?: string[] } }) => void) => Promise<() => void>;
    };
  };
  event?: { listen?: (name: string, cb: (e: { payload?: unknown }) => void) => Promise<() => void> };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
    __deskApp__?: DeskApp;
  }
}

// ── Bridge construction (only runs inside the desktop shell) ─────────────────
(function installDeskBridge() {
  if (!isDesktop() || typeof window === 'undefined') return;
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) {
    // In a top-level Tauri window this should exist (withGlobalTauri: true). If
    // it doesn't, leave the app in its normal (web) code paths rather than crash.
    return;
  }
  const inv: Invoke = (cmd, args) => invoke(cmd, args);

  const url = new URL(window.location.href);
  let filePath: string | null = url.searchParams.get('file');

  // Normalize whatever `invoke` hands back for a Vec<u8> — Tauri v2 may surface
  // it as an ArrayBuffer, a Uint8Array (respect byteOffset), or a plain number[].
  const asArrayBuffer = (raw: unknown): ArrayBuffer => {
    if (raw instanceof ArrayBuffer) return raw;
    if (raw instanceof Uint8Array) {
      return raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
        ? (raw.buffer as ArrayBuffer)
        : (raw.slice().buffer as ArrayBuffer);
    }
    return new Uint8Array((raw as number[]) ?? []).buffer;
  };

  const CHUNK = 1 << 20; // 1 MiB

  async function chunkedRead(path: string): Promise<ArrayBuffer> {
    const total = Number(await inv('document_size', { path }));
    const out = new Uint8Array(total);
    let offset = 0;
    while (offset < total) {
      const length = Math.min(CHUNK, total - offset);
      const chunk = new Uint8Array(asArrayBuffer(await inv('read_document_chunk', { path, offset, length })));
      if (chunk.byteLength === 0) break;
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset < total) throw new Error(`Only read ${offset} of ${total} bytes from ${path}`);
    return out.buffer;
  }

  async function chunkedWrite(path: string, buf: ArrayBuffer): Promise<void> {
    if (buf.byteLength === 0) throw new Error(`refusing to write an empty PDF to ${path}`);
    await inv('begin_save_document', { path });
    const view = new Uint8Array(buf);
    for (let offset = 0; offset < view.byteLength; offset += CHUNK) {
      const slice = view.subarray(offset, Math.min(offset + CHUNK, view.byteLength));
      await inv('write_save_chunk', { path, offset, bytes: Array.from(slice) });
    }
    await inv('commit_save_document', { path });
  }

  // Serialize writes so overlapping ⌘S can't corrupt the shared temp file.
  let writeChain: Promise<unknown> = Promise.resolve();
  function serializedWrite(path: string, buf: ArrayBuffer): Promise<void> {
    const run = writeChain.then(() => chunkedWrite(path, buf));
    writeChain = run.catch(() => undefined);
    return run;
  }

  // Dirty flag — fire the IPC transition once, never spam it. editSeq bumps on
  // every truthy signal so an in-flight save can tell if an edit landed mid-write.
  let isDirty = false;
  let editSeq = 0;
  function setWindowDirty(dirty: boolean) {
    if (dirty === isDirty) return;
    isDirty = dirty;
    try {
      void inv('set_window_dirty', { dirty }).catch(() => undefined);
    } catch {
      /* best-effort */
    }
  }

  function basename(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] || p;
  }
  async function setWindowTitle(path: string) {
    try {
      await tauri?.window?.getCurrentWindow?.().setTitle?.(`PDF — ${basename(path)}`);
    } catch {
      /* non-fatal */
    }
  }

  const bridge: DeskApp = {
    isDesktop: true,
    get filePath() {
      return filePath;
    },
    set filePath(v: string | null) {
      filePath = v;
    },

    async loadDocument(path?: string): Promise<ArrayBuffer> {
      const p = path ?? filePath;
      if (!p) throw new Error('no file path bound to this window');
      return chunkedRead(p);
    },

    async save(bytes: ArrayBuffer, baselineSeq?: number): Promise<string | null> {
      if (!filePath) return bridge.saveAs('Untitled.pdf', bytes, baselineSeq);
      const seqAtStart = baselineSeq ?? editSeq;
      await serializedWrite(filePath, bytes);
      if (editSeq === seqAtStart) setWindowDirty(false);
      return filePath;
    },

    async saveAs(suggestedName: string, bytes: ArrayBuffer, baselineSeq?: number): Promise<string | null> {
      const newPath = (await inv('pick_save_path', { suggestedName })) as string | null;
      if (!newPath) return null; // user cancelled
      const seqAtStart = baselineSeq ?? editSeq;
      await serializedWrite(newPath, bytes);
      try {
        await inv('add_recent_file', { path: newPath });
      } catch {
        /* best-effort */
      }
      filePath = newPath; // bind only after a successful write
      if (editSeq === seqAtStart) setWindowDirty(false);
      void setWindowTitle(newPath);
      return newPath;
    },

    async openFile(): Promise<void> {
      const path = (await inv('pick_open_document')) as string | null;
      if (!path) return;
      await inv('open_document_window', { kind: 'pdf', filePath: path });
    },

    setDirty(dirty: boolean): void {
      if (dirty) editSeq++;
      setWindowDirty(dirty);
    },
    currentEditSeq(): number {
      return editSeq;
    },

    themeMode: 'system',
    theme: 'light',

    dismissBoot(): void {
      const boot = document.getElementById('boot');
      if (boot) boot.remove();
    },

    async writeRecovery(bytes: ArrayBuffer): Promise<void> {
      if (!filePath) return;
      await inv('write_recovery', { path: filePath, bytes: Array.from(new Uint8Array(bytes)) });
    },
    async readRecovery(): Promise<ArrayBuffer | null> {
      if (!filePath) return null;
      const raw = await inv('read_recovery', { path: filePath });
      return raw == null ? null : asArrayBuffer(raw);
    },
    async clearRecovery(): Promise<void> {
      if (!filePath) return;
      try {
        await inv('clear_recovery', { path: filePath });
      } catch {
        /* best-effort */
      }
    },
  };

  // ── Theme plumbing ─────────────────────────────────────────────────────────
  // Resolve 'system' the way the launcher does: dark unless the OS explicitly
  // prefers light. Publish `bridge.theme` and dispatch a `deskapp:theme` DOM
  // event the app listens to; re-resolve on OS scheme change and on the shell's
  // authoritative `deskapp://theme` Tauri event.
  const prefersLight = () =>
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
  const resolve = (mode: 'system' | 'light' | 'dark'): 'light' | 'dark' =>
    mode === 'system' ? (prefersLight() ? 'light' : 'dark') : mode;

  const initialMode = url.searchParams.get('theme') as 'system' | 'light' | 'dark' | null;
  bridge.themeMode = initialMode && ['system', 'light', 'dark'].includes(initialMode) ? initialMode : 'system';
  function reapplyTheme() {
    const resolved = resolve(bridge.themeMode);
    bridge.theme = resolved;
    try {
      window.dispatchEvent(new CustomEvent('deskapp:theme', { detail: { mode: bridge.themeMode, resolved } }));
    } catch {
      /* ignore */
    }
  }
  reapplyTheme();
  if (typeof window.matchMedia === 'function') {
    try {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (bridge.themeMode === 'system') reapplyTheme();
      });
    } catch {
      /* Safari <14 lacks addEventListener on MediaQueryList */
    }
  }

  window.__deskApp__ = bridge;

  // ── Tauri event wiring (best-effort; listeners are async) ────────────────────
  const listen = tauri.event?.listen;
  if (listen) {
    void listen('deskapp://theme', (e) => {
      const next = (e.payload as { theme?: 'system' | 'light' | 'dark' } | undefined)?.theme;
      if (next) {
        bridge.themeMode = next;
        reapplyTheme();
      }
    });
    // Re-broadcast external file changes as a DOM event the app can react to.
    void listen('deskapp://file-changed', (e) => {
      const detail = (e.payload as { kind?: string; path?: string } | undefined) ?? {};
      try {
        window.dispatchEvent(new CustomEvent('deskapp:file-changed', { detail }));
      } catch {
        /* ignore */
      }
    });
  }

  // Native drag-drop of files onto the window → open each as its own doc window.
  try {
    void tauri.window?.getCurrentWindow?.().onDragDropEvent?.((e) => {
      if (e.payload.type !== 'drop') return;
      for (const p of e.payload.paths ?? []) {
        void inv('open_document_window', { kind: 'pdf', filePath: p });
      }
    });
  } catch {
    /* drag-drop is optional */
  }
})();
