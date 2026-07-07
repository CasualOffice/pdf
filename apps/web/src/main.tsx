// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Certified PDF signing runs through the wasm Rust core; expose a Buffer global
// before anything imports the SDK because other SDK paths still expect it.
import { Buffer } from 'buffer';
if (!(globalThis as { Buffer?: unknown }).Buffer) (globalThis as { Buffer?: unknown }).Buffer = Buffer;
import './desk-bridge-bootstrap';
// Design-system tokens (CSS custom properties + Material Symbols font) must load
// once, before app styles, so component vars resolve. There is no ThemeProvider;
// dark mode is opt-in via data-theme="dark" on an ancestor.
import '@schnsrw/design-system/tokens.css';
import './styles.css';
import { App } from './App';

// Stale-chunk recovery: after a deploy, the CDN can briefly serve an old page that
// references hashed chunks the new deploy replaced, so a lazy import 404s ("Failed
// to fetch dynamically imported module"). Vite fires `vite:preloadError` for this —
// reload ONCE to fetch fresh assets. The sessionStorage guard prevents a reload
// loop if the chunk is genuinely missing; in-progress edits autosave to recovery.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  if (!sessionStorage.getItem('cpdf-preload-reloaded')) {
    sessionStorage.setItem('cpdf-preload-reloaded', '1');
    window.location.reload();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
