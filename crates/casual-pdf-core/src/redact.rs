// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

//! Surgical, byte-level redaction (gate UX-S5).
//!
//! Unlike the rasterize-and-flatten fallback (which turns a redacted page into an
//! image and loses *all* its selectable text), this removes only the glyphs that
//! fall inside a redaction rectangle, leaving the rest of the page's text intact
//! and selectable. It works entirely in `lopdf` (pure Rust → compiles to native
//! *and* wasm32), so the same code runs in the desktop core and the browser
//! worker.
//!
//! Approach: walk the page content stream maintaining the CTM and the text/line
//! matrices, compute each glyph's box in page user space, and drop the glyphs
//! inside any redaction rect. Show operators (`Tj`/`TJ`/`'`/`"`) are rebuilt as a
//! single `TJ` array where each removed glyph becomes a numeric position
//! adjustment equal to its advance — so the glyph's *bytes are gone* (true
//! removal, verifiable by text extraction) while every surviving glyph keeps its
//! exact position. An opaque black box is painted over each rect as the visible
//! redaction mark.
//!
//! Scope of this version: simple (single-byte) fonts with a `/Widths` array — the
//! overwhelmingly common case for redaction-relevant body text, and what every
//! mainstream generator emits. Fonts without `/Widths` fall back to a
//! conservative default width (bias: over-remove, never under-remove). CID/Type0
//! handling is a documented follow-up (see `is_simple_font`).

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, StringFormat};
use std::collections::BTreeMap;

/// A redaction mark in **fractional, top-left** page coordinates (0..1) — exactly
/// what the SDK captures (zoom-independent). Converted to PDF user space per page
/// using the page MediaBox, so a non-zero MediaBox origin is handled correctly
/// (guards against silent mis-placement → under-removal).
#[derive(Clone, Copy, Debug)]
pub struct FracRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A rectangle in PDF user space (bottom-left origin) — the internal coordinate
/// space the content-stream math works in.
#[derive(Clone, Copy, Debug)]
struct Rect {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Rect {
    fn intersects(&self, o: &Rect) -> bool {
        self.x0 < o.x1 && self.x1 > o.x0 && self.y0 < o.y1 && self.y1 > o.y0
    }
}

/// Map a fractional top-left mark into PDF user space using a MediaBox
/// `[llx, lly, urx, ury]`.
fn frac_to_user(f: &FracRect, mb: [f64; 4]) -> Rect {
    let (llx, lly, urx, ury) = (mb[0], mb[1], mb[2], mb[3]);
    let (w, h) = (urx - llx, ury - lly);
    let (fx, fy, fw, fh) = (f.x, f.y, f.w.abs(), f.h.abs());
    Rect {
        x0: llx + fx * w,
        x1: llx + (fx + fw) * w,
        // top-left fy=0 is the top edge → user-space ury; fy grows downward.
        y1: lly + h * (1.0 - fy),
        y0: lly + h * (1.0 - fy - fh),
    }
}

/// Redaction marks for one page (0-based index into the document's page order).
pub struct PageRects {
    pub page_index: usize,
    pub rects: Vec<FracRect>,
}

#[derive(Debug)]
pub enum RedactError {
    Parse(String),
    Save(String),
}

impl std::fmt::Display for RedactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RedactError::Parse(s) => write!(f, "redaction parse error: {s}"),
            RedactError::Save(s) => write!(f, "redaction save error: {s}"),
        }
    }
}
impl std::error::Error for RedactError {}

/* ── 2-D affine matrices (PDF row-vector convention: [x y 1] · M) ─────────────
Stored as [a, b, c, d, e, f] = [[a b 0] [c d 0] [e f 1]]. */
type Mat = [f64; 6];
const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `m · n` — the matrix that applies `m` first, then `n` (row-vector order).
fn mul(m: Mat, n: Mat) -> Mat {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}

