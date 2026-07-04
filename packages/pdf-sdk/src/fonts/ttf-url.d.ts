// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
// Vite resolves `?url` imports to the emitted asset URL (string). Declared here
// so the SDK typechecks without depending on vite/client types (mirrors
// ../wasm/wasm-url.d.ts). Used for the bundled metric-compatible font assets.
declare module '*.ttf?url' {
  const url: string;
  export default url;
}
