// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

//! Tier-2 building block: editing **existing** page text.
//!
//! PDF isn't a reflowable format — text is positioned glyphs, not paragraphs —
//! so this is the scoped, honest version of "true text editing": locate the
//! text-show operators on a page (each with its position, size and colour for an
//! edit overlay), then **replace** a chosen run's string, or **move** it to a new
//! position, by rewriting that operator in the content stream. No reflow: editing
//! a run changes its own text/position; neighbours stay put (like editing a label
//! in Acrobat).
//!
//! Pure `lopdf` → native + wasm32, same as `redact`. Scope of this version:
//! single-byte (simple) fonts; the replacement text is encoded as Latin-1/WinAnsi
//! (ASCII is exact). Subsetted fonts may lack glyphs for newly-typed characters —
//! a documented limitation. Shares the matrix/text-state walk shape with
//! `redact`; a future `content` module will unify them.

use lopdf::content::{Content, Operation};
use lopdf::{Document, Object, ObjectId, StringFormat};

#[derive(Debug)]
pub enum EditError {
    Parse(String),
    Save(String),
    NotFound,
}

impl std::fmt::Display for EditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EditError::Parse(s) => write!(f, "text-edit parse error: {s}"),
            EditError::Save(s) => write!(f, "text-edit save error: {s}"),
            EditError::NotFound => write!(f, "text run not found"),
        }
    }
}
impl std::error::Error for EditError {}

/// One editable text run on a page (a single show operator).
#[derive(Debug, Clone)]
pub struct TextRun {
    /// 0-based index of this show operator among the page's show operators —
    /// stable across a re-parse of the same bytes, used to target an edit.
    pub id: usize,
    pub text: String,
    /// Baseline origin in PDF user space (bottom-left origin).
    pub x: f64,
    pub y: f64,
    /// Approximate rendered width/height in user space (UI overlay hint only).
    pub width: f64,
    pub height: f64,
    pub font_size: f64,
    /// Fill colour as RGB 0..1 (text is painted with the fill colour).
    pub color: [f64; 3],
}

/// Serialize runs to a JSON array (avoids a serde dependency in the wasm build).
pub fn runs_json(runs: &[TextRun]) -> String {
    let esc = |s: &str| -> String {
        let mut o = String::with_capacity(s.len() + 2);
        for c in s.chars() {
            match c {
                '"' => o.push_str("\\\""),
                '\\' => o.push_str("\\\\"),
                '\n' => o.push_str("\\n"),
                '\r' => o.push_str("\\r"),
                '\t' => o.push_str("\\t"),
                c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
                c => o.push(c),
            }
        }
        o
    };
    let mut s = String::from("[");
    for (i, r) in runs.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"id\":{},\"text\":\"{}\",\"x\":{},\"y\":{},\"width\":{},\"height\":{},\"fontSize\":{},\"color\":[{},{},{}]}}",
            r.id, esc(&r.text), r.x, r.y, r.width, r.height, r.font_size, r.color[0], r.color[1], r.color[2]
        ));
    }
    s.push(']');
    s
}

/* ── minimal affine + text-state walk (see module note re: future unification) ── */
type Mat = [f64; 6];
const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

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

