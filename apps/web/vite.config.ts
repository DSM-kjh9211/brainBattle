import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// MathLive loads its fonts at runtime: ship them from /mathlive/fonts (works offline in schools)
const fontsSrc = fileURLToPath(new URL('../../node_modules/mathlive/fonts', import.meta.url));
const fontsDst = fileURLToPath(new URL('./public/mathlive/fonts', import.meta.url));
if (existsSync(fontsSrc) && !existsSync(fontsDst)) cpSync(fontsSrc, fontsDst, { recursive: true });

const backend = process.env.BRAINBATTLE_SERVER ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['source'],
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
});