/// Transform a point by a matrix.
fn apply(m: Mat, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

fn translation(tx: f64, ty: f64) -> Mat {
    [1.0, 0.0, 0.0, 1.0, tx, ty]
}

fn num(o: &Object) -> f64 {
    match o {
        Object::Integer(i) => *i as f64,
        Object::Real(r) => *r as f64,
        _ => 0.0,
    }
}

/* ── Text-rendering state tracked while walking the content stream ──────────── */
#[derive(Clone)]
struct TextState {
    tm: Mat,  // text matrix
    tlm: Mat, // text line matrix
    font: Option<String>,
    size: f64,    // Tfs
    char_sp: f64, // Tc
    word_sp: f64, // Tw
    h_scale: f64, // Th (Tz / 100), default 1.0
    leading: f64, // TL
    rise: f64,    // Ts
}

impl Default for TextState {
    fn default() -> Self {
        TextState {
            tm: IDENTITY,
            tlm: IDENTITY,
            font: None,
            size: 0.0,
            char_sp: 0.0,
            word_sp: 0.0,
            h_scale: 1.0,
            leading: 0.0,
            rise: 0.0,
        }
    }
}

/// Per-font glyph widths (1000-unit glyph space), indexed by single-byte code.
type WidthTable = (i64 /*first_char*/, Vec<f64>);
const DEFAULT_WIDTH: f64 = 500.0; // conservative fallback (bias: over-remove)

/// Redact `bytes`, returning new PDF bytes with the marked content removed.
pub fn redact_pdf(bytes: &[u8], pages: &[PageRects]) -> Result<Vec<u8>, RedactError> {
    let mut doc = Document::load_mem(bytes).map_err(|e| RedactError::Parse(e.to_string()))?;
    // page_index → ObjectId (get_pages is ordered by page number).
    let page_ids: Vec<ObjectId> = doc.get_pages().into_values().collect();

    for pr in pages {
        let Some(&page_id) = page_ids.get(pr.page_index) else {
            continue;
        };
        if pr.rects.is_empty() {
            continue;
        }
        let mb = page_media_box(&doc, page_id);
        let rects: Vec<Rect> = pr.rects.iter().map(|r| frac_to_user(r, mb)).collect();
        let widths = collect_font_widths(&doc, page_id);
        let content = doc
            .get_and_decode_page_content(page_id)
            .map_err(|e| RedactError::Parse(e.to_string()))?;
        let new_ops = redact_content(content.operations, &rects, &widths);
        let mut out = Content {
            operations: new_ops,
        };
        append_black_boxes(&mut out, &rects);
        let encoded = out.encode().map_err(|e| RedactError::Save(e.to_string()))?;
        doc.change_page_content(page_id, encoded)
            .map_err(|e| RedactError::Save(e.to_string()))?;
    }

    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| RedactError::Save(e.to_string()))?;
    Ok(buf)
}

/// The page MediaBox `[llx, lly, urx, ury]`, walking the `/Parent` chain for the
/// inherited value. Defaults to US Letter if absent/malformed.
fn page_media_box(doc: &Document, page_id: ObjectId) -> [f64; 4] {
    let mut id = page_id;
    for _ in 0..32 {
        let Ok(dict) = doc.get_dictionary(id) else {
            break;
        };
        if let Ok(mb) = dict.get(b"MediaBox") {
            let arr = match mb {
                Object::Array(a) => Some(a.clone()),
                Object::Reference(r) => match doc.get_object(*r) {
                    Ok(Object::Array(a)) => Some(a.clone()),
                    _ => None,
                },
                _ => None,
            };
            if let Some(a) = arr {
                if a.len() == 4 {
                    return [num(&a[0]), num(&a[1]), num(&a[2]), num(&a[3])];
                }
            }
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(r)) => id = *r,
            _ => break,
        }
    }
    [0.0, 0.0, 612.0, 792.0]
}

/// Build single-byte width tables for every font in the page's resources.
fn collect_font_widths(doc: &Document, page_id: ObjectId) -> BTreeMap<String, WidthTable> {
    let mut out = BTreeMap::new();
    let fonts = match doc.get_page_fonts(page_id) {
        Ok(f) => f,
        Err(_) => return out,
    };
    for (name, font_dict) in fonts {
        let key = String::from_utf8_lossy(&name).into_owned();
        if let Some(table) = widths_from_font(doc, font_dict) {
            out.insert(key, table);
        }
    }
    out
}

