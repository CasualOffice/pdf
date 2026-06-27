// Diff two page renders (web vs native) and gate on a mismatch threshold.
// Normalises both to the same pixel grid first (sub-pixel rasteriser
// differences between the WASM and native PDFium builds are expected; gross
// fidelity divergence is not). Exits non-zero if over threshold.
//
// Usage: node compare.mjs <a.png> <b.png> <diff.png> [maxRatio]
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';

const [, , aPath, bPath, diffPath, maxRatioStr] = process.argv;
const maxRatio = Number(maxRatioStr ?? '0.02'); // 2% of pixels may differ

if (!aPath || !bPath || !diffPath) {
  console.error('usage: compare.mjs <a.png> <b.png> <diff.png> [maxRatio]');
  process.exit(2);
}

// Decode both via sharp (format-agnostic — the web side is a raw engine blob)
// and normalise B to A's pixel grid so a width/DPR mismatch doesn't dominate.
const meta = await sharp(aPath).metadata();
const { width, height } = meta;
const a = await sharp(aPath).ensureAlpha().raw().toBuffer();
const b = await sharp(bPath).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();

const diff = new PNG({ width, height });
const mismatched = pixelmatch(a, b, diff.data, width, height, {
  threshold: 0.1,
  includeAA: false,
});
writeFileSync(diffPath, PNG.sync.write(diff));

const ratio = mismatched / (width * height);
const pct = (ratio * 100).toFixed(3);
console.log(`diff: ${mismatched}/${width * height} px (${pct}%) — threshold ${(maxRatio * 100).toFixed(2)}%`);
console.log(`diff image: ${diffPath}`);

if (ratio > maxRatio) {
  console.error(`FAIL: render parity ${pct}% over ${(maxRatio * 100).toFixed(2)}% threshold`);
  process.exit(1);
}
console.log('PASS: web and native renders are within parity threshold');
