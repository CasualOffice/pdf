// Generate the deterministic UX-F1 fixture PDF. Run once; the output is
// committed as fixtures/sample.pdf so web and native render the same bytes.
// Uses only PDF standard (non-embedded) fonts so the comparison exercises
// PDFium's own font handling identically on both sides.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const doc = await PDFDocument.create();
// Deterministic metadata so the bytes are stable across regenerations.
doc.setCreationDate(new Date(0));
doc.setModificationDate(new Date(0));
doc.setTitle('Casual PDF render-parity fixture');

const page = doc.addPage([612, 792]); // US Letter
const helv = await doc.embedFont(StandardFonts.Helvetica);
const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

page.drawRectangle({ x: 0, y: 692, width: 612, height: 100, color: rgb(0.12, 0.16, 0.45) });
page.drawText('Casual PDF', { x: 40, y: 740, size: 36, font: helvBold, color: rgb(1, 1, 1) });
page.drawText('UX-F1 render-parity fixture', { x: 40, y: 712, size: 14, font: helv, color: rgb(0.85, 0.88, 1) });

page.drawText('The quick brown fox jumps over the lazy dog.', {
  x: 40, y: 640, size: 18, font: helv, color: rgb(0.1, 0.1, 0.1),
});
page.drawText('0123456789  AaBbCcDdEeFf  .,:;!?()[]{}', {
  x: 40, y: 612, size: 14, font: helv, color: rgb(0.2, 0.2, 0.2),
});

// Vector shapes — exercise fills, strokes, and curves.
page.drawRectangle({ x: 40, y: 460, width: 120, height: 90, color: rgb(0.92, 0.26, 0.21) });
page.drawCircle({ x: 260, y: 505, size: 50, color: rgb(0.15, 0.68, 0.38) });
page.drawLine({ start: { x: 360, y: 460 }, end: { x: 540, y: 550 }, thickness: 4, color: rgb(0.1, 0.45, 0.9) });
page.drawEllipse({ x: 460, y: 500, xScale: 70, yScale: 35, borderColor: rgb(0.4, 0.2, 0.6), borderWidth: 3, color: rgb(1, 1, 1) });

for (let i = 0; i < 6; i++) {
  page.drawText(`Body line ${i + 1}: render parity must hold across the whole page.`, {
    x: 40, y: 400 - i * 22, size: 12, font: helv, color: rgb(0.15, 0.15, 0.15),
  });
}

const bytes = await doc.save({ useObjectStreams: false });
mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
writeFileSync(new URL('./fixtures/sample.pdf', import.meta.url), bytes);
console.log(`wrote fixtures/sample.pdf (${bytes.length} bytes)`);
