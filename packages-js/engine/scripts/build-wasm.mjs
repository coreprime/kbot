// Builds the package's wasm payload from the repo's Go sources:
//   wasm/engine.wasm  — cmd/engine-wasm compiled with GOOS=js GOARCH=wasm
//   wasm/wasm_exec.js — the matching Go runtime shim from the local toolchain
//   LICENSE           — copied from the repo root so the tarball carries it
// Requires a Go toolchain. Run automatically by `prepack`.

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(pkgDir, '..', '..')
const wasmDir = path.join(pkgDir, 'wasm')

mkdirSync(wasmDir, { recursive: true })

execFileSync('go', ['build', '-trimpath', '-o', path.join(wasmDir, 'engine.wasm'), './cmd/engine-wasm'], {
  cwd: repoRoot,
  env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' },
  stdio: 'inherit',
})

const goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim()
copyFileSync(path.join(goroot, 'lib', 'wasm', 'wasm_exec.js'), path.join(wasmDir, 'wasm_exec.js'))
copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(pkgDir, 'LICENSE'))

console.log('built wasm/engine.wasm + wasm/wasm_exec.js')
