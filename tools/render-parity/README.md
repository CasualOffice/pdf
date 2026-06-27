# UX-F1 render-parity harness

Proves the **single-engine** thesis: a page rendered by the **web** path
(EmbedPDF, PDFium-WASM) is pixel-equivalent to the **native** path
(`pdfium-render`). Same PDFium → identical fidelity (gate **UX-F1** in
[`docs/BENCHMARK.md`](../../docs/BENCHMARK.md)).

## Pieces

- `fixtures/sample.pdf` — deterministic fixture (committed). Regenerate with
  `node gen-fixture.mjs` (uses `pdf-lib`, standard fonts only).
- `render-web.mjs` — drives the built app via its `?src=` override and
  screenshots page 1's rendered `<img>` → `out/web.png`. Needs Chrome
  (`CHROME_PATH` or `--chrome`).
- `crates/casual-pdf-core` `--example render_page` — native PDFium → `out/native.png`.
- `compare.mjs` — normalises to one grid and pixel-diffs; gates on a mismatch
  ratio (default 2%).
- `run.sh` — orchestrates all of the above; **skips** (does not fail) the native
  half when no PDFium library is present.

## Run

```bash
cd tools/render-parity
npm install
node gen-fixture.mjs        # only if regenerating the fixture
./run.sh                    # web half always; native half if libpdfium present
```

## Getting `libpdfium` (native half)

`pdfium-render` needs a PDFium shared library. The canonical source is the
prebuilt [`bblanchon/pdfium-binaries`](https://github.com/bblanchon/pdfium-binaries)
releases. `bind_pdfium()` looks next to the binary first, then the system
library — drop `libpdfium.dylib` / `libpdfium.so` next to the example binary
(`target/debug/examples/`) or on the library path.