/// Only simple (single-byte) fonts are precisely splittable here. Type0/CID
/// (multi-byte) fonts are a follow-up; until then they have no width table and
/// fall back to the conservative default (over-remove).
fn is_simple_font(font: &Dictionary) -> bool {
    match font.get(b"Subtype") {
        Ok(Object::Name(s)) => s.as_slice() != b"Type0",
        _ => true,
    }
}

fn widths_from_font(doc: &Document, font: &Dictionary) -> Option<WidthTable> {
    if !is_simple_font(font) {
        return None;
    }
    let first_char = font.get(b"FirstChar").map(|o| num(o) as i64).unwrap_or(0);
    let widths_obj = font.get(b"Widths").ok()?;
    let arr = match widths_obj {
        Object::Array(a) => a.clone(),
        Object::Reference(id) => match doc.get_object(*id) {
            Ok(Object::Array(a)) => a.clone(),
            _ => return None,
        },
        _ => return None,
    };
    let widths: Vec<f64> = arr
        .iter()
        .map(|o| match o {
            Object::Reference(id) => doc.get_object(*id).map(num).unwrap_or(DEFAULT_WIDTH),
            other => num(other),
        })
        .collect();
    Some((first_char, widths))
}

fn width_for(table: Option<&WidthTable>, code: u8) -> f64 {
    match table {
        Some((first, widths)) => {
            let idx = code as i64 - first;
            if idx >= 0 && (idx as usize) < widths.len() {
                widths[idx as usize]
            } else {
                DEFAULT_WIDTH
            }
        }
        None => DEFAULT_WIDTH,
    }
}

/* ── The content walk ───────────────────────────────────────────────────────── */
fn redact_content(
    ops: Vec<Operation>,
    rects: &[Rect],
    widths: &BTreeMap<String, WidthTable>,
) -> Vec<Operation> {
    let mut out: Vec<Operation> = Vec::with_capacity(ops.len());
    let mut ctm = IDENTITY;
    let mut ctm_stack: Vec<Mat> = Vec::new();
    let mut ts = TextState::default();

    for op in ops {
        match op.operator.as_str() {
            "q" => ctm_stack.push(ctm),
            "Q" => {
                if let Some(m) = ctm_stack.pop() {
                    ctm = m;
                }
            }
            "cm" if op.operands.len() == 6 => {
                let m: Mat = [
                    num(&op.operands[0]),
                    num(&op.operands[1]),
                    num(&op.operands[2]),
                    num(&op.operands[3]),
                    num(&op.operands[4]),
                    num(&op.operands[5]),
                ];
                ctm = mul(m, ctm);
            }
            "BT" => {
                ts.tm = IDENTITY;
                ts.tlm = IDENTITY;
            }
            "Tf" if op.operands.len() == 2 => {
                if let Object::Name(n) = &op.operands[0] {
                    ts.font = Some(String::from_utf8_lossy(n).into_owned());
                }
                ts.size = num(&op.operands[1]);
            }
            "Tc" if !op.operands.is_empty() => ts.char_sp = num(&op.operands[0]),
            "Tw" if !op.operands.is_empty() => ts.word_sp = num(&op.operands[0]),
            "Tz" if !op.operands.is_empty() => ts.h_scale = num(&op.operands[0]) / 100.0,
            "TL" if !op.operands.is_empty() => ts.leading = num(&op.operands[0]),
            "Ts" if !op.operands.is_empty() => ts.rise = num(&op.operands[0]),
            "Tm" if op.operands.len() == 6 => {
                let m: Mat = [
                    num(&op.operands[0]),
                    num(&op.operands[1]),
                    num(&op.operands[2]),
                    num(&op.operands[3]),
                    num(&op.operands[4]),
                    num(&op.operands[5]),
                ];
                ts.tm = m;
                ts.tlm = m;
            }
            "Td" if op.operands.len() == 2 => {
                let m = translation(num(&op.operands[0]), num(&op.operands[1]));
                ts.tlm = mul(m, ts.tlm);
                ts.tm = ts.tlm;
            }
            "TD" if op.operands.len() == 2 => {
                ts.leading = -num(&op.operands[1]);
                let m = translation(num(&op.operands[0]), num(&op.operands[1]));
                ts.tlm = mul(m, ts.tlm);
                ts.tm = ts.tlm;
            }
            "T*" => {
                let m = translation(0.0, -ts.leading);
                ts.tlm = mul(m, ts.tlm);
                ts.tm = ts.tlm;
            }
            "Tj" if op.operands.len() == 1 => {
                if let Object::String(s, _) = &op.operands[0] {
                    let rebuilt = redact_show(s, &mut ts, ctm, rects, widths);
                    out.push(rebuilt);
                    continue;
                }
                out.push(op);
            }
            "'" if op.operands.len() == 1 => {
                // Next line, then show. Emit the line move, then the rebuilt show.
                let m = translation(0.0, -ts.leading);
                ts.tlm = mul(m, ts.tlm);
                ts.tm = ts.tlm;
                out.push(Operation::new("T*", vec![]));
                if let Object::String(s, _) = &op.operands[0] {
                    out.push(redact_show(s, &mut ts, ctm, rects, widths));
                    continue;
                }
                out.push(op);
            }
            "\"" if op.operands.len() == 3 => {
                ts.word_sp = num(&op.operands[0]);
                ts.char_sp = num(&op.operands[1]);
                let m = translation(0.0, -ts.leading);
                ts.tlm = mul(m, ts.tlm);
                ts.tm = ts.tlm;
                out.push(Operation::new("Tw", vec![op.operands[0].clone()]));
                out.push(Operation::new("Tc", vec![op.operands[1].clone()]));
                out.push(Operation::new("T*", vec![]));
                if let Object::String(s, _) = &op.operands[2] {
                    out.push(redact_show(s, &mut ts, ctm, rects, widths));
                    continue;
                }
                out.push(op);
            }
            "TJ" if op.operands.len() == 1 => {
                if let Object::Array(items) = &op.operands[0] {
                    out.push(redact_show_array(items, &mut ts, ctm, rects, widths));
                    continue;
                }
                out.push(op);
            }
            _ => out.push(op),
        }
    }
    out
}

