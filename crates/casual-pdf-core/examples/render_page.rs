// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

//! Render page 1 of a PDF to a PNG via native PDFium — the *native* half of the
//! UX-F1 render-parity harness (the web half is EmbedPDF's PDFium-WASM; see
//! tools/render-parity). Same engine on both sides → pixel-equivalent output.
//!
//! Usage: cargo run -p casual-pdf-core --example render_page -- <in.pdf> <width> <out.png>
//!
//! Requires a PDFium shared library discoverable by `bind_pdfium()` (next to the
//! binary, then the system library). See tools/render-parity/README.md.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: render_page <in.pdf> <width> <out.png>");
        return ExitCode::from(2);
    }
    let (pdf_path, width_str, out_path) = (&args[1], &args[2], &args[3]);
    let width: u16 = match width_str.parse() {
        Ok(w) => w,
        Err(_) => {
            eprintln!("width must be a positive integer (got {width_str:?})");
            return ExitCode::from(2);
        }
    };

    let pdfium = match casual_pdf_core::bind_pdfium() {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "could not bind PDFium ({e:?}). Provide a PDFium shared library — \
                 see tools/render-parity/README.md."
            );
            return ExitCode::from(3);
        }
    };

    let bytes = match std::fs::read(pdf_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("read {pdf_path}: {e}");
            return ExitCode::from(1);
        }
    };

    match casual_pdf_core::render_first_page_png(&pdfium, &bytes, width) {
        Ok(png) => {
            if let Err(e) = std::fs::write(out_path, &png) {
                eprintln!("write {out_path}: {e}");
                return ExitCode::from(1);
            }
            eprintln!("wrote {out_path} ({} bytes, width {width})", png.len());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("render failed: {e:?}");
            ExitCode::from(1)
        }
    }
}
