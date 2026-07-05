// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Transport abstraction for Casual PDF's DocOps LLM calls.
 *
 * There are exactly TWO runtime modes, and the PROVIDER/MODEL choice lives
 * OUTSIDE this repo (docs/AI.md §2):
 *
 *  - **Desktop mode** — `DesktopTransport` → the Tauri `docops_llm_call` command.
 *    The desktop shell owns which local model (llama.cpp) runs and its settings
 *    (download / load / GPU); it can also proxy to a cloud provider. The webview
 *    never sees a key. To use a local model or Ollama, configure it in the
 *    desktop app — not here.
 *  - **Collab mode** — `CollabTransport` → the collab `/api/ai` WebSocket. The
 *    server holds the LLM tool loop and picks the provider from its ENV
 *    (`LLM_ENDPOINT` / `LLM_API_KEY` — Anthropic, Ollama, OpenAI, …). The client
 *    just connects; there is no client-side provider config.
 *
 * Both drive the full multi-round tool loop internally (`drivesLoop === true`);
 * the client executes each tool via `toolExecutor` (the PdfOpsBridge).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type ToolExecutor = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LlmCallPayload {
  model: string;
  system: string;
  messages: any;
  tools: any;
  max_tokens: number;
  /** Only used by collab when the server has no server-side key. */
  apiKey?: string;
  /** Executes a tool on behalf of a loop-driving transport, returns its result. */
  toolExecutor?: ToolExecutor;
  /** Called for each text block streamed by the transport. */
  onText?: (text: string) => void;
  /** Abort signal — closes the WS / stops the loop. */
  signal?: AbortSignal;
  /** Max tool-call rounds before the loop stops. Defaults to 12. */
  maxToolRounds?: number;
}

export interface LlmCallResult {
  data: any;
  status: number;
  /** Full conversation history after all tool rounds. */
  updatedHistory?: any[];
  /** True when the loop stopped at the maxToolRounds cap. */
  capHit?: boolean;
}

export interface DocOpsTransport {
  call(payload: LlmCallPayload): Promise<LlmCallResult>;
  /** True when the transport drives the full multi-round loop internally. */
  readonly drivesLoop: boolean;
  /** Human label for status display (e.g. "Local (desktop)", "Collab server"). */
  readonly label: string;
  /** Whether this transport can actually run here (desktop shell present / collab
   *  URL configured). Lets the UI show an honest "AI unavailable" state instead of
   *  advertising a backend that will error on first use. */
  available(): boolean;
}

const abortError = () => Object.assign(new Error('AbortError'), { name: 'AbortError' });

/** The Tauri `invoke`, resolved from either global the shell may expose:
 *  `__TAURI_INTERNALS__.invoke`, or (with `withGlobalTauri`) `__TAURI__.core.invoke`
 *  — the casual_pdf desktop window uses the latter. `null` outside the shell. */
type TauriInvoke = (cmd: string, args?: unknown) => Promise<unknown>;
export function resolveTauriInvoke(): TauriInvoke | null {
  if (typeof window === 'undefined') return null;
  const w = window as {
    __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
    __TAURI__?: { core?: { invoke?: TauriInvoke } };
  };
  const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
  return typeof invoke === 'function' ? (cmd, args) => invoke(cmd, args) : null;
}

/** Derive the AI WebSocket URL from a Yjs collab URL (`/yjs` → `/api/ai`).
 *  Strips trailing slashes first so `…/yjs/` is handled as well as `…/yjs`. */
export function deriveAiWsUrl(yjsUrl: string): string {
  return yjsUrl.replace(/\/+$/, '').replace(/\/yjs$/, '') + '/api/ai';
}

// ── CollabTransport (server holds the loop; provider = server env) ────────────

export class CollabTransport implements DocOpsTransport {
  readonly drivesLoop = true;
  readonly label = 'Collab server';