/// Decode a show string to display text (Latin-1/WinAnsi best effort).
fn decode(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// Concatenate the strings in a `TJ` array (ignoring kerning numbers).
fn decode_tj(items: &[Object]) -> String {
    let mut s = String::new();
    for it in items {
        if let Object::String(b, _) = it {
            s.push_str(&decode(b));
        }
    }
    s
}

/// Approximate advance of a run in unscaled text units (0.5em/glyph heuristic —
/// the exact glyph metrics aren't needed; this only sizes the edit overlay and
/// advances `tm` for consecutive shows).
fn approx_advance(text: &str, size: f64) -> f64 {
    text.chars().count() as f64 * 0.5 * size
}

fn page_ids(doc: &Document) -> Vec<ObjectId> {
    doc.get_pages().into_values().collect()
}

/// List the editable text runs on a page (for hit-testing + overlay placement).
pub fn list_text_runs(pdf: &[u8], page_index: usize) -> Result<Vec<TextRun>, EditError> {
    let doc = Document::load_mem(pdf).map_err(|e| EditError::Parse(e.to_string()))?;
    let page_id = *page_ids(&doc).get(page_index).ok_or(EditError::NotFound)?;
    let content = doc
        .get_and_decode_page_content(page_id)
        .map_err(|e| EditError::Parse(e.to_string()))?;

    let mut runs = Vec::new();
    let mut ctm = IDENTITY;
    let mut ctm_stack: Vec<Mat> = Vec::new();
    let mut tm = IDENTITY;
    let mut tlm = IDENTITY;
    let mut size = 0.0;
    let mut leading = 0.0;
    let mut color = [0.0, 0.0, 0.0];
    let mut show_index = 0usize;

    for op in &content.operations {
        match op.operator.as_str() {
            "q" => ctm_stack.push(ctm),
            "Q" => {
                if let Some(m) = ctm_stack.pop() {
                    ctm = m;
                }
            }
            "cm" if op.operands.len() == 6 => {
                let m: Mat = mat6(&op.operands);
                ctm = mul(m, ctm);
            }
            "BT" => {
                tm = IDENTITY;
                tlm = IDENTITY;
            }
            "Tf" if op.operands.len() == 2 => size = num(&op.operands[1]),
            "TL" if !op.operands.is_empty() => leading = num(&op.operands[0]),
            "rg" if op.operands.len() == 3 => {
                color = [
                    num(&op.operands[0]),
                    num(&op.operands[1]),
                    num(&op.operands[2]),
                ]
            }
            "g" if op.operands.len() == 1 => {
                let v = num(&op.operands[0]);
                color = [v, v, v];
            }
            "Tm" if op.operands.len() == 6 => {
                tm = mat6(&op.operands);
                tlm = tm;
            }
            "Td" | "TD" if op.operands.len() == 2 => {
                if op.operator == "TD" {
                    leading = -num(&op.operands[1]);
                }
                tlm = mul(translation(num(&op.operands[0]), num(&op.operands[1])), tlm);
                tm = tlm;
            }
            "T*" => {
                tlm = mul(translation(0.0, -leading), tlm);
                tm = tlm;
            }
            "Tj" if op.operands.len() == 1 => {
                if let Object::String(b, _) = &op.operands[0] {
                    tm = record_run(&mut runs, decode(b), tm, ctm, size, color, show_index);
                }
                show_index += 1;
            }
            "'" if op.operands.len() == 1 => {
                tlm = mul(translation(0.0, -leading), tlm);
                tm = tlm;
                if let Object::String(b, _) = &op.operands[0] {
                    tm = record_run(&mut runs, decode(b), tm, ctm, size, color, show_index);
                }
                show_index += 1;
            }
            "\"" if op.operands.len() == 3 => {
                tlm = mul(translation(0.0, -leading), tlm);
                tm = tlm;
                if let Object::String(b, _) = &op.operands[2] {
                    tm = record_run(&mut runs, decode(b), tm, ctm, size, color, show_index);
                }
                show_index += 1;
            }
            "TJ" if op.operands.len() == 1 => {
                if let Object::Array(items) = &op.operands[0] {
                    tm = record_run(
                        &mut runs,
                        decode_tj(items),
                        tm,
                        ctm,
                        size,
                        color,
                        show_index,
                    );
                }
                show_index += 1;
            }
            _ => {}
        }
    }
    Ok(runs)
}

/// Push a run for the text shown at `tm`·`ctm`, returning `tm` advanced past it.
#[allow(clippy::too_many_arguments)]
fn record_run(
    runs: &mut Vec<TextRun>,
    text: String,
    tm: Mat,
    ctm: Mat,
    size: f64,
    color: [f64; 3],
    id: usize,
) -> Mat {
    let to_page = mul(tm, ctm);
    let (x, y) = apply(to_page, 0.0, 0.0);
    let adv = approx_advance(&text, size);
    if !text.is_empty() {
        runs.push(TextRun {
            id,
            text,
            x,
            y,
            width: adv * scale_x(to_page),
            height: size.max(1.0),
            font_size: size,
            color,
        });
    }
    mul(translation(adv, 0.0), tm)
}
fn scale_x(m: Mat) -> f64 {
    (m[0] * m[0] + m[1] * m[1]).sqrt()
}
fn mat6(o: &[Object]) -> Mat {
    [
        num(&o[0]),
        num(&o[1]),
        num(&o[2]),
        num(&o[3]),
        num(&o[4]),
        num(&o[5]),
    ]
}

/// True for the show operators we count/target.
fn is_show(op: &Operation) -> bool {
    matches!(op.operator.as_str(), "Tj" | "TJ" | "'" | "\"")
}

/// Rewrite the page content, applying `f` to the `target`-th show operator.
fn rewrite_show<F: Fn(&Operation) -> Vec<Operation>>(
    pdf: &[u8],
    page_index: usize,
    target: usize,
    f: F,
) -> Result<Vec<u8>, EditError> {
    let mut doc = Document::load_mem(pdf).map_err(|e| EditError::Parse(e.to_string()))?;
    let page_id = *page_ids(&doc).get(page_index).ok_or(EditError::NotFound)?;
    let content = doc
        .get_and_decode_page_content(page_id)
        .map_err(|e| EditError::Parse(e.to_string()))?;

    let mut out = Vec::with_capacity(content.operations.len());
    let mut idx = 0usize;
    let mut hit = false;
    for op in content.operations {
        if is_show(&op) {
            if idx == target {
                out.extend(f(&op));
                hit = true;
            } else {
                out.push(op);
            }
            idx += 1;
        } else {
            out.push(op);
        }
    }
    if !hit {
        return Err(EditError::NotFound);
    }
    let encoded = Content { operations: out }
        .encode()
        .map_err(|e| EditError::Save(e.to_string()))?;
    doc.change_page_content(page_id, encoded)
        .map_err(|e| EditError::Save(e.to_string()))?;
    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| EditError::Save(e.to_string()))?;
    Ok(buf)
}

