// Builds the Privy bridge into /dist/wallet. The entry file keeps a fixed name
// (wallet.js, served no-cache); chunks are content-hashed (served immutable).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  root,
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify(mode === 'debug' ? 'development' : 'production'), global: 'globalThis' },
  build: {
    outDir: fileURLToPath(new URL('../../dist/wallet', import.meta.url)),
    emptyOutDir: true,
    minify: mode !== 'debug',
    sourcemap: mode === 'debug',
    target: 'es2020',
    rollupOptions: {
      input: fileURLToPath(new URL('./src/bridge.jsx', import.meta.url)),
      output: {
        format: 'es',
        entryFileNames: 'wallet.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