/// Advance of one glyph along text x, in unscaled text-space units.
fn glyph_advance(w1000: f64, ts: &TextState, code: u8) -> f64 {
    let word = if code == b' ' { ts.word_sp } else { 0.0 };
    ((w1000 / 1000.0) * ts.size + ts.char_sp + word) * ts.h_scale
}

/// Does a glyph at the current text matrix fall inside any redaction rect?
/// The glyph box is approximated generously in glyph space (x: advance, y:
/// descender..ascender) and mapped to page space via text→user→device.
fn glyph_hits(w1000: f64, ts: &TextState, ctm: Mat, rects: &[Rect]) -> bool {
    // glyph-space → text-space scale incorporating font size, h-scale, rise.
    let gp: Mat = [
        ts.size * ts.h_scale / 1000.0,
        0.0,
        0.0,
        ts.size / 1000.0,
        0.0,
        ts.rise,
    ];
    let to_page = mul(mul(gp, ts.tm), ctm);
    // Generous glyph box in 1000-unit glyph space.
    let (gx0, gx1, gy0, gy1) = (0.0, w1000.max(1.0), -200.0, 820.0);
    let corners = [(gx0, gy0), (gx1, gy0), (gx1, gy1), (gx0, gy1)];
    let mut bx0 = f64::INFINITY;
    let mut by0 = f64::INFINITY;
    let mut bx1 = f64::NEG_INFINITY;
    let mut by1 = f64::NEG_INFINITY;
    for (cx, cy) in corners {
        let (px, py) = apply(to_page, cx, cy);
        bx0 = bx0.min(px);
        by0 = by0.min(py);
        bx1 = bx1.max(px);
        by1 = by1.max(py);
    }
    let gbox = Rect {
        x0: bx0,
        y0: by0,
        x1: bx1,
        y1: by1,
    };
    rects.iter().any(|r| r.intersects(&gbox))
}

