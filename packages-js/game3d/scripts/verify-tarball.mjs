// Pre-publish tarball gate. Packs the package, then fails hard unless the
// tarball contains exactly the allow-listed files and none of its bytes
// look like a credential or a host-server coupling. The extracted tree is
// left behind for external scanners (trufflehog / trivy) to sweep before
// `npm publish <tarball>` ships the exact artifact that was verified.
//
// Usage: node scripts/verify-tarball.mjs <output-dir>
//   <output-dir>/  — receives the .tgz
//   <output-dir>/extracted/package/  — the unpacked tarball contents

import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.resolve(process.argv[2] ?? path.join(pkgDir, 'pack-verify'))
const extractDir = path.join(outDir, 'extracted')

// Exact top-level files plus the built dist/ tree (whose membership is
// dynamic — module-per-file output).  Every dist entry must still be a
// .js/.d.ts artifact, and the load-bearing entries must be present.
const allowedExact = new Set(['package.json', 'README.md', 'LICENSE'])
const allowedDist = (p) => p.startsWith('dist/') && (p.endsWith('.js') || p.endsWith('.d.ts'))
const requiredFiles = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/assets.js',
  'dist/create-world.js',
  'dist/model-renderer.js',
  'dist/generated/shader-sources.js',
  'dist/generated/world-data.js',
]

const forbiddenNames = [/^\.npmrc$/, /^\.env/, /^\.git/, /\.pem$/, /\.key$/, /^node_modules(\/|$)/]

// Credential shapes: GitHub token families, npm tokens, and any _authToken
// whose value is not an environment reference.
const tokenPatterns = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /npm_[A-Za-z0-9]{36,}/,
  /_authToken\s*=\s*(?!\$\{)\S+/,
]

// Host-coupling tripwire (V1.3): the renderer's only I/O is the injected
// AssetProvider, so no packed byte may reference the studio server's API
// namespace.
const hostCouplingPattern = /\/api\/studio\//

let failed = false
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  failed = true
}

mkdirSync(outDir, { recursive: true })
// prepack (the dist build) writes to stdout ahead of npm's JSON; parse
// from the start of the JSON array.
const rawPackOut = execFileSync('npm', ['pack', '--json', '--pack-destination', outDir], {
  cwd: pkgDir,
  encoding: 'utf8',
})
const packOut = JSON.parse(rawPackOut.slice(rawPackOut.indexOf('[')))
const { filename, files } = packOut[0]
const tarball = path.join(outDir, filename)

console.log(`tarball: ${filename}`)
console.log('contents:')
for (const f of files) {
  console.log(`  ${f.path} (${f.size} bytes)`)
  if (!allowedExact.has(f.path) && !allowedDist(f.path)) fail(`unexpected file in tarball: ${f.path}`)
  if (forbiddenNames.some((re) => re.test(f.path) || re.test(path.basename(f.path)))) {
    fail(`forbidden file in tarball: ${f.path}`)
  }
}
for (const name of requiredFiles) {
  if (!files.some((f) => f.path === name)) fail(`expected file missing from tarball: ${name}`)
}

mkdirSync(extractDir, { recursive: true })
execFileSync('tar', ['-xzf', tarball, '-C', extractDir])

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

for (const file of walk(extractDir)) {
  const text = readFileSync(file).toString('latin1')
  for (const re of tokenPatterns) {
    const m = re.exec(text)
    if (m) fail(`credential-shaped content in ${path.relative(extractDir, file)}: ${m[0].slice(0, 12)}…`)
  }
  const host = hostCouplingPattern.exec(text)
  if (host) fail(`studio API path in ${path.relative(extractDir, file)}: ${host[0]}`)
}

if (failed) {
  console.error('tarball verification FAILED — do not publish')
  process.exit(1)
}
console.log(`tarball verification OK — extracted tree at ${extractDir}`)
console.log(`TARBALL=${tarball}`)
