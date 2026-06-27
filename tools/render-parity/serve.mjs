// Minimal static file server for the harness — serves the built web app + the
// fixture so the viewer can fetch a same-origin `?src=`. Not for production.
// Usage: node serve.mjs <rootDir> <port>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const root = process.argv[2];
const port = Number(process.argv[3] || 8099);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html';
    // Prevent path traversal.
    const filePath = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(filePath);
    res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://127.0.0.1:${port}`));