/// Rebuild a `Tj` string as a `TJ` array, dropping redacted glyphs (replaced by a
/// position-preserving numeric adjustment) and advancing the text matrix.
fn redact_show(
    s: &[u8],
    ts: &mut TextState,
    ctm: Mat,
    rects: &[Rect],
    widths: &BTreeMap<String, WidthTable>,
) -> Operation {
    let table = ts.font.as_ref().and_then(|f| widths.get(f));
    let mut items: Vec<Object> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut removed_any = false;

    for &code in s {
        let w = width_for(table, code);
        let hit = glyph_hits(w, ts, ctm, rects);
        if hit {
            removed_any = true;
            if !cur.is_empty() {
                items.push(Object::String(
                    std::mem::take(&mut cur),
                    StringFormat::Literal,
                ));
            }
            // Replace the removed glyph with its advance so following text holds.
            let adv = glyph_advance(w, ts, code);
            let tj = if ts.size * ts.h_scale != 0.0 {
                -adv / (ts.size * ts.h_scale) * 1000.0
            } else {
                0.0
            };
            items.push(Object::Real(tj as f32));
        } else {
            cur.push(code);
        }
        // Advance the text matrix past this glyph regardless of keep/remove.
        ts.tm = mul(translation(glyph_advance(w, ts, code), 0.0), ts.tm);
    }
    if !cur.is_empty() {
        items.push(Object::String(cur, StringFormat::Literal));
    }
    if removed_any {
        Operation::new("TJ", vec![Object::Array(items)])
    } else {
        // Untouched — emit the original show unchanged.
        Operation::new(
            "Tj",
            vec![Object::String(s.to_vec(), StringFormat::Literal)],
        )
    }
}

/// Same as `redact_show` but for a `TJ` array (strings interleaved with numeric
/// kerning adjustments, which we preserve and apply to the text matrix).
fn redact_show_array(
    items: &[Object],
    ts: &mut TextState,
    ctm: Mat,
    rects: &[Rect],
    widths: &BTreeMap<String, WidthTable>,
) -> Operation {
    let table = ts.font.as_ref().and_then(|f| widths.get(f));
    let mut out_items: Vec<Object> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let flush = |cur: &mut Vec<u8>, out: &mut Vec<Object>| {
        if !cur.is_empty() {
            out.push(Object::String(std::mem::take(cur), StringFormat::Literal));
        }
    };

    for item in items {
        match item {
            Object::String(s, _) => {
                for &code in s {
                    let w = width_for(table, code);
                    if glyph_hits(w, ts, ctm, rects) {
                        flush(&mut cur, &mut out_items);
                        let adv = glyph_advance(w, ts, code);
                        let tj = if ts.size * ts.h_scale != 0.0 {
                            -adv / (ts.size * ts.h_scale) * 1000.0
                        } else {
                            0.0
                        };
                        out_items.push(Object::Real(tj as f32));
                    } else {
                        cur.push(code);
                    }
                    ts.tm = mul(translation(glyph_advance(w, ts, code), 0.0), ts.tm);
                }
            }
            Object::Integer(_) | Object::Real(_) => {
                // Preserve the kerning adjustment and apply it to the matrix.
                flush(&mut cur, &mut out_items);
                let a = num(item);
                let tx = -a / 1000.0 * ts.size * ts.h_scale;
                ts.tm = mul(translation(tx, 0.0), ts.tm);
                out_items.push(item.clone());
            }
            _ => {}
        }
    }
    flush(&mut cur, &mut out_items);
    Operation::new("TJ", vec![Object::Array(out_items)])
}

/// Paint an opaque black rectangle over each redaction rect (the visible mark).
/// Wrapped in q/Q so it doesn't perturb the surrounding graphics state; assumes
/// balanced q/Q in the page content (the universal case), so it draws in the
/// page's default user space.
fn append_black_boxes(content: &mut Content, rects: &[Rect]) {
    content.operations.push(Operation::new("q", vec![]));
    content.operations.push(Operation::new(
        "rg",
        vec![Object::Real(0.0), Object::Real(0.0), Object::Real(0.0)],
    ));
    for r in rects {
        content.operations.push(Operation::new(
            "re",
            vec![
                Object::Real(r.x0 as f32),
                Object::Real(r.y0 as f32),
                Object::Real((r.x1 - r.x0) as f32),
                Object::Real((r.y1 - r.y0) as f32),
            ],
        ));
        content.operations.push(Operation::new("f", vec![]));
    }
    content.operations.push(Operation::new("Q", vec![]));
}

