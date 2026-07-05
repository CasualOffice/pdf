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

import { useCallback, useRef, useState, type CSSProperties } from 'react';
import type { CasualPdfApi } from '../modes';
import { createDocOpsTransport, type DocOpsTransport, type ProviderConfig } from './transport';
import { PDF_CATALOG, PDF_SYSTEM_PROMPT } from './catalog';
import { PdfOpsBridge } from './bridge';
import { runDocOpsTurn } from './loop';

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

const S = {
  panel: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 320, background: 'var(--cpdf-surface, #fff)', color: 'inherit' } as CSSProperties,
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', fontWeight: 600 } as CSSProperties,
  log: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 } as CSSProperties,
  bubble: (me: boolean): CSSProperties => ({
    alignSelf: me ? 'flex-end' : 'flex-start',
    maxWidth: '85%',
    padding: '8px 12px',
    borderRadius: 12,
    background: me ? 'var(--cpdf-accent, #2563eb)' : 'var(--cpdf-surface-2, #f1f3f5)',
    color: me ? '#fff' : 'inherit',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  }),
  foot: { padding: 10, display: 'flex', gap: 8, borderTop: '1px solid var(--cpdf-border, #e5e7eb)' } as CSSProperties,
  input: { flex: 1, resize: 'none', padding: 8, borderRadius: 8, border: '1px solid var(--cpdf-border, #e5e7eb)', font: 'inherit', background: 'transparent', color: 'inherit' } as CSSProperties,
  send: { padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--cpdf-accent, #2563eb)', color: '#fff', cursor: 'pointer' } as CSSProperties,
  thinking: { display: 'flex', alignItems: 'center', gap: 8, alignSelf: 'flex-start', color: 'var(--cpdf-muted, #6b7280)', fontSize: 13 } as CSSProperties,
  dot: { width: 8, height: 8, borderRadius: '50%', background: 'currentColor', animation: 'cpdf-ai-pulse 1s ease-in-out infinite' } as CSSProperties,
  error: { color: '#b91c1c', padding: '6px 12px', fontSize: 13 } as CSSProperties,
};

export function AiPanel({ getApi, provider, model = 'claude-opus-4-8', createTransport, onClose, style }: AiPanelProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [toolHint, setToolHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<any[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

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
    if (!override) setInput('');
    setError(null);
    setStreaming('');
    setToolHint(null);
    setMessages((m) => [...m, { role: 'user', text: userText }]);

    const transport = resolveTransport();
    const bridge = new PdfOpsBridge(getApi);
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
      if ((err as Error)?.name !== 'AbortError') setError((err as Error)?.message ?? String(err));
    } finally {
      setStreaming('');
      setToolHint(null);
    }
  }, [input, busy, resolveTransport, getApi, model]);

  const transportLabel = (() => {
    try {
      return resolveTransport().label;
    } catch {
      return '';
    }
  })();

  return (
    <div style={{ ...S.panel, ...style }} data-testid="ai-panel">
      <style>{`@keyframes cpdf-ai-pulse{0%,100%{opacity:.3}50%{opacity:1}}`}</style>
      <div style={S.head}>
        <span>Ask this PDF {transportLabel ? <small style={{ opacity: 0.6, fontWeight: 400 }}>· {transportLabel}</small> : null}</span>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label="Close AI panel" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>
            ×
          </button>
        ) : null}
      </div>

      <div style={S.log} ref={logRef} role="log" aria-live="polite" aria-busy={busy}>
        {messages.length === 0 && !busy ? (
          <div data-testid="ai-empty" style={{ margin: 'auto', textAlign: 'center', color: 'var(--cpdf-muted, #6b7280)', maxWidth: 260 }}>
            <p style={{ margin: '0 0 10px' }}>Ask anything about this document.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {['Summarize this document', 'What is this document about?'].map((q) => (
                <button
                  key={q}
                  type="button"
                  data-testid="ai-quick"
                  onClick={() => void send(q)}
                  style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--cpdf-border, #e5e7eb)', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} style={S.bubble(m.role === 'user')} data-testid={m.role === 'assistant' ? 'ai-answer' : 'ai-user'}>
            {m.text}
          </div>
        ))}
        {busy && streaming ? (
          <div style={S.bubble(false)} data-testid="ai-streaming">
            {streaming}
          </div>
        ) : null}
        {busy ? (
          <div style={S.thinking} data-testid="ai-thinking">
            <span style={S.dot} />
            <span>{toolHint ?? 'Thinking…'}</span>
          </div>
        ) : null}
      </div>

      {error ? (
        <div style={S.error} data-testid="ai-error" role="alert">
          {error}
        </div>
      ) : null}

      <div style={S.foot}>
        <textarea
          style={S.input}
          rows={2}
          value={input}
          placeholder="Ask about this document…"
          data-testid="ai-input"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" style={S.send} disabled={busy || !input.trim()} data-testid="ai-send" onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  );
}
