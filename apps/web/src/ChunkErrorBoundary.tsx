// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { Component, type ReactNode } from 'react';

/**
 * Catches lazy-chunk load failures so a failed dynamic import degrades gracefully
 * instead of white-screening the whole app. This happens when a hashed chunk 404s
 * — typically a stale asset served by the CDN right after a deploy (see the
 * live-deploy caching note). We show a small fallback with a Reload button rather
 * than auto-reloading, so a user with unsaved edits isn't reloaded out from under.
 */
interface Props {
  children: ReactNode;
  /** What failed, for the message (e.g. "The AI panel"). */
  label?: string;
}
interface State {
  failed: boolean;
}

export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('[ChunkErrorBoundary]', error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ padding: 'var(--space-4, 16px)', fontSize: 13, color: 'var(--color-text-secondary, #667)', lineHeight: 1.5 }}>
        <p style={{ margin: '0 0 10px' }}>
          {this.props.label ?? 'This feature'} couldn’t load — the app may have updated since you opened the page.
        </p>
        <button
          type="button"
          onClick={() => location.reload()}
          style={{
            padding: '6px 14px',
            border: 'none',
            borderRadius: 'var(--radius-pill, 999px)',
            background: 'var(--color-accent, #2563eb)',
            color: 'var(--color-text-on-accent, #fff)',
            cursor: 'pointer',
            font: 'inherit',
            fontWeight: 500,
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
