// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Certified PDF signing (@signpdf + node-forge, via @casualoffice/pdf) operates
// on Node Buffers; expose a Buffer global before anything imports the SDK.
import { Buffer } from 'buffer';
if (!(globalThis as { Buffer?: unknown }).Buffer) (globalThis as { Buffer?: unknown }).Buffer = Buffer;
import './desk-bridge-bootstrap';
// Design-system tokens (CSS custom properties + Material Symbols font) must load
// once, before app styles, so component vars resolve. There is no ThemeProvider;
// dark mode is opt-in via data-theme="dark" on an ancestor.
import '@schnsrw/design-system/tokens.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
