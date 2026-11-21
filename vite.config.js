import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['libraw-wasm-nothread'] },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
