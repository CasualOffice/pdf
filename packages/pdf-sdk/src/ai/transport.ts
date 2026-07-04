// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Transport abstraction for Casual PDF's DocOps LLM calls.
 *
 * The AI is **provider-flexible by design** — a user can run it against the
 * Anthropic cloud, a local model (the desktop llama.cpp `ai-worker`, or any
 * OpenAI-compatible server such as Ollama / LM Studio / vLLM), or a
 * self-hosted collab server. Every transport speaks the same internal shape
 * (Anthropic-style `content` blocks: `text` / `tool_use` / `tool_result`), so
 * the panel + `PdfOpsBridge` never change when the provider does. See
 * `docs/AI.md` §2 (core architecture) / §7 (model strategy).
 *
 * Five concrete transports:
 *  - AnthropicTransport   — browser fetch to the Anthropic Messages API
 *                           (configurable base URL for a proxy). BYO key.
 *  - OpenAICompatTransport — browser fetch to any OpenAI-compatible
 *                           `/chat/completions` (Ollama default localhost:11434).
 *                           Translates Anthropic tool blocks ↔ OpenAI tool calls.
 *  - CollabTransport      — WebSocket to the collab `/api/ai`; the SERVER holds
 *                           the tool loop (provider is the server's env config).
 *  - DesktopTransport     — Tauri `docops_llm_call` → native llama.cpp worker
 *                           (offline) or native HTTP proxy. Key never in the webview.
 *
 * `drivesLoop === true` (Collab, Desktop): call() runs the full multi-round tool
 * conversation internally. The two browser transports return one round; the
 * panel loops externally for those.
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
  /** API key — required for the cloud/keyed transports; omitted for local. */
  apiKey?: string;
  /** Executes a tool on behalf of a loop-driving transport, returns its result. */
  toolExecutor?: ToolExecutor;
  /** Called for each text block streamed by the transport. */
  onText?: (text: string) => void;
  /** Abort signal — closes the WS / aborts the fetch. */
  signal?: AbortSignal;
  /** Max tool-call rounds before the loop stops. Defaults to 12. */
  maxToolRounds?: number;
}

export interface LlmCallResult {
  /** Raw LLM response (Anthropic `content`+`stop_reason` shape), or a synthetic
   *  `{ok:true}` for loop-driving transports. */
  data: any;
  /** HTTP/WS status code. */
  status: number;
  /** Full conversation history after all tool rounds (loop-driving transports). */
  updatedHistory?: any[];
  /** True when the loop stopped at the maxToolRounds cap. */
  capHit?: boolean;
}

export interface DocOpsTransport {
  call(payload: LlmCallPayload): Promise<LlmCallResult>;
  /** True when an API-key field should be shown to the user. */
  readonly requiresApiKey: boolean;
  /** True when the transport drives the full multi-round loop internally. */
  readonly drivesLoop: boolean;
  /** Human label for the settings UI (e.g. "Anthropic", "Ollama (local)"). */
  readonly label: string;
}

const abortError = () => Object.assign(new Error('AbortError'), { name: 'AbortError' });

// ── AnthropicTransport (cloud, BYO key) ──────────────────────────────────────

/** Browser → Anthropic Messages API. `baseUrl` lets a user point at a proxy. */
export class AnthropicTransport implements DocOpsTransport {
  readonly requiresApiKey = true;
  readonly drivesLoop = false;
  readonly label = 'Anthropic';

  constructor(private readonly baseUrl = 'https://api.anthropic.com/v1/messages') {}

  async call(payload: LlmCallPayload): Promise<LlmCallResult> {
    if (!payload.apiKey) {
      return { data: { error: { message: 'No API key configured.' } }, status: 401 };
    }
    const useStream = !!payload.onText;
    const resp = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'x-api-key': payload.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        // Browser calls to the Anthropic API need this opt-in header.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: payload.model,
        max_tokens: payload.max_tokens,
        system: payload.system,
        messages: payload.messages,
        tools: payload.tools,
        ...(useStream ? { stream: true } : {}),
      }),
      signal: payload.signal,
    });

    if (!resp.ok) {
      let data: unknown;
      try {
        data = await resp.json();
      } catch {
        data = { error: { message: `Anthropic API error ${resp.status}` } };
      }
      return { data, status: resp.status };
    }
    if (!useStream || !resp.body) {
      return { data: await resp.json(), status: resp.status };
    }
    return { data: await parseAnthropicSse(resp.body, payload.onText), status: resp.status };
  }
}

