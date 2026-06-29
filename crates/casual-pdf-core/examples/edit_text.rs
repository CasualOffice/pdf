// SPIKE (Tier-2 text editing): does PDFium's text-object edit → regenerate →
// save round-trip work reliably on a real document? Replaces `find` with
// `replace` in every text object on page 0, regenerates the content stream, and
// writes the result. Reports counts; the caller verifies the output isn't
// corrupted (re-extract text / re-render).
//
// Usage: edit_text <in.pdf> <find> <replace> <out.pdf>
use pdfium_render::prelude::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 {
        eprintln!("usage: edit_text <in.pdf> <find> <replace> <out.pdf>");
        std::process::exit(2);
    }
    let (inp, find, repl, outp) = (&args[1], &args[2], &args[3], &args[4]);
    let pdfium = casual_pdf_core::bind_pdfium()?;
    let bytes = std::fs::read(inp)?;
    let doc = pdfium.load_pdf_from_byte_slice(&bytes, None)?;

    let mut edited = 0usize;
    {
        let mut page = doc.pages().get(0)?;
        let count = page.objects().len();
        for i in 0..count {
            let mut obj = match page.objects().get(i) {
                Ok(o) => o,
                Err(_) => continue,
            };
            if let Some(t) = obj.as_text_object_mut() {
                let s = t.text();
                if s.contains(find.as_str()) {
                    t.set_text(s.replace(find.as_str(), repl.as_str()))?;
                    edited += 1;
                }
            }
        }
        page.regenerate_content()?;
    }

    let out = doc.save_to_bytes()?;
    std::fs::write(outp, &out)?;
    eprintln!("edited {edited} text object(s); wrote {outp} ({} bytes)", out.len());
    Ok(())
}
