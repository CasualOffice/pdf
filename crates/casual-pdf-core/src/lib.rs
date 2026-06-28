// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

//! casual-pdf-core — the shared, heavy-duty PDF engine for Casual PDF.
//!
//! One crate, two targets:
//!   * **native** (desktop / Tauri) — links PDFium via `pdfium-render` and does
//!     real rendering / extraction / structure ops on a background thread.
//!   * **wasm32** (browser worker) — the same crate compiles to wasm; today the
//!     browser renders via EmbedPDF's PDFium-WASM, and routing this crate's own
//!     calls through a wasm PDFium build is the Phase 0.5 step.
//!
//! This is the single-engine thesis in code: the desktop and the web run the
//! same PDFium, so fidelity is identical by construction (gate UX-F1).

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use pdfium_render::prelude::*;

    /// Render the first page of a PDF to PNG-encoded bytes at `target_width` px.
    /// `pdfium` is a bound PDFium instance (see [`bind_pdfium`]).
    pub fn render_first_page_png(
        pdfium: &Pdfium,
        pdf_bytes: &[u8],
        target_width: u16,
    ) -> Result<Vec<u8>, PdfiumError> {
        let document = pdfium.load_pdf_from_byte_slice(pdf_bytes, None)?;
        let page = document.pages().first()?;
        let config = PdfRenderConfig::new().set_target_width(target_width as i32);
        let bitmap = page.render_with_config(&config)?;
        let image = bitmap.as_image()?;

        let mut png = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|_| PdfiumError::ImageError)?;
        Ok(png)
    }

    /// Number of pages in a PDF — a cheap structural probe with no rendering.
    pub fn page_count(pdfium: &Pdfium, pdf_bytes: &[u8]) -> Result<u16, PdfiumError> {
        let document = pdfium.load_pdf_from_byte_slice(pdf_bytes, None)?;
        // pdfium-render 0.9's `PdfPages::len()` returns an `i32`; a PDF page count
        // always fits in u16, so the lossless conversion never actually fails.
        Ok(document.pages().len() as u16)
    }

    /// Bind to a PDFium shared library discovered next to the executable, then
    /// falling back to the system library. The desktop shell ships the PDFium
    /// dynamic lib alongside the Tauri binary.
    pub fn bind_pdfium() -> Result<Pdfium, PdfiumError> {
        let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./"))
            .or_else(|_| Pdfium::bind_to_system_library())?;
        Ok(Pdfium::new(bindings))
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::{bind_pdfium, page_count, render_first_page_png};

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// Build identifier — proves the same crate compiles to wasm32. The PDFium
    /// render path (mirroring the native module) is wired through a wasm PDFium
    /// build in Phase 0.5.
    #[wasm_bindgen]
    pub fn core_version() -> String {
        concat!("casual-pdf-core ", env!("CARGO_PKG_VERSION"), " (wasm)").to_string()
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires a PDFium shared library on the host"]
    fn renders_first_page() {
        let pdfium = bind_pdfium().expect("bind pdfium");
        let bytes = std::fs::read("tests/fixtures/sample.pdf").expect("fixture");
        let png = render_first_page_png(&pdfium, &bytes, 800).expect("render");
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
    }
}