/** Parse an Anthropic SSE stream into `{ content, stop_reason }`. */
async function parseAnthropicSse(
  body: ReadableStream<Uint8Array>,
  onText?: (t: string) => void,
): Promise<{ content: any[]; stop_reason: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const content: any[] = [];
  let msgDelta: any = {};
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') break outer;
      let ev: any;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
        content.push({ type: 'text', text: '' });
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        content.push({ type: 'tool_use', id: ev.content_block.id, name: ev.content_block.name, input: {} });
      } else if (ev.type === 'content_block_delta') {
        const last = content[content.length - 1];
        if (ev.delta?.type === 'text_delta' && last?.type === 'text') {
          last.text += ev.delta.text ?? '';
          onText?.(ev.delta.text ?? '');
        } else if (ev.delta?.type === 'input_json_delta' && last?.type === 'tool_use') {
          last._inputStr = (last._inputStr ?? '') + (ev.delta.partial_json ?? '');
        }
      } else if (ev.type === 'content_block_stop') {
        const last = content[content.length - 1];
        if (last?.type === 'tool_use' && last._inputStr) {
          try {
            last.input = JSON.parse(last._inputStr);
          } catch {
            /* leave empty */
          }
          delete last._inputStr;
        }
      } else if (ev.type === 'message_delta') {
        msgDelta = ev.delta ?? {};
      }
    }
  }
  return { content, stop_reason: msgDelta.stop_reason ?? 'end_turn' };
}

// ── OpenAICompatTransport (Ollama / OpenAI-compatible local or cloud) ─────────

/**
 * Browser → any OpenAI-compatible `/chat/completions` endpoint. This is the
 * "use your own local model" path: Ollama (default `http://localhost:11434/v1`),
 * LM Studio, vLLM, or OpenAI itself. Non-streaming (a single round); the panel
 * loops for tool use. The internal conversation stays in Anthropic block shape —
 * we translate to/from OpenAI on the wire so nothing else has to know.
 */
export class OpenAICompatTransport implements DocOpsTransport {
  readonly drivesLoop = false;
  readonly requiresApiKey: boolean;
  readonly label: string;

  constructor(
    private readonly baseUrl = 'http://localhost:11434/v1',
    opts?: { requiresApiKey?: boolean; label?: string },
  ) {
    // Ollama/LM Studio need no key; OpenAI/vLLM-with-auth do.
    this.requiresApiKey = opts?.requiresApiKey ?? false;
    this.label = opts?.label ?? 'Ollama (local)';
  }

