#!/usr/bin/env bash
# Build casual-pdf-core to wasm (wasm-bindgen, ES module) and vendor the artifact
# into the SDK so the web build needs no Rust toolchain. Run after changing the
# crate's wasm surface (e.g. src/redact.rs). Requires: rustup wasm32 target +
# wasm-pack (`cargo install wasm-pack` or brew).
#
#   tools/build-core-wasm.sh
set -euo pipefail
cd "$(dirname "$0")/.."

wasm-pack build crates/casual-pdf-core --target web --out-dir pkg --release

dest="packages/pdf-sdk/src/wasm"
mkdir -p "$dest"
cp crates/casual-pdf-core/pkg/casual_pdf_core.js \
   crates/casual-pdf-core/pkg/casual_pdf_core.d.ts \
   crates/casual-pdf-core/pkg/casual_pdf_core_bg.wasm \
   crates/casual-pdf-core/pkg/casual_pdf_core_bg.wasm.d.ts \
   "$dest/"
echo "✔ vendored core wasm → $dest"
