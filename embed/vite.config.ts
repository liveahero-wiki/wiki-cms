import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

// Public embed. `v1.js` is the tiny loader (stable name, CORS *); list/form code is split into
// hashed chunks that the loader import()s relative to its own URL (i.e. the Worker origin).
export default defineConfig({
  root: import.meta.dirname,
  publicDir: false,
  plugins: [preact()],
  build: {
    outDir: '../dist/public/embed',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: { v1: 'src/loader.ts' },
      output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: 'chunks/[name]-[hash][extname]' },
      preserveEntrySignatures: false,
    },
  },
  server: { port: 5174, cors: true },
})