  constructor(
    private readonly aiWsUrl: string,
    private readonly room?: string,
    /** Inactivity timeout (ms): reject if no frame arrives for this long. Reset
     *  on every frame, so streamed tokens keep it alive — only a stalled server
     *  trips it (otherwise "Thinking…" would spin forever). */
    private readonly idleMs = 90_000,
  ) {}

  available(): boolean {
    return !!this.aiWsUrl;
  }

  call(payload: LlmCallPayload): Promise<LlmCallResult> {
    return new Promise((resolve, reject) => {
      if (payload.signal?.aborted) {
        reject(abortError());
        return;
      }
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.aiWsUrl);
      } catch (err) {
        reject(new Error(`Failed to open AI WebSocket: ${String(err)}`));
        return;
      }
      let settled = false;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const settle = (v: LlmCallResult | null, err?: Error) => {
        if (settled) return;
        settled = true;
        if (idle) clearTimeout(idle);
        payload.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(v!);
      };
      // Reset the inactivity watchdog on any activity; trip only when the server
      // goes silent for `idleMs` (so the UI can show an error instead of hanging).
      const bumpIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          try {
            ws.close(1000, 'timeout');
          } catch {
            /* ignore */
          }
          settle(null, new Error('AI request timed out — no response from the server.'));
        }, this.idleMs);
      };
      const onAbort = () => {
        try {
          ws.close(1000, 'aborted');
        } catch {
          /* ignore */
        }
        settle(null, abortError());
      };
      payload.signal?.addEventListener('abort', onAbort);

      ws.addEventListener('open', () => {
        bumpIdle();
        ws.send(
          JSON.stringify({
            type: 'chat',
            model: payload.model,
            max_tokens: payload.max_tokens,
            system: payload.system,
            messages: payload.messages,
            tools: payload.tools,
            ...(payload.apiKey ? { apiKey: payload.apiKey } : {}),
            ...(this.room ? { roomName: this.room } : {}),
            ...(payload.maxToolRounds != null ? { maxToolRounds: payload.maxToolRounds } : {}),
          }),
        );
      });

      ws.addEventListener('message', ({ data }: MessageEvent<string>) => {
        bumpIdle();
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data) as Record<string, unknown>;
        } catch {
          settle(null, new Error('AI WS: received non-JSON frame'));
          ws.close();
          return;
        }
        if (msg.type === 'text') {
          payload.onText?.(msg.text as string);
        } else if (msg.type === 'tool_call') {
          const id = msg.id as string;
          const toolName = msg.toolName as string;
          const args = (msg.args ?? {}) as Record<string, unknown>;
          if (!payload.toolExecutor) {
            ws.send(JSON.stringify({ type: 'tool_result', id, error: 'no toolExecutor configured' }));
            return;
          }
          payload
            .toolExecutor(toolName, args)
            .then((result) => ws.send(JSON.stringify({ type: 'tool_result', id, result })))
            .catch((err) =>
              ws.send(
                JSON.stringify({ type: 'tool_result', id, error: err instanceof Error ? err.message : String(err) }),
              ),
            );
        } else if (msg.type === 'done') {
          settle({ data: { ok: true }, status: 200, updatedHistory: msg.history as any[], capHit: msg.capHit === true });
        } else if (msg.type === 'error') {
          settle({ data: { error: { message: msg.message as string } }, status: 500 });
        }
      });

      ws.addEventListener('error', () => settle(null, new Error('AI WebSocket connection failed')));
      ws.addEventListener('close', ({ code, reason }: CloseEvent) => {
        if (!settled) {
          if (code === 1000 || reason === 'aborted') return;
          settle(null, new Error(`AI WebSocket closed unexpectedly (${code})`));
        }
      });
    });
  }
}

// ── DesktopTransport (native worker / native HTTP proxy; shell owns settings) ──

export class DesktopTransport implements DocOpsTransport {
  readonly drivesLoop = true;
  readonly label = 'Local (desktop)';