/// Concatenate every text string shown by a content stream — a test/diagnostic
/// helper that reads the redacted output back to assert what survives.
#[cfg(test)]
pub(crate) fn extract_shown_text(content: &Content) -> String {
    let mut s = String::new();
    for op in &content.operations {
        match op.operator.as_str() {
            "Tj" | "'" => {
                if let Some(Object::String(bytes, _)) = op.operands.last() {
                    s.push_str(&String::from_utf8_lossy(bytes));
                }
            }
            "TJ" => {
                if let Some(Object::Array(items)) = op.operands.first() {
                    for it in items {
                        if let Object::String(bytes, _) = it {
                            s.push_str(&String::from_utf8_lossy(bytes));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    /// Build a one-page PDF showing `text` at (100, 700) with a Helvetica-like
    /// simple font whose every glyph is 600 units wide (so positions are exact).
    fn build_pdf(text: &str) -> (Vec<u8>, f64) {
        let mut doc = Document::with_version("1.5");
        let glyph_w = 600.0;
        // Widths for codes 32..=126.
        let first_char = 32i64;
        let widths: Vec<Object> = (32u8..=126).map(|_| Object::Real(glyph_w as f32)).collect();
        let font_id = doc.add_object(lopdf::dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "FirstChar" => first_char,
            "LastChar" => 126i64,
            "Widths" => Object::Array(widths),
        });
        let resources = doc.add_object(lopdf::dictionary! {
            "Font" => lopdf::dictionary! { "F1" => font_id },
        });
        let cs = format!("BT /F1 24 Tf 100 700 Td ({text}) Tj ET");
        let content_id = doc.add_object(Stream::new(Dictionary::new(), cs.into_bytes()));
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(lopdf::dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => resources,
            "MediaBox" => Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()]),
        });
        let pages = lopdf::dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(vec![page_id.into()]),
            "Count" => 1i64,
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog_id = doc.add_object(lopdf::dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        (buf, glyph_w / 1000.0 * 24.0) // advance per glyph in points
    }

    /// User-space rect (on the 612×792 test page) → fractional top-left mark.
    fn frac(x0: f64, y0: f64, x1: f64, y1: f64) -> FracRect {
        let (pw, ph) = (612.0, 792.0);
        FracRect {
            x: x0 / pw,
            y: (ph - y1) / ph,
            w: (x1 - x0) / pw,
            h: (y1 - y0) / ph,
        }
    }

    #[test]
    fn removes_only_glyphs_inside_the_rect() {
        // "SECRET PUBLIC" at x=100, each glyph 14.4pt wide.
        let (pdf, adv) = build_pdf("SECRET PUBLIC");
        // "SECRET" spans x[100, 100+6*adv]; redact a box tightly over it.
        let end = 100.0 + 6.0 * adv;
        let rects = vec![PageRects {
            page_index: 0,
            rects: vec![frac(95.0, 695.0, end + 1.0, 730.0)],
        }];
        let out = redact_pdf(&pdf, &rects).expect("redact");

        // Read the redacted page's text back.
        let doc = Document::load_mem(&out).unwrap();
        let page_id = *doc.get_pages().values().next().unwrap();
        let content = doc.get_and_decode_page_content(page_id).unwrap();
        let shown = extract_shown_text(&content);

        assert!(
            !shown.contains("SECRET"),
            "redacted text must be gone, got {shown:?}"
        );
        assert!(
            shown.contains("PUBLIC"),
            "surrounding text must survive, got {shown:?}"
        );
    }

    #[test]
    fn no_rects_leaves_text_intact() {
        let (pdf, _) = build_pdf("KEEP ME");
        let out = redact_pdf(
            &pdf,
            &[PageRects {
                page_index: 0,
                rects: vec![],
            }],
        )
        .expect("redact");
        let doc = Document::load_mem(&out).unwrap();
        let page_id = *doc.get_pages().values().next().unwrap();
        let content = doc.get_and_decode_page_content(page_id).unwrap();
        assert!(extract_shown_text(&content).contains("KEEP ME"));
    }
}
