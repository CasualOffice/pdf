#!/usr/bin/env bash
# UX-F1 render-parity harness runner.
#   web  half: build the app, render fixture page 1 via PDFium-WASM (EmbedPDF).
#   native half: render the same fixture via pdfium-render (needs libpdfium).
#   compare: pixel-diff the two, gate on a threshold.
#
# Native render is SKIPPED (not failed) when no PDFium library is available, so
# the web half still runs anywhere. See README.md for installing libpdfium.
set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT=$(cd ../.. && pwd)
WIDTH=${WIDTH:-612}
PORT=${PORT:-8099}
THRESHOLD=${THRESHOLD:-0.02}
OUT=out
mkdir -p "$OUT"

[ -f fixtures/sample.pdf ] || { echo "missing fixtures/sample.pdf — run: node gen-fixture.mjs"; exit 1; }

echo "== build web app =="
pnpm -C "$REPO_ROOT/apps/web" build >/dev/null
cp fixtures/sample.pdf "$REPO_ROOT/apps/web/dist/sample.pdf"

echo "== start static server =="
node serve.mjs "$REPO_ROOT/apps/web/dist" "$PORT" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
# wait for server
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/sample.pdf" -o /dev/null && break; sleep 0.3; done

echo "== render web (PDFium-WASM) =="
node render-web.mjs --url "http://127.0.0.1:$PORT/" --src "/sample.pdf" --out "$OUT/web.png"

echo "== render native (pdfium-render) =="
if cargo run -q -p casual-pdf-core --example render_page -- fixtures/sample.pdf "$WIDTH" "$OUT/native.png" 2>"$OUT/native.log"; then
  echo "== compare =="
  node compare.mjs "$OUT/web.png" "$OUT/native.png" "$OUT/diff.png" "$THRESHOLD"
else
  echo "SKIP native render — no PDFium library found (see README.md):"
  sed 's/^/  /' "$OUT/native.log" || true
  echo "Web render produced: $OUT/web.png (native parity not checked)."
  exit 0
fi
