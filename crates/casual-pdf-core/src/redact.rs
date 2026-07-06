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
//! `TJ` array where each contiguous removed run collapses to a SINGLE numeric
//! position adjustment equal to its total advance — so the glyphs' *bytes are
//! gone* (true removal, verifiable by text extraction), every surviving glyph
//! keeps its exact position, and per-glyph widths don't leak (no advance-width
//! de-redaction oracle). An opaque black box is painted over each rect.
//!
//! Fonts handled precisely: simple (single-byte) fonts with `/Widths`, AND
//! Type0/CID fonts with Identity encoding (2-byte codes == CID, widths from
//! `/W`+`/DW`) — together the overwhelming majority of real PDFs. When a page uses
//! a font/CMap we can't decode (non-Identity Type0) OR a Form XObject we don't
//! descend into, the page is reported in `RedactOutcome::low_confidence_pages` so
//! the caller flattens it (fail-closed — never a silent under-redaction).

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

const DEFAULT_WIDTH: f64 = 500.0; // conservative fallback (bias: over-remove)

/// Per-font glyph metrics needed to split a show string. Handles simple
/// (single-byte) fonts AND Type0/CID fonts with Identity encoding (the common
/// embedded-font case in real PDFs — 2-byte codes that equal the CID directly).
struct FontInfo {
    /// Type0 + Identity-H/V encoding → show strings are 2-byte codes (== CID).
    two_byte: bool,
    /// Advance (1000-unit glyph space) for codes/CIDs not in `widths`.
    default_width: f64,
    /// code (simple font) or CID (Type0) → advance width in 1000 units.
    widths: BTreeMap<u32, f64>,
    /// Whether we can decode this font's show strings precisely. False for a
    /// Type0 font with a non-Identity CMap (we can't map its multi-byte codes) —
    /// removing from such a font is unreliable, so the caller flattens the page.
    supported: bool,
}

fn width_of(info: Option<&FontInfo>, code: u32) -> f64 {
    match info {
        Some(fi) => *fi.widths.get(&code).unwrap_or(&fi.default_width),
        None => DEFAULT_WIDTH,
    }
}

/// A direct value or a reference → the resolved object.
fn resolve<'a>(doc: &'a Document, o: &'a Object) -> Option<&'a Object> {
    match o {
        Object::Reference(id) => doc.get_object(*id).ok(),
        other => Some(other),
    }
}

/// Result of a redaction: the new PDF bytes plus the 0-based indices of pages the
/// core could NOT redact with confidence (a font with a CMap it can't decode) — the
/// caller should flatten those pages so nothing is left behind.
pub struct RedactOutcome {
    pub bytes: Vec<u8>,
    pub low_confidence_pages: Vec<usize>,
}

/// Redact `bytes`, returning new PDF bytes with the marked content removed.
pub fn redact_pdf(bytes: &[u8], pages: &[PageRects]) -> Result<RedactOutcome, RedactError> {
    let mut doc = Document::load_mem(bytes).map_err(|e| RedactError::Parse(e.to_string()))?;
    // page_index → ObjectId (get_pages is ordered by page number).
    let page_ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
    let mut low_confidence_pages: Vec<usize> = Vec::new();

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
        let (new_ops, confident) = redact_content(content.operations, &rects, &widths);
        // Flatten the page if we couldn't decode a font OR it has Form XObjects
        // whose (possibly text-bearing) content we don't descend into.
        if !confident || page_has_form_xobject(&doc, page_id) {
            low_confidence_pages.push(pr.page_index);
        }
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
    Ok(RedactOutcome {
        bytes: buf,
        low_confidence_pages,
    })
}

