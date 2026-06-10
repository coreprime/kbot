import { defineConfig } from 'vite'
import { cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// KBot Studio is authored as native ES modules with root-absolute import
// paths (/ui/…, /engine/…, /game3d/…) that mirror the on-disk layout, so
// Vite resolves them directly once `root` is this directory — no aliases.
//
// Two asset trees are pulled in at runtime by fetch() rather than through the
// module graph, so the bundler never sees them.  They live in the @kbot/game3d
// package but the studio serves them at stable /game3d/* URLs, so copy them
// verbatim into dist/game3d/:
//   - shaders/**  (GLSL fetched + #include-resolved by shader-loader)
//   - worlds/**   (world manifests fetched by /game3d/worlds/…)
const game3dPkg = resolve(import.meta.dirname, '../../../packages-js/game3d')
const runtimeAssetDirs = ['shaders', 'worlds']

function copyRuntimeAssets() {
  return {
    name: 'kbot-copy-runtime-assets',
    apply: 'build',
    closeBundle() {
      const out = resolve(import.meta.dirname, 'dist')
      for (const dir of runtimeAssetDirs) {
        const from = resolve(game3dPkg, dir)
        if (!existsSync(from)) continue
        cpSync(from, resolve(out, 'game3d', dir), { recursive: true })
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
    // The @kbot/* workspace packages resolve (via node_modules symlinks) to
    // packages-js/ at the repo root, outside this web root — allow the dev
    // server to read them.
    fs: {
      allow: [resolve(import.meta.dirname, '../../..')],
    },
  },
})