  async call(payload: LlmCallPayload): Promise<LlmCallResult> {
    const url = this.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const useStream = !!payload.onText;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(payload.apiKey ? { authorization: `Bearer ${payload.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: payload.model,
          max_tokens: payload.max_tokens,
          messages: toOpenAIMessages(payload.system, payload.messages),
          tools: toOpenAITools(payload.tools),
          stream: useStream,
        }),
        signal: payload.signal,
      });
    } catch (err) {
      return { data: { error: { message: `Local model request failed: ${String(err)}` } }, status: 500 };
    }
    if (!resp.ok) {
      let msg = `Local model error ${resp.status}`;
      try {
        const j = await resp.json();
        msg = j?.error?.message ?? j?.error ?? msg;
      } catch {
        /* keep default */
      }
      return { data: { error: { message: msg } }, status: resp.status };
    }
    if (useStream && resp.body) {
      return { data: await parseOpenAiSse(resp.body, payload.onText), status: resp.status };
    }
    const j = await resp.json();
    const choice = j?.choices?.[0];
    const { content, stop_reason } = fromOpenAIMessage(choice?.message, choice?.finish_reason);
    return { data: { content, stop_reason }, status: resp.status };
  }
}

/**
 * Parse an OpenAI-compatible `/chat/completions` SSE stream into Anthropic
 * `{ content, stop_reason }`. Content deltas fire `onText`; tool-call deltas
 * (which arrive fragmented, keyed by `index`) are accumulated and JSON-parsed.
 */
export async function parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
  onText?: (t: string) => void,
): Promise<{ content: any[]; stop_reason: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const toolAcc: Record<number, { id?: string; name?: string; args: string }> = {};
  let finish = 'stop';
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') break outer;
      let ev: any;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }
      const choice = ev.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const acc = (toolAcc[idx] ??= { args: '' });
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  const content: any[] = [];
  if (text) content.push({ type: 'text', text });
  for (const idx of Object.keys(toolAcc).map(Number).sort((a, b) => a - b)) {
    const acc = toolAcc[idx];
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(acc.args || '{}');
    } catch {
      /* leave empty on malformed args */
    }
    content.push({ type: 'tool_use', id: acc.id, name: acc.name, input });
  }
  const stop_reason = finish === 'tool_calls' || content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  return { content, stop_reason };
}

/** Anthropic system + `content`-block messages → OpenAI chat messages. */
export function toOpenAIMessages(system: string, messages: any[]): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages ?? []) {
    const content = m.content;
    if (typeof content === 'string') {
      out.push({ role: m.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (m.role === 'assistant') {
      let text = '';
      const toolCalls: any[] = [];
      for (const b of content) {
        if (b.type === 'text') text += b.text ?? '';
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // user turn: tool_result blocks become individual `tool` messages; any
      // text becomes a normal user message.
      let text = '';
      for (const b of content) {
        if (b.type === 'tool_result') {
          const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: c });
        } else if (b.type === 'text') {
          text += b.text ?? '';
        }
      }
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/** Anthropic tool defs → OpenAI function tools. */
export function toOpenAITools(tools: any[]): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** OpenAI response message → Anthropic `content` blocks + `stop_reason`. */
export function fromOpenAIMessage(message: any, finishReason?: string): { content: any[]; stop_reason: string } {
  const content: any[] = [];
  if (message?.content) content.push({ type: 'text', text: String(message.content) });
  for (const tc of message?.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tc.function?.arguments ?? '{}');
    } catch {
      /* leave empty on malformed args */
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  const stop_reason = finishReason === 'tool_calls' || (message?.tool_calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn';
  return { content, stop_reason };
}

// ── CollabTransport (server holds the loop; provider = server env) ────────────

export class CollabTransport implements DocOpsTransport {
  readonly requiresApiKey = false;
  readonly drivesLoop = true;
  readonly label = 'Collab server';

  constructor(
    private readonly aiWsUrl: string,
    private readonly room?: string,
  ) {}

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
      const settle = (v: LlmCallResult | null, err?: Error) => {
        if (settled) return;
        settled = true;
        payload.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(v!);
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

// ── DesktopTransport (native llama.cpp worker / native HTTP proxy) ────────────

export class DesktopTransport implements DocOpsTransport {
  readonly requiresApiKey = false;
  readonly drivesLoop = true;
  readonly label = 'Local (desktop)';

  call(payload: LlmCallPayload): Promise<LlmCallResult> {
    if (payload.signal?.aborted) return Promise.reject(abortError());
    const tauri = (window as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    if (!tauri?.invoke) return new AnthropicTransport().call(payload);
    return this.runLoop(payload, tauri.invoke.bind(tauri));
  }

  private async runLoop(
    payload: LlmCallPayload,
    invoke: (cmd: string, args?: unknown) => Promise<unknown>,
  ): Promise<LlmCallResult> {
    const maxRounds = payload.maxToolRounds ?? 12;
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

// ── Provider config + factory ────────────────────────────────────────────────

/**
 * User-facing provider choice. `auto` picks Desktop inside the shell, else
 * Anthropic. The AI settings UI surfaces these so a user can run cloud, their
 * own local model (Ollama/OpenAI-compatible), the bundled desktop worker, or a
 * collab server — without any rebuild.
 */
export type ProviderConfig =
  | { provider: 'auto' }
  | { provider: 'desktop' }
  | { provider: 'collab'; collabWsUrl: string; room?: string }
  | { provider: 'anthropic'; apiKey?: string; baseUrl?: string }
  | { provider: 'ollama'; baseUrl?: string; apiKey?: string }
  | { provider: 'openai'; apiKey?: string; baseUrl?: string };

const isDesktopShell = () =>
  typeof window !== 'undefined' &&
  !!(window as { __deskApp__?: { isDesktop?: boolean } }).__deskApp__?.isDesktop;

/** Build the transport for a provider choice (defaults to `auto`). */
export function createDocOpsTransport(cfg: ProviderConfig = { provider: 'auto' }): DocOpsTransport {
  switch (cfg.provider) {
    case 'desktop':
      return new DesktopTransport();
    case 'collab': {
      // wss://host/yjs → wss://host/api/ai
      const aiWsUrl = cfg.collabWsUrl.replace(/\/yjs$/, '').replace(/\/+$/, '') + '/api/ai';
      return new CollabTransport(aiWsUrl, cfg.room);
    }
    case 'anthropic':
      return new AnthropicTransport(cfg.baseUrl);
    case 'ollama':
      return new OpenAICompatTransport(cfg.baseUrl ?? 'http://localhost:11434/v1', {
        requiresApiKey: false,
        label: 'Ollama (local)',
      });
    case 'openai':
      return new OpenAICompatTransport(cfg.baseUrl ?? 'https://api.openai.com/v1', {
        requiresApiKey: true,
        label: 'OpenAI-compatible',
      });
    case 'auto':
    default:
      return isDesktopShell() ? new DesktopTransport() : new AnthropicTransport();
  }
}
