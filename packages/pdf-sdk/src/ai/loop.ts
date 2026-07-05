// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * The DocOps agent turn — one user message → streamed answer, running tools via
 * the bridge until the model is done. This is deliberately a PURE, injectable
 * function (transport + bridge passed in) so it can be unit-tested with a fake
 * transport, no network or browser. The AiPanel is a thin React wrapper on top.
 *
 * It handles BOTH transport kinds:
 *  - drivesLoop=true  (Collab / Desktop): the transport runs the whole loop and
 *    calls our `toolExecutor`; we just stream text and read the final history.
 *  - drivesLoop=false (Anthropic / Ollama): we run the round loop here, executing
 *    tool_use blocks via the bridge between rounds.
 *
 * Callbacks are the UI contract: `onBusy` drives the processing indicator,
 * `onText` streams tokens, `onToolStart` announces each tool call.
 */

import type { DocOpsTransport } from './transport';
import type { PdfOpsBridge } from './bridge';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TurnCallbacks {
  /** Processing indicator: true from send until the turn settles. */
  onBusy?: (busy: boolean) => void;
  /** Streamed assistant text (append as it arrives). */
  onText?: (delta: string) => void;
  /** Fired when the model invokes a tool (for a "Reading page 2…" hint). */
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  /** Terminal error message (also thrown to the caller unless aborted). */
  onError?: (message: string) => void;
}

export interface RunTurnOptions {
  transport: DocOpsTransport;
  model: string;
  system: string;
  apiKey?: string;
  /** Prior conversation (Anthropic block shape). Not mutated. */
  history?: any[];
  /** The new user message text. */
  userText: string;
  tools: any[];
  bridge: PdfOpsBridge;
  maxToolRounds?: number;
  callbacks?: TurnCallbacks;
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface TurnResult {
  /** Full conversation after this turn. */
  history: any[];
  /** The assistant's streamed text for this turn. */
  answer: string;
  /** True when the loop hit the tool-round cap. */
  capHit?: boolean;
}

/** Extract concatenated text from an assistant `content` array. */
function textOf(content: any[]): string {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
}

export async function runDocOpsTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const { transport, bridge, callbacks: cb } = opts;
  const maxRounds = opts.maxToolRounds ?? 12;
  const maxTokens = opts.maxTokens ?? 4096;
  const messages: any[] = [...(opts.history ?? []), { role: 'user', content: opts.userText }];
  let answer = '';
  const onText = (t: string) => {
    answer += t;
    cb?.onText?.(t);
  };

  cb?.onBusy?.(true);
  try {
    // Tool executor shared by both paths — routes through the bridge and
    // announces the call for the UI.
    const toolExecutor = async (name: string, args: Record<string, unknown>) => {
      cb?.onToolStart?.(name, args);
      const res = await bridge.callTool(name, args);
      return res;
    };

    if (transport.drivesLoop) {
      // Server/desktop holds the loop; it calls toolExecutor and streams text.
      const result = await transport.call({
        model: opts.model,
        system: opts.system,
        messages,
        tools: opts.tools,
        max_tokens: maxTokens,
        apiKey: opts.apiKey,
        toolExecutor,
        onText,
        signal: opts.signal,
        maxToolRounds: maxRounds,
      });
      if (result.data?.error) {
        const message = result.data.error.message ?? 'AI request failed.';
        cb?.onError?.(message);
        throw new Error(message);
      }
      return { history: result.updatedHistory ?? messages, answer, capHit: result.capHit };
    }

    // Browser transports (Anthropic / Ollama): run the round loop here.
    for (let round = 0; round < maxRounds; round++) {
      const result = await transport.call({
        model: opts.model,
        system: opts.system,
        messages,
        tools: opts.tools,
        max_tokens: maxTokens,
        apiKey: opts.apiKey,
        onText,
        signal: opts.signal,
      });
      if (result.data?.error) {
        const message = result.data.error.message ?? 'AI request failed.';
        cb?.onError?.(message);
        throw new Error(message);
      }
      const content: any[] = Array.isArray(result.data?.content) ? result.data.content : [];
      messages.push({ role: 'assistant', content });

      const toolUses = content.filter((b) => b?.type === 'tool_use');
      if (toolUses.length === 0 || result.data?.stop_reason === 'end_turn') {
        return { history: messages, answer };
      }

      const toolResults: any[] = [];
      for (const block of toolUses) {
        const res = await toolExecutor(block.name, (block.input ?? {}) as Record<string, unknown>);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(res),
          ...(res && (res as any).ok === false ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: toolResults });

      if (round === maxRounds - 1) return { history: messages, answer, capHit: true };
    }
    return { history: messages, answer };
  } finally {
    cb?.onBusy?.(false);
  }
}

// Re-export the assistant text helper for callers/tests.
export { textOf as _textOf };
