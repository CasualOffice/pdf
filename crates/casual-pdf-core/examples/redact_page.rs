// Debug/demo: surgically redact one fractional rect on one page and write the
// result. Usage: redact_page <in.pdf> <page> <x> <y> <w> <h> <out.pdf>
use casual_pdf_core::redact::{redact_pdf, FracRect, PageRects};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 8 {
        eprintln!("usage: redact_page <in.pdf> <page> <x> <y> <w> <h> <out.pdf>");
        std::process::exit(2);
    }
    let bytes = std::fs::read(&a[1]).expect("read input");
    let page: usize = a[2].parse().unwrap();
    let f = |i: usize| a[i].parse::<f64>().unwrap();
    let r = FracRect {
        x: f(3),
        y: f(4),
        w: f(5),
        h: f(6),
    };
    let out = redact_pdf(
        &bytes,
        &[PageRects {
            page_index: page,
            rects: vec![r],
        }],
    )
    .expect("redact");
    std::fs::write(&a[7], &out.bytes).expect("write output");
    eprintln!(
        "wrote {} ({} bytes, low-confidence pages: {:?})",
        a[7],
        out.bytes.len(),
        out.low_confidence_pages
    );
}