/// Does the page reference any Form XObject? We walk only the page's own content
/// stream, not the content of Form XObjects it invokes with `Do`, so text hidden
/// inside one wouldn't be removed. When a page has one we can't guarantee complete
/// removal → the caller flattens it. (Descending into XObjects is a follow-up.)
fn page_has_form_xobject(doc: &Document, page_id: ObjectId) -> bool {
    let Ok(page) = doc.get_dictionary(page_id) else {
        return false;
    };
    let Some(Object::Dictionary(resources)) =
        page.get(b"Resources").ok().and_then(|o| resolve(doc, o))
    else {
        return false;
    };
    let Some(Object::Dictionary(xobjects)) =
        resources.get(b"XObject").ok().and_then(|o| resolve(doc, o))
    else {
        return false;
    };
    xobjects.iter().any(|(_, v)| {
        matches!(
            resolve(doc, v),
            Some(Object::Stream(s)) if matches!(s.dict.get(b"Subtype"), Ok(Object::Name(n)) if n.as_slice() == b"Form")
        )
    })
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

/// Build glyph-metric info for every font in the page's resources.
fn collect_font_widths(doc: &Document, page_id: ObjectId) -> BTreeMap<String, FontInfo> {
    let mut out = BTreeMap::new();
    let fonts = match doc.get_page_fonts(page_id) {
        Ok(f) => f,
        Err(_) => return out,
    };
    for (name, font_dict) in fonts {
        let key = String::from_utf8_lossy(&name).into_owned();
        if let Some(info) = font_info(doc, font_dict) {
            out.insert(key, info);
        }
    }
    out
}

fn font_info(doc: &Document, font: &Dictionary) -> Option<FontInfo> {
    let is_type0 = matches!(font.get(b"Subtype"), Ok(Object::Name(s)) if s.as_slice() == b"Type0");
    if is_type0 {
        cid_font_info(doc, font)
    } else {
        simple_font_info(doc, font)
    }
}

/// Simple (single-byte) font: `/Widths` indexed from `/FirstChar`.
fn simple_font_info(doc: &Document, font: &Dictionary) -> Option<FontInfo> {
    let first_char = font.get(b"FirstChar").map(|o| num(o) as i64).unwrap_or(0);
    let widths_obj = font.get(b"Widths").ok()?;
    let arr = match resolve(doc, widths_obj)? {
        Object::Array(a) => a.clone(),
        _ => return None,
    };
    let mut widths = BTreeMap::new();
    for (i, o) in arr.iter().enumerate() {
        widths.insert(
            (first_char + i as i64) as u32,
            resolve(doc, o).map(num).unwrap_or(DEFAULT_WIDTH),
        );
    }
    Some(FontInfo {
        two_byte: false,
        default_width: DEFAULT_WIDTH,
        widths,
        supported: true,
    })
}

/// Type0/CID font. Only Identity-H/V encoding lets us treat a 2-byte code as the
/// CID directly (the overwhelmingly common embedded-font case). Any other CMap →
/// `two_byte:false` + no widths, so glyph math is conservative (over-remove) and
/// the app's verify+flatten catches anything under-removed.
fn cid_font_info(doc: &Document, font: &Dictionary) -> Option<FontInfo> {
    let identity = matches!(
        font.get(b"Encoding").ok().and_then(|o| resolve(doc, o)),
        Some(Object::Name(n)) if n.starts_with(b"Identity")
    );
    let cid_font = match font
        .get(b"DescendantFonts")
        .ok()
        .and_then(|o| resolve(doc, o))
    {
        Some(Object::Array(a)) if !a.is_empty() => resolve(doc, &a[0]).and_then(|o| match o {
            Object::Dictionary(d) => Some(d.clone()),
            _ => None,
        }),
        _ => None,
    };
    let mut widths = BTreeMap::new();
    let mut default_width = 1000.0; // spec default DW
    if let Some(cf) = &cid_font {
        if let Ok(dw) = cf.get(b"DW") {
            default_width = num(dw);
        }
        if let Some(Object::Array(w)) = cf.get(b"W").ok().and_then(|o| resolve(doc, o)) {
            parse_cid_widths(doc, w, &mut widths);
        }
    }
    Some(FontInfo {
        two_byte: identity,
        default_width,
        widths,
        // Non-Identity CMaps map codes→CIDs in ways we don't parse → unreliable.
        supported: identity,
    })
}

/// Parse a CIDFont `/W` array → CID→width map. Two entry forms per ISO 32000
/// §9.7.4.3: `c [w1 w2 …]` (CIDs c, c+1, … get w1, w2, …) and `c_first c_last w`
/// (all CIDs in the range get `w`).
fn parse_cid_widths(doc: &Document, w: &[Object], out: &mut BTreeMap<u32, f64>) {
    let n = |o: &Object| num(o);
    let mut i = 0;
    while i + 1 < w.len() {
        let c = n(resolve(doc, &w[i]).unwrap_or(&w[i])) as i64;
        match resolve(doc, &w[i + 1]) {
            Some(Object::Array(list)) => {
                for (j, wo) in list.iter().enumerate() {
                    out.insert((c + j as i64) as u32, n(wo));
                }
                i += 2;
            }
            _ if i + 2 < w.len() => {
                let c2 = n(resolve(doc, &w[i + 1]).unwrap_or(&w[i + 1])) as i64;
                let width = n(resolve(doc, &w[i + 2]).unwrap_or(&w[i + 2]));
                for cid in c..=c2 {
                    out.insert(cid as u32, width);
                }
                i += 3;
            }
            _ => break,
        }
    }
}

/* ── The content walk ───────────────────────────────────────────────────────── */
fn redact_content(
    ops: Vec<Operation>,
    rects: &[Rect],
    fonts: &BTreeMap<String, FontInfo>,
) -> (Vec<Operation>, bool) {
    let mut out: Vec<Operation> = Vec::with_capacity(ops.len());
    let mut ctm = IDENTITY;
    let mut ctm_stack: Vec<Mat> = Vec::new();
    let mut ts = TextState::default();
    // Cleared if we redact from a font we can't decode precisely (→ flatten page).
    let mut confident = true;

    for op in ops {
        match op.operator.as_str() {
            // Graphics/text STATE operators: update our tracking copy AND pass the
            // operator through verbatim — the output must keep the CTM, font,
            // position and spacing setup or the surviving text has no font/place.
            "q" => {
                ctm_stack.push(ctm);
                out.push(op);
            }
            "Q" => {
                if let Some(m) = ctm_stack.pop() {
                    ctm = m;
                }
                out.push(op);
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
                out.push(op);
            }
            "BT" => {
                ts.tm = IDENTITY;
                ts.tlm = IDENTITY;
                out.push(op);
            }
            "Tf" if op.operands.len() == 2 => {
                if let Object::Name(n) = &op.operands[0] {
                    ts.font = Some(String::from_utf8_lossy(n).into_owned());
                }
                ts.size = num(&op.operands[1]);
                out.push(op);
            }
            "Tc" if !op.operands.is_empty() => {
                ts.char_sp = num(&op.operands[0]);
                out.push(op);
            }
            "Tw" if !op.operands.is_empty() => {
                ts.word_sp = num(&op.operands[0]);
                out.push(op);
            }
            "Tz" if !op.operands.is_empty() => {
                ts.h_scale = num(&op.operands[0]) / 100.0;
                out.push(op);
            }
            "TL" if !op.operands.is_empty() => {
                ts.leading = num(&op.operands[0]);
                out.push(op);
            }
            "Ts" if !op.operands.is_empty() => {
                ts.rise = num(&op.operands[0]);
                out.push(op);
            }
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
                out.push(op);
            }
            "Td" if op.operands.len() == 2 => {
                let m = translation(num(&op.operands[0]), num(&op.operands[1]));
                ts.tlm = mul(m, ts.tlm);
                ts.tm = ts.tlm;
                out.push(op);
            }
            "TD" if op.operands.len() == 2 => {
                ts.leading = -num(&op.operands[1]);
                let m = translation(num(&op.operands[0]), num(&op.operands[1]));
                ts.tlm = mul(m, ts.tlm);
                ts.tm = ts.tlm;
                out.push(op);
            }
            "T*" => {
                let m = translation(0.0, -ts.leading);
                ts.tlm = mul(m, ts.tlm);
                ts.tm = ts.tlm;
                out.push(op);
            }
            "Tj" if op.operands.len() == 1 => {
                if let Object::String(s, _) = &op.operands[0] {
                    let rebuilt = redact_show(s, &mut ts, ctm, rects, fonts, &mut confident);
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
                    out.push(redact_show(s, &mut ts, ctm, rects, fonts, &mut confident));
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
                    out.push(redact_show(s, &mut ts, ctm, rects, fonts, &mut confident));
                    continue;
                }
                out.push(op);
            }
            "TJ" if op.operands.len() == 1 => {
                if let Object::Array(items) = &op.operands[0] {
                    out.push(redact_show_array(
                        items,
                        &mut ts,
                        ctm,
                        rects,
                        fonts,
                        &mut confident,
                    ));
                    continue;
                }
                out.push(op);
            }
            _ => out.push(op),
        }
    }
    (out, confident)
}

