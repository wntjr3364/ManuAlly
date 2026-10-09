// Web app dev server and build. In development the API runs separately on loopback and is reached
// through this proxy, so the browser sees a single origin (cookies are SameSite=Strict).
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  root: here,
  oxc: { jsx: { runtime: 'automatic' } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env.PW_API_URL ?? 'http://127.0.0.1:8787' } },
    // serve only the web app, the shared editor package and installed dependencies — not the rest
    // of the repository (docs, reports, other sources) through /@fs/
    fs: { strict: true, allow: [here, `${repo}packages/editor-core`, `${repo}node_modules`], deny: ['.env', '.env.*', '*.{crt,pem,key}'] },
  },
  build: { outDir: 'dist', sourcemap: true },
});
