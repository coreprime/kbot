import { defineConfig } from 'vite'
import { cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// KBot Studio is authored as native ES modules with root-absolute import
// paths (/ui/…, /engine/…) that mirror the on-disk layout, so Vite
// resolves them directly once `root` is this directory — no aliases.
// The 3D renderer comes from the @coreprime/kbot-game3d workspace package, whose
// exports map points at its built dist/ (shaders + worlds embedded), so
// there is no /game3d/* asset tree to serve any more.
//
// Brand assets live at the repo root (branding/) — logos/ for the picker header
// + editor brand, textures/ for the welcome backgrounds. Copy the whole tree
// into dist/branding/ so the studio serves them at stable /branding/* URLs.
const brandingDir = resolve(import.meta.dirname, '../../../branding')

function copyRuntimeAssets() {
  return {
    name: 'kbot-copy-runtime-assets',
    apply: 'build',
    closeBundle() {
      const out = resolve(import.meta.dirname, 'dist')
      if (existsSync(brandingDir)) {
        cpSync(brandingDir, resolve(out, 'branding'), { recursive: true })
      }
      // Keep a committed placeholder so the Go package embedding dist/ still
      // compiles on a fresh checkout before the web bundle has been built.
      mkdirSync(out, { recursive: true })
      writeFileSync(resolve(out, '.gitkeep'), '')
    },
  }
}

export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Two entries: the editor SPA (index.html, mounted per workspace) and
    // the lightweight workspace picker (picker.html, served at "/").
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        picker: resolve(import.meta.dirname, 'picker.html'),
      },
    },
  },
  plugins: [copyRuntimeAssets()],
  server: {
    // `vite dev` serves the bundle with HMR while the Go studio backend owns
    // every /api/* route; proxy them through to the running `kbot studio`.
    proxy: {
      '/api': 'http://localhost:8100',
    },
    // The @coreprime/kbot-* workspace packages resolve (via node_modules symlinks) to
    // packages-js/ at the repo root, outside this web root — allow the dev
    // server to read them.
    fs: {
      allow: [resolve(import.meta.dirname, '../../..')],
    },
  },
})