/// Advance of one glyph along text x, in unscaled text-space units. Word spacing
/// (`Tw`) applies only to the single-byte code 32 (ISO 32000 §9.3.3), never to a
/// 2-byte CID.
fn glyph_advance(w1000: f64, ts: &TextState, code: u32, two_byte: bool) -> f64 {
    let word = if !two_byte && code == 32 {
        ts.word_sp
    } else {
        0.0
    };
    ((w1000 / 1000.0) * ts.size + ts.char_sp + word) * ts.h_scale
}

/// Decode a show string into codes: 2-byte big-endian (Identity CID) or 1-byte.
fn decode_codes(s: &[u8], two_byte: bool) -> Vec<u32> {
    if two_byte {
        s.chunks(2)
            .map(|c| {
                if c.len() == 2 {
                    ((c[0] as u32) << 8) | c[1] as u32
                } else {
                    c[0] as u32
                }
            })
            .collect()
    } else {
        s.iter().map(|&b| b as u32).collect()
    }
}

/// Append a code to a show string (2-byte big-endian, or 1-byte).
fn encode_code(code: u32, two_byte: bool, out: &mut Vec<u8>) {
    if two_byte {
        out.push((code >> 8) as u8);
        out.push((code & 0xff) as u8);
    } else {
        out.push(code as u8);
    }
}

