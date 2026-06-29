// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />

// The SDK imports the core wasm as an asset URL; declared here so the app's tsc
// (which compiles SDK source) resolves it. Vite emits the hashed asset URL.
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
