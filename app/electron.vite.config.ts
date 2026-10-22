import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: { outDir: resolve('out/main'), rollupOptions: { input: {
      index: resolve('src/main/index.ts'), 'image-worker': resolve('src/main/media/image-worker.ts'),
    } } },
  },
  preload: {
    build: { outDir: resolve('out/preload'), rollupOptions: {
      input: resolve('src/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' },
    } },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: { outDir: resolve('out/renderer'), emptyOutDir: true },
  },
});
