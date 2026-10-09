// Web app dev server and build. In development the API runs separately on loopback and is reached
// through this proxy, so the browser sees a single origin (cookies are SameSite=Strict).
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  oxc: { jsx: { runtime: 'automatic' } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env.PW_API_URL ?? 'http://127.0.0.1:8787' } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
