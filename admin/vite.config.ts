import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
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

// Empties dist/public except embed/ (owned by the embed build). If the embed output were wiped, a deploy would serve
// the SPA fallback (admin index.html, 200) for /embed/v1.js.
const cleanOutDir = (): Plugin => ({
  name: 'cms-clean-out-dir',
  buildStart() {
    const out = resolve(import.meta.dirname, '../dist/public')
    if (!existsSync(out)) return
    for (const name of readdirSync(out, { withFileTypes: true }).map((d) => d.name)) {
      if (name !== 'embed') rmSync(resolve(out, name), { recursive: true, force: true })
    }
  },
})

// Admin SPA: served at the Worker root. Independent of the embed build (embed/vite.config.ts writes dist/public/embed).
export default defineConfig({
  root: import.meta.dirname,
  publicDir: '../public',
  plugins: [preact(), cleanOutDir(), devAssets()],
  build: { outDir: '../dist/public', emptyOutDir: false, target: 'es2022' },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
})
