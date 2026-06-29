// Build a fixture that exercises page geometry redaction must preserve:
//   page 0 — /Rotate 90 (portrait MediaBox, landscape display) + text
//   page 1 — non-zero MediaBox origin (36,36) + text
// Run from packages/pdf-sdk so pdf-lib resolves:
//   (cd packages/pdf-sdk && node ../../tools/render-parity/make-geom-fixture.mjs)
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

// Page 0: rotated 90°. MediaBox stays portrait; /Rotate makes it display landscape.
const p0 = doc.addPage([612, 792]);
p0.setRotation(degrees(90));
p0.drawText('ROTATED quick brown fox', { x: 72, y: 700, size: 24, font, color: rgb(0, 0, 0) });
p0.drawText('second line render parity', { x: 72, y: 660, size: 18, font, color: rgb(0.1, 0.1, 0.6) });

// Page 1: non-zero MediaBox origin. Content positioned in that shifted space.
const p1 = doc.addPage([612, 792]);
p1.setMediaBox(36, 36, 540, 720); // origin (36,36)
p1.drawText('OFFSET secret public text', { x: 80, y: 600, size: 22, font, color: rgb(0, 0, 0) });

const bytes = await doc.save();
writeFileSync(new URL('./fixtures/geom.pdf', import.meta.url), bytes);
console.log('wrote fixtures/geom.pdf', bytes.length, 'bytes');