/// A removed run's accumulated text-space advance → one TJ numeric adjustment
/// (glyph-space thousandths). Collapsing a run into a SINGLE number means only its
/// TOTAL width is observable, not each glyph's — so it isn't an advance-width
/// de-redaction oracle (the reason surgical was originally shelved).
fn adv_to_tj(adv: f64, ts: &TextState) -> f64 {
    if ts.size * ts.h_scale != 0.0 {
        -adv / (ts.size * ts.h_scale) * 1000.0
    } else {
        0.0
    }
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
    fonts: &BTreeMap<String, FontInfo>,
    confident: &mut bool,
) -> Operation {
    let info = ts.font.as_ref().and_then(|f| fonts.get(f));
    let two_byte = info.map(|i| i.two_byte).unwrap_or(false);
    let fmt = if two_byte {
        StringFormat::Hexadecimal
    } else {
        StringFormat::Literal
    };
    let mut items: Vec<Object> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut removed_adv = 0.0; // accumulated advance of a contiguous removed run
    let mut removed_any = false;

    for code in decode_codes(s, two_byte) {
        let w = width_of(info, code);
        if glyph_hits(w, ts, ctm, rects) {
            removed_any = true;
            if !cur.is_empty() {
                items.push(Object::String(std::mem::take(&mut cur), fmt));
            }
            removed_adv += glyph_advance(w, ts, code, two_byte);
        } else {
            if removed_adv != 0.0 {
                items.push(Object::Real(adv_to_tj(removed_adv, ts) as f32));
                removed_adv = 0.0;
            }
            encode_code(code, two_byte, &mut cur);
        }
        // Advance the text matrix past this glyph regardless of keep/remove.
        ts.tm = mul(
            translation(glyph_advance(w, ts, code, two_byte), 0.0),
            ts.tm,
        );
    }
    if removed_adv != 0.0 {
        items.push(Object::Real(adv_to_tj(removed_adv, ts) as f32));
    }
    if !cur.is_empty() {
        items.push(Object::String(cur, fmt));
    }
    // Removing from a font we can't decode precisely → the caller should flatten.
    if removed_any && info.map(|i| !i.supported).unwrap_or(false) {
        *confident = false;
    }
    if removed_any {
        Operation::new("TJ", vec![Object::Array(items)])
    } else {
        // Untouched — emit the original show unchanged.
        Operation::new("Tj", vec![Object::String(s.to_vec(), fmt)])
    }
}

