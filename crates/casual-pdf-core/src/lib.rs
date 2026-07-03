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

// Pure-Rust structure ops (lopdf) — compile on BOTH native and wasm32, no PDFium.
pub mod redact;
pub mod sign;
pub mod textedit;

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
    use crate::redact::{redact_pdf, FracRect, PageRects};
    use crate::sign::sign_pdf;
    use wasm_bindgen::prelude::*;

    /// Build identifier — proves the same crate compiles to wasm32. The PDFium
    /// render path (mirroring the native module) is wired through a wasm PDFium
    /// build in Phase 0.5.
    #[wasm_bindgen]
    pub fn core_version() -> String {
        concat!("casual-pdf-core ", env!("CARGO_PKG_VERSION"), " (wasm)").to_string()
    }

    /// Decode the flat redaction spec the SDK packs into a `Float64Array`:
    ///   `[ nPages, (pageIndex, nRects, x,y,w,h × nRects) × nPages ]`
    /// Rects are fractional, top-left page coordinates (0..1) — the SDK's native
    /// mark format. Rust converts them to user space per page via the MediaBox.
    fn parse_spec(spec: &[f64]) -> Result<Vec<PageRects>, &'static str> {
        let mut i = 0usize;
        let take = |i: &mut usize| -> Option<f64> {
            let v = spec.get(*i).copied();
            *i += 1;
            v
        };
        let n_pages = take(&mut i).ok_or("empty spec")? as usize;
        let mut pages = Vec::with_capacity(n_pages);
        for _ in 0..n_pages {
            let page_index = take(&mut i).ok_or("truncated spec: pageIndex")? as usize;
            let n_rects = take(&mut i).ok_or("truncated spec: rectCount")? as usize;
            let mut rects = Vec::with_capacity(n_rects);
            for _ in 0..n_rects {
                let x = take(&mut i).ok_or("truncated spec: rect")?;
                let y = take(&mut i).ok_or("truncated spec: rect")?;
                let w = take(&mut i).ok_or("truncated spec: rect")?;
                let h = take(&mut i).ok_or("truncated spec: rect")?;
                rects.push(FracRect { x, y, w, h });
            }
            pages.push(PageRects { page_index, rects });
        }
        Ok(pages)
    }

    /// Surgically redact `pdf` (true byte removal, surrounding text preserved),
    /// returning the new PDF bytes. `spec` is the flat array from `parse_spec`.
    #[wasm_bindgen]
    pub fn redact_pdf_wasm(pdf: &[u8], spec: &[f64]) -> Result<Vec<u8>, JsValue> {
        let pages = parse_spec(spec).map_err(JsValue::from_str)?;
        redact_pdf(pdf, &pages).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /* ── Tier-2 text editing ──────────────────────────────────────────────── */
    use crate::textedit::{edit_text_run, list_text_runs, move_text_run, runs_json};

    /// JSON array of the editable text runs on `page_index` (for the edit overlay).
    #[wasm_bindgen]
    pub fn list_text_runs_wasm(pdf: &[u8], page_index: usize) -> Result<String, JsValue> {
        let runs =
            list_text_runs(pdf, page_index).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(runs_json(&runs))
    }

    /// Replace run `run_id`'s text on `page_index`; returns new PDF bytes.
    #[wasm_bindgen]
    pub fn edit_text_run_wasm(
        pdf: &[u8],
        page_index: usize,
        run_id: usize,
        new_text: &str,
    ) -> Result<Vec<u8>, JsValue> {
        edit_text_run(pdf, page_index, run_id, new_text)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Move run `run_id` by (dx, dy) in user space; returns new PDF bytes.
    #[wasm_bindgen]
    pub fn move_text_run_wasm(
        pdf: &[u8],
        page_index: usize,
        run_id: usize,
        dx: f64,
        dy: f64,
    ) -> Result<Vec<u8>, JsValue> {
        move_text_run(pdf, page_index, run_id, dx, dy)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Apply a detached PDF signature as an incremental update.
    #[wasm_bindgen]
    pub fn sign_pdf_wasm(
        pdf: &[u8],
        signer_name: &str,
        reason: &str,
        location: Option<String>,
        contact_info: Option<String>,
    ) -> Result<Vec<u8>, JsValue> {
        console_error_panic_hook::set_once();
        sign_pdf(
            pdf,
            signer_name,
            reason,
            location.as_deref(),
            contact_info.as_deref(),
        )
        .map_err(|e| JsValue::from_str(&e.to_string()))
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
