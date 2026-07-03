// Builds the publishable dist/ tree:
//   1. scripts/gen-assets.mjs — embeds shaders/** + worlds/*.json as
//      generated/ ES modules.
//   2. esbuild transforms every package module (top-level *.js +
//      generated/*.js) into dist/, one output per module so relative
//      imports — and therefore module identity / module-level state —
//      are preserved for both root and subpath consumers.
//   3. index.d.ts + the repo LICENSE are copied alongside.
//
// Run automatically by `prepack`; the studio's Vite build resolves
// @kbot/game3d/* to dist/ via the exports map, so `task build` runs
// this first.

import { execFileSync } from 'node:child_process'
import { copyFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(pkgDir, '..', '..')
const distDir = path.join(pkgDir, 'dist')

execFileSync(process.execPath, [path.join(pkgDir, 'scripts', 'gen-assets.mjs')], { stdio: 'inherit' })

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

rmSync(distDir, { recursive: true, force: true })

const entryPoints = [
  ...readdirSync(pkgDir).filter((f) => f.endsWith('.js')).map((f) => path.join(pkgDir, f)),
  ...readdirSync(path.join(pkgDir, 'generated')).filter((f) => f.endsWith('.js')).map((f) => path.join(pkgDir, 'generated', f)),
]

await esbuild.build({
  entryPoints,
  outdir: distDir,
  outbase: pkgDir,
  bundle: false,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  logLevel: 'info',
})

copyFileSync(path.join(pkgDir, 'index.d.ts'), path.join(distDir, 'index.d.ts'))
copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(pkgDir, 'LICENSE'))

console.log(`built dist/ (${entryPoints.length} modules)`)
