import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `PAGES_BASE` lets the GitHub Pages workflow build for a sub-path without
// committing it; local dev and custom-domain deploys stay at `/`.
const base = process.env.PAGES_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
});