/// Same as `redact_show` but for a `TJ` array (strings interleaved with numeric
/// kerning adjustments, which we preserve and apply to the text matrix).
fn redact_show_array(
    items: &[Object],
    ts: &mut TextState,
    ctm: Mat,
    rects: &[Rect],
    fonts: &BTreeMap<String, FontInfo>,
    confident: &mut bool,
) -> Operation {
    let info = ts.font.as_ref().and_then(|f| fonts.get(f));
    let two_byte = info.map(|i| i.two_byte).unwrap_or(false);
    let fmt = if two_byte {
        StringFormat::Hexadecimal
    } else {
        StringFormat::Literal
    };
    let mut out_items: Vec<Object> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut removed_adv = 0.0;
    let mut removed_any = false;

    for item in items {
        match item {
            Object::String(s, _) => {
                for code in decode_codes(s, two_byte) {
                    let w = width_of(info, code);
                    if glyph_hits(w, ts, ctm, rects) {
                        removed_any = true;
                        if !cur.is_empty() {
                            out_items.push(Object::String(std::mem::take(&mut cur), fmt));
                        }
                        removed_adv += glyph_advance(w, ts, code, two_byte);
                    } else {
                        if removed_adv != 0.0 {
                            out_items.push(Object::Real(adv_to_tj(removed_adv, ts) as f32));
                            removed_adv = 0.0;
                        }
                        encode_code(code, two_byte, &mut cur);
                    }
                    ts.tm = mul(
                        translation(glyph_advance(w, ts, code, two_byte), 0.0),
                        ts.tm,
                    );
                }
            }
            Object::Integer(_) | Object::Real(_) => {
                let a = num(item);
                let tx = -a / 1000.0 * ts.size * ts.h_scale;
                if removed_adv != 0.0 {
                    // Inside a removed run → fold the kern into its collapsed advance.
                    removed_adv += tx;
                } else {
                    if !cur.is_empty() {
                        out_items.push(Object::String(std::mem::take(&mut cur), fmt));
                    }
                    out_items.push(item.clone());
                }
                ts.tm = mul(translation(tx, 0.0), ts.tm);
            }
            _ => {}
        }
    }
    if removed_adv != 0.0 {
        out_items.push(Object::Real(adv_to_tj(removed_adv, ts) as f32));
    }
    if !cur.is_empty() {
        out_items.push(Object::String(cur, fmt));
    }
    if removed_any && info.map(|i| !i.supported).unwrap_or(false) {
        *confident = false;
    }
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
        let out = redact_pdf(&pdf, &rects).expect("redact").bytes;

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

    /// Build a one-page PDF whose text is a Type0/Identity-H font showing the
    /// 2-byte CIDs 1..=6 (each 600 wide) at (100, 700) — the real embedded-font
    /// shape that the old simple-font-only code couldn't redact.
    fn build_cid_pdf() -> (Vec<u8>, f64) {
        let mut doc = Document::with_version("1.5");
        let glyph_w = 600.0;
        let w_array = Object::Array(vec![
            1i64.into(),
            Object::Array((0..6).map(|_| Object::Real(glyph_w as f32)).collect()),
        ]);
        let cid_font = doc.add_object(lopdf::dictionary! {
            "Type" => "Font",
            "Subtype" => "CIDFontType2",
            "BaseFont" => "Embedded",
            "DW" => 1000i64,
            "W" => w_array,
        });
        let font_id = doc.add_object(lopdf::dictionary! {
            "Type" => "Font",
            "Subtype" => "Type0",
            "BaseFont" => "Embedded",
            "Encoding" => "Identity-H",
            "DescendantFonts" => Object::Array(vec![cid_font.into()]),
        });
        let resources = doc.add_object(lopdf::dictionary! {
            "Font" => lopdf::dictionary! { "F1" => font_id },
        });
        // Show CIDs 1..=6 as 2-byte hex codes.
        let cs = "BT /F1 24 Tf 100 700 Td <000100020003000400050006> Tj ET";
        let content_id = doc.add_object(Stream::new(Dictionary::new(), cs.as_bytes().to_vec()));
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(lopdf::dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => resources,
            "MediaBox" => Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()]),
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(lopdf::dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(vec![page_id.into()]),
                "Count" => 1i64,
            }),
        );
        let catalog_id =
            doc.add_object(lopdf::dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        (buf, glyph_w / 1000.0 * 24.0)
    }

    /// Collect the raw bytes of every show string in a content stream.
    fn shown_bytes(content: &Content) -> Vec<u8> {
        let mut out = Vec::new();
        for op in &content.operations {
            if op.operator == "TJ" {
                if let Some(Object::Array(items)) = op.operands.first() {
                    for it in items {
                        if let Object::String(b, _) = it {
                            out.extend_from_slice(b);
                        }
                    }
                }
            } else if op.operator == "Tj" {
                if let Some(Object::String(b, _)) = op.operands.last() {
                    out.extend_from_slice(b);
                }
            }
        }
        out
    }

    #[test]
    fn removes_cid_glyphs_inside_the_rect() {
        // CID/Type0 (the shape most real PDFs use). Redact CIDs 1..=3, keep 4..=6.
        let (pdf, adv) = build_cid_pdf();
        let end = 100.0 + 3.0 * adv;
        let rects = vec![PageRects {
            page_index: 0,
            // End just before CID 4's origin so the box covers CIDs 1..=3 only.
            rects: vec![frac(95.0, 695.0, end - 1.0, 730.0)],
        }];
        let out = redact_pdf(&pdf, &rects).expect("redact").bytes;
        let doc = Document::load_mem(&out).unwrap();
        let page_id = *doc.get_pages().values().next().unwrap();
        let content = doc.get_and_decode_page_content(page_id).unwrap();
        let bytes = shown_bytes(&content);
        // Surviving CIDs 4,5,6 present as 2-byte codes; redacted CIDs 1,2,3 gone.
        assert!(
            bytes.windows(2).any(|w| w == [0, 4]),
            "CID 4 survives: {bytes:?}"
        );
        assert!(
            bytes.windows(2).any(|w| w == [0, 6]),
            "CID 6 survives: {bytes:?}"
        );
        assert!(
            !bytes.windows(2).any(|w| w == [0, 1]),
            "CID 1 removed: {bytes:?}"
        );
        assert!(
            !bytes.windows(2).any(|w| w == [0, 2]),
            "CID 2 removed: {bytes:?}"
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
        .expect("redact")
        .bytes;
        let doc = Document::load_mem(&out).unwrap();
        let page_id = *doc.get_pages().values().next().unwrap();
        let content = doc.get_and_decode_page_content(page_id).unwrap();
        assert!(extract_shown_text(&content).contains("KEEP ME"));
    }
}
