// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * "Ask this PDF" panel — a thin React shell over the tested DocOps engine
 * (`transport` + `catalog` + `bridge` + `loop`). Streams the answer live and
 * shows a processing indicator while the model works. Provider-flexible: the
 * user can point it at Anthropic, a local model, or Ollama (see `ProviderConfig`).
 *
 * All the logic lives in `runDocOpsTurn` (unit-tested). This file is just
 * state + markup, so a Playwright test drives it with an injected transport.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CasualPdfApi } from '../modes';
import { Icon } from '../ui/icons';
import { createDocOpsTransport, type DocOpsTransport, type ProviderConfig } from './transport';
import { PDF_CATALOG, PDF_SYSTEM_PROMPT } from './catalog';
import { PdfOpsBridge } from './bridge';
import { runDocOpsTurn } from './loop';
import { linkifyCitations } from './cite';
import './ai.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AiPanelProps {
  /** Reaches the live viewer API so tools can read/navigate the document. */
  getApi: () => CasualPdfApi | null;
  /** Which provider to use (Anthropic / local / Ollama / …). Defaults to auto. */
  provider?: ProviderConfig;
  /** Model id. Defaults to Claude Opus 4.8 for cloud. */
  model?: string;
  /** Test/override seam — inject a transport instead of building one. */
  createTransport?: () => DocOpsTransport;
  onClose?: () => void;
  style?: CSSProperties;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}