  available(): boolean {
    return resolveTauriInvoke() !== null;
  }

  call(payload: LlmCallPayload): Promise<LlmCallResult> {
    if (payload.signal?.aborted) return Promise.reject(abortError());
    const invoke = resolveTauriInvoke();
    if (!invoke) {
      // Not in the desktop shell → no local worker. The web build must use
      // collab mode instead; surface a clear message rather than silently failing.
      return Promise.resolve({
        data: { error: { message: 'The local AI model runs in the Casual Office desktop app. On the web, connect a collab server.' } },
        status: 400,
      });
    }
    return this.runLoop(payload, invoke);
  }

  private async runLoop(
    payload: LlmCallPayload,
    invoke: (cmd: string, args?: unknown) => Promise<unknown>,
  ): Promise<LlmCallResult> {
    const maxRounds = payload.maxToolRounds ?? 24;
    const messages: any[] = [...payload.messages];
    for (let round = 0; round < maxRounds; round++) {
      if (payload.signal?.aborted) throw abortError();
      let data: any;
      try {
        // Rust command takes a single `args` struct → the payload MUST be wrapped.
        data = await invoke('docops_llm_call', {
          args: {
            model: payload.model,
            system: payload.system,
            messages,
            tools: payload.tools,
            maxTokens: payload.max_tokens,
            apiKey: payload.apiKey ?? '',
          },
        });
      } catch (err) {
        return { data: { error: { message: String(err) } }, status: 500 };
      }
      if (Array.isArray(data?.content)) {
        for (const block of data.content) {
          if (block?.type === 'text' && typeof block.text === 'string') payload.onText?.(block.text);
        }
      }
      messages.push({ role: 'assistant', content: data?.content ?? [] });
      const toolUseBlocks: any[] = Array.isArray(data?.content)
        ? data.content.filter((b: any) => b?.type === 'tool_use')
        : [];
      if (toolUseBlocks.length === 0 || data?.stop_reason === 'end_turn') break;
      if (!payload.toolExecutor) break;
      const toolResults: any[] = [];
      for (const block of toolUseBlocks) {
        try {
          const result = await payload.toolExecutor(block.name as string, (block.input ?? {}) as Record<string, unknown>);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id as string, content: JSON.stringify(result) });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id as string,
            content: err instanceof Error ? err.message : String(err),
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      if (round === maxRounds - 1) return { data: { ok: true }, status: 200, updatedHistory: messages, capHit: true };
    }
    return { data: { ok: true }, status: 200, updatedHistory: messages };
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Runtime mode. `auto` uses Desktop inside the shell, else Collab (when a collab
 * URL is provided). There is NO client-side provider/model config — that lives in
 * the desktop app (local model settings) or the collab server env.
 */
export type ProviderConfig =
  | { provider: 'auto'; collabWsUrl?: string; room?: string }
  | { provider: 'desktop' }
  | { provider: 'collab'; collabWsUrl: string; room?: string };

const isDesktopShell = () =>
  typeof window !== 'undefined' &&
  !!(window as { __deskApp__?: { isDesktop?: boolean } }).__deskApp__?.isDesktop;

/** Build the transport for the current mode. */
export function createDocOpsTransport(cfg: ProviderConfig = { provider: 'auto' }): DocOpsTransport {
  if (cfg.provider === 'desktop') return new DesktopTransport();
  if (cfg.provider === 'collab') return new CollabTransport(deriveAiWsUrl(cfg.collabWsUrl), cfg.room);
  // auto: desktop shell → local worker; otherwise collab if a URL is known.
  if (isDesktopShell()) return new DesktopTransport();
  if (cfg.collabWsUrl) return new CollabTransport(deriveAiWsUrl(cfg.collabWsUrl), cfg.room);
  // Web build with neither: DesktopTransport returns a clear "use desktop/collab" error.
  return new DesktopTransport();
}