/// Replace the text of run `run_id` on `page_index` with `new_text`.
pub fn edit_text_run(
    pdf: &[u8],
    page_index: usize,
    run_id: usize,
    new_text: &str,
) -> Result<Vec<u8>, EditError> {
    let bytes: Vec<u8> = new_text.chars().map(|c| c as u8).collect(); // Latin-1/WinAnsi
    rewrite_show(pdf, page_index, run_id, |orig| {
        // Preserve the original operator kind where it matters ('/" do a line
        // move first); emit a plain show of the new string.
        let show = Object::String(bytes.clone(), StringFormat::Literal);
        match orig.operator.as_str() {
            "'" => vec![Operation::new("'", vec![show])],
            "\"" => vec![Operation::new(
                "\"",
                vec![orig.operands[0].clone(), orig.operands[1].clone(), show],
            )],
            _ => vec![Operation::new("Tj", vec![show])],
        }
    })
}

/// Move run `run_id` by `(dx, dy)` in user space, isolating the shift to that run
/// (wrap it in `dx dy Td … -dx -dy Td` so following text in the same block is
/// unaffected).
pub fn move_text_run(
    pdf: &[u8],
    page_index: usize,
    run_id: usize,
    dx: f64,
    dy: f64,
) -> Result<Vec<u8>, EditError> {
    rewrite_show(pdf, page_index, run_id, |orig| {
        vec![
            Operation::new("Td", vec![Object::Real(dx as f32), Object::Real(dy as f32)]),
            orig.clone(),
            Operation::new(
                "Td",
                vec![Object::Real(-dx as f32), Object::Real(-dy as f32)],
            ),
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Dictionary, Stream};

    fn build(text: &str) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let font = doc
            .add_object(dictionary! { "Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica" });
        let resources = doc.add_object(dictionary! { "Font"=>dictionary!{ "F1"=>font } });
        let cs = format!("BT /F1 18 Tf 0 0 0 rg 1 0 0 1 72 700 Tm ({text}) Tj ET");
        let content = doc.add_object(Stream::new(Dictionary::new(), cs.into_bytes()));
        let pages_id = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type"=>"Page","Parent"=>pages_id,"Contents"=>content,"Resources"=>resources,
            "MediaBox"=>Object::Array(vec![0.into(),0.into(),612.into(),792.into()]),
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type"=>"Pages","Kids"=>Object::Array(vec![page.into()]),"Count"=>1i64,
            }),
        );
        let cat = doc.add_object(dictionary! { "Type"=>"Catalog","Pages"=>pages_id });
        doc.trailer.set("Root", cat);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    fn shown(pdf: &[u8]) -> String {
        let doc = Document::load_mem(pdf).unwrap();
        let pid = *doc.get_pages().values().next().unwrap();
        let c = doc.get_and_decode_page_content(pid).unwrap();
        let mut s = String::new();
        for op in &c.operations {
            match op.operator.as_str() {
                "Tj" | "'" => {
                    if let Some(Object::String(b, _)) = op.operands.last() {
                        s.push_str(&decode(b));
                    }
                }
                "TJ" => {
                    if let Some(Object::Array(items)) = op.operands.first() {
                        s.push_str(&decode_tj(items));
                    }
                }
                _ => {}
            }
        }
        s
    }

    #[test]
    fn lists_one_run_with_position() {
        let pdf = build("Hello World");
        let runs = list_text_runs(&pdf, 0).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].text, "Hello World");
        assert!((runs[0].x - 72.0).abs() < 0.01 && (runs[0].y - 700.0).abs() < 0.01);
        assert!((runs[0].font_size - 18.0).abs() < 0.01);
    }

    #[test]
    fn edits_a_run() {
        let pdf = build("Old Text");
        let out = edit_text_run(&pdf, 0, 0, "New Text!").unwrap();
        let s = shown(&out);
        assert!(s.contains("New Text!") && !s.contains("Old"), "got {s:?}");
    }

    #[test]
    fn moves_a_run() {
        let pdf = build("Move me");
        let out = move_text_run(&pdf, 0, 0, 50.0, -20.0).unwrap();
        // Text still present; a Td now precedes the show.
        assert!(shown(&out).contains("Move me"));
        let doc = Document::load_mem(&out).unwrap();
        let pid = *doc.get_pages().values().next().unwrap();
        let c = doc.get_and_decode_page_content(pid).unwrap();
        let tds = c.operations.iter().filter(|o| o.operator == "Td").count();
        assert!(tds >= 2, "expected wrapping Td ops");
    }

    #[test]
    fn missing_run_errors() {
        let pdf = build("x");
        assert!(matches!(
            edit_text_run(&pdf, 0, 9, "y"),
            Err(EditError::NotFound)
        ));
    }
}
