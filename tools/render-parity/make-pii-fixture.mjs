// Build a fixture with structured PII on page 0 for the AI-redaction E2E.
// Run from packages/pdf-sdk so pdf-lib resolves:
//   (cd packages/pdf-sdk && node ../../tools/render-parity/make-pii-fixture.mjs)
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

const p0 = doc.addPage([612, 792]);
const line = (y, t) => p0.drawText(t, { x: 72, y, size: 16, font, color: rgb(0, 0, 0) });
line(720, 'Customer record');
line(690, 'Card: 4111 1111 1111 1111'); // Luhn-valid Visa test number
line(660, 'SSN: 123-45-6789');
line(630, 'Email: test@example.com');
line(600, 'Aadhaar: 2995 5670 5675'); // Verhoeff-valid
line(560, 'Notes: nothing sensitive on this line');

const bytes = await doc.save();
writeFileSync(new URL('./fixtures/pii.pdf', import.meta.url), bytes);
console.log('wrote fixtures/pii.pdf', bytes.length, 'bytes');
