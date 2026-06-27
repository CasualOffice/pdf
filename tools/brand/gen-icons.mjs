// Generate raster favicon/app-icon assets from the source logo.svg.
// SVG is the source of truth; these are committed outputs so the deploy serves
// them without a build step. Run: npm install && node gen-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const PUB = fileURLToPath(new URL('../../apps/web/public/', import.meta.url));
const svg = readFileSync(PUB + 'logo.svg');

// favicon.svg = the logo, used directly by modern browsers.
writeFileSync(PUB + 'favicon.svg', svg);

const png = (size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

const p32 = await png(32);
writeFileSync(PUB + 'favicon-32.png', p32);
writeFileSync(PUB + 'apple-touch-icon.png', await png(180));

// favicon.ico — a single 32×32 PNG wrapped in an ICO container (PNG-in-ICO is
// supported by all current browsers and kills the legacy /favicon.ico request).
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(1, 4); // count
const entry = Buffer.alloc(16);
entry.writeUInt8(32, 0); // width
entry.writeUInt8(32, 1); // height
entry.writeUInt8(0, 2); // palette
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(p32.length, 8); // size
entry.writeUInt32LE(22, 12); // offset (6 + 16)
writeFileSync(PUB + 'favicon.ico', Buffer.concat([dir, entry, p32]));

console.log('wrote favicon.svg, favicon-32.png, apple-touch-icon.png, favicon.ico');
