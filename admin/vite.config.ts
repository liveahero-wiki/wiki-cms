import { readFileSync } from 'node:fs'
import preact from '@preact/preset-vite'
import { defineConfig, type Plugin } from 'vite'

// Dev only: `CMS_DEV_ASSETS=1 pnpm build:admin` also emits admin/dev/stub-plugin.js as /dev/stub-plugin.js so it can be
// loaded same-origin (the admin CSP only allows 'self' and the wiki origin) via ?plugin=/dev/stub-plugin.js.
const devAssets = (): Plugin => ({
  name: 'cms-dev-assets',
  generateBundle() {
    if (process.env.CMS_DEV_ASSETS !== '1') return
    this.emitFile({ type: 'asset', fileName: 'dev/stub-plugin.js', source: readFileSync(new URL('./dev/stub-plugin.js', import.meta.url)) })
  },
})

// Admin SPA: served at the Worker root. Build order matters: this one empties dist/public,
// the embed build (embed/vite.config.ts) then writes dist/public/embed.
export default defineConfig({
  root: import.meta.dirname,
  publicDir: '../public',
  plugins: [preact(), devAssets()],
  build: { outDir: '../dist/public', emptyOutDir: true, target: 'es2022' },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
})