export function AiPanel({ getApi, provider, model = 'claude-opus-4-8', createTransport, onClose, style }: AiPanelProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [toolHint, setToolHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<any[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Abort any in-flight turn if the panel unmounts (e.g. drawer closes).
  useEffect(() => () => abortRef.current?.abort(), []);

  const resolveTransport = useCallback((): DocOpsTransport => {
    if (createTransport) return createTransport();
    // Test seam: the app may install a scripted transport for headless drives.
    const injected = (globalThis as any).__casualPdfAiTransport__ as DocOpsTransport | undefined;
    if (injected) return injected;
    return createDocOpsTransport(provider ?? { provider: 'auto' });
  }, [createTransport, provider]);

  const send = useCallback(async (override?: string) => {
    const userText = (override ?? input).trim();
    if (!userText || busy) return;
    const transport = resolveTransport();
    // Honest failure: don't accept a query a dead transport can't serve.
    if (typeof transport.available === 'function' && !transport.available()) {
      if (!override) setInput('');
      setMessages((m) => [...m, { role: 'user', text: userText }]);
      setError('The AI assistant runs in the Casual Office desktop app, or with a connected collab server. It is not available on this web build.');
      return;
    }
    if (!override) setInput('');
    setError(null);
    setStreaming('');
    setToolHint(null);
    setMessages((m) => [...m, { role: 'user', text: userText }]);

    const bridge = new PdfOpsBridge(getApi);
    const controller = new AbortController();
    abortRef.current = controller;
    let acc = '';
    try {
      const result = await runDocOpsTurn({
        transport,
        model,
        system: PDF_SYSTEM_PROMPT,
        history: historyRef.current,
        userText,
        tools: PDF_CATALOG,
        bridge,
        signal: controller.signal,
        callbacks: {
          onBusy: setBusy,
          onText: (t) => {
            acc += t;
            setStreaming(acc);
            queueMicrotask(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight));
          },
          onToolStart: (name, args) =>
            setToolHint(name === 'get_page_text' ? `Reading page ${(args as any).page}…` : `Running ${name}…`),
          onError: setError,
        },
      });
      historyRef.current = result.history;
      const answer = result.answer || acc;
      setMessages((m) => [...m, { role: 'assistant', text: answer }]);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // Keep whatever streamed before Stop instead of dropping it.
        if (acc.trim()) setMessages((m) => [...m, { role: 'assistant', text: acc }]);
      } else {
        setError((err as Error)?.message ?? String(err));
      }
    } finally {
      setStreaming('');
      setToolHint(null);
    }
  }, [input, busy, resolveTransport, getApi, model]);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    historyRef.current = [];
    setMessages([]);
    setStreaming('');
    setToolHint(null);
    setError(null);
  }, []);

  const { transportLabel, unavailable } = (() => {
    try {
      const t = resolveTransport();
      const avail = typeof t.available !== 'function' || t.available();
      return { transportLabel: avail ? t.label : '', unavailable: !avail };
    } catch {
      return { transportLabel: '', unavailable: false };
    }
  })();

  return (
    <div className="cpdf__ai" style={style} data-testid="ai-panel">
      <div className="cpdf__ai-head">
        <span>Ask this PDF {unavailable ? <small>· unavailable</small> : transportLabel ? <small>· {transportLabel}</small> : null}</span>
        <span className="cpdf__ai-headbtns">
          {messages.length > 0 || busy ? (
            <button type="button" className="cpdf__ai-iconbtn" data-testid="ai-clear" onClick={clearChat} aria-label="Clear conversation" title="Clear conversation">
              <Icon name="trash" size={16} />
            </button>
          ) : null}
          {onClose ? (
            <button type="button" className="cpdf__ai-iconbtn" onClick={onClose} aria-label="Close AI panel" title="Close">
              <Icon name="close" size={18} />
            </button>
          ) : null}
        </span>
      </div>

      <div className="cpdf__ai-log" ref={logRef} role="log" aria-live="polite" aria-busy={busy}>
        {messages.length === 0 && !busy ? (
          <div className="cpdf__ai-empty" data-testid="ai-empty">
            {unavailable ? (
              <p style={{ margin: 0 }} data-testid="ai-unavailable">
                The assistant runs in the Casual Office desktop app, or with a connected collab server. It’s not available on this web build.
              </p>
            ) : (
              <>
                <p style={{ margin: 0 }}>Ask anything about this document.</p>
                {['Summarize this document', 'What is this document about?'].map((q) => (
                  <button key={q} type="button" className="cpdf__ai-quick" data-testid="ai-quick" onClick={() => void send(q)}>
                    {q}
                  </button>
                ))}
              </>
            )}
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`cpdf__ai-msg${m.role === 'user' ? ' cpdf__ai-msg--me' : ''}`}
            data-testid={m.role === 'assistant' ? 'ai-answer' : 'ai-user'}
          >
            {m.role === 'assistant'
              ? linkifyCitations(m.text).map((seg, j) =>
                  seg.type === 'page' ? (
                    <button
                      key={j}
                      type="button"
                      className="cpdf__ai-cite"
                      data-testid="ai-cite"
                      title={`Go to page ${seg.page}`}
                      onClick={() => getApi()?.gotoPage(seg.page - 1)}
                    >
                      {seg.label}
                    </button>
                  ) : (
                    <span key={j}>{seg.text}</span>
                  ),
                )
              : m.text}
          </div>
        ))}
        {busy && streaming ? (
          <div className="cpdf__ai-msg" data-testid="ai-streaming">
            {streaming}
          </div>
        ) : null}
        {busy ? (
          <div className="cpdf__ai-thinking" data-testid="ai-thinking">
            <span className="cpdf__ai-dot" />
            <span>{toolHint ?? 'Thinking…'}</span>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="cpdf__ai-error" data-testid="ai-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="cpdf__ai-foot">
        <textarea
          className="cpdf__ai-input"
          rows={2}
          value={input}
          disabled={unavailable}
          placeholder={unavailable ? 'AI unavailable on the web build' : 'Ask about this document…'}
          data-testid="ai-input"
          aria-label="Ask about this document"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button type="button" className="cpdf__ai-btn cpdf__ai-btn--stop" data-testid="ai-stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="cpdf__ai-btn" disabled={unavailable || !input.trim()} data-testid="ai-send" onClick={() => void send()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
