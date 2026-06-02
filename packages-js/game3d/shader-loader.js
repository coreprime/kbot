// shader-loader.js
// Fetches GLSL source files served from the embedded web assets and
// resolves `#include "<relative path>"` directives so shaders can
// share helper libraries (see shaders/lib/sea-waves.glsl).
//
// Why this exists: the studio is served as plain ES modules - no
// bundler, no build step.  But we still want the shader source in
// real .vert/.frag/.glsl files so they open in VS Code's GLSL
// extension with proper highlighting.  The trade-off is that the
// renderer's first frame is gated on a small handful of network
// fetches; the loader keeps those parallel and caches the bodies so
// repeated viewer instances share the same source text.
//
// The loader is intentionally tiny and tolerant - it does NOT try to
// implement the C preprocessor.  Just one directive, no nesting
// guards, no #ifdefs.  Cyclic includes are detected and rejected.

// Absolute, origin-rooted base so the fetch URLs stay stable whether this
// module is served raw or rolled into a hashed bundle chunk (import.meta.url
// would otherwise point at /assets/… once bundled).  The studio serves the
// shader tree verbatim at /game3d/shaders/.
const baseDir = new URL('/game3d/shaders/', window.location.origin)

// Module-level cache: same shader URL only ever fetches once per page
// load, even if multiple renderers spin up.
const fetchCache = new Map() // string URL -> Promise<string>

// fetchRaw returns the raw text of `url`, memoised.  Errors surface
// so the renderer can report a meaningful failure rather than ship a
// broken shader to the GPU.
function fetchRaw(url) {
  if (fetchCache.has(url)) return fetchCache.get(url)
  const p = fetch(url).then(async (resp) => {
    if (!resp.ok) throw new Error(`shader fetch ${url}: HTTP ${resp.status}`)
    return resp.text()
  })
  fetchCache.set(url, p)
  return p
}

// resolveIncludes walks the source line-by-line.  Whenever it sees
// `#include "<path>"` it fetches the referenced file (relative to the
// current file's URL) and substitutes its resolved body.  The visited
// set guards against cycles, which would otherwise loop forever.
async function resolveIncludes(source, currentUrl, visited) {
  const lines = source.split('\n')
  const out = []
  for (const line of lines) {
    const m = line.match(/^\s*#include\s+"([^"]+)"\s*$/)
    if (!m) { out.push(line); continue }
    const includeUrl = new URL(m[1], currentUrl).href
    if (visited.has(includeUrl)) {
      throw new Error(`shader-loader: cyclic include of ${includeUrl}`)
    }
    visited.add(includeUrl)
    const body = await fetchRaw(includeUrl)
    const resolved = await resolveIncludes(body, includeUrl, visited)
    // Add origin markers so compiler errors point back at the file the
    // line actually came from.  WebGL implementations ignore #line in
    // GLSL ES 1.00 by default but Chrome's translator honours it -
    // the marker comment is the reliable fallback.
    out.push(`// >>> ${m[1]}`)
    out.push(resolved)
    out.push(`// <<< ${m[1]}`)
    visited.delete(includeUrl)
  }
  return out.join('\n')
}

// loadShaderSource fetches a shader file by relative path (relative
// to the shaders/ directory) and returns the resolved source text.
export async function loadShaderSource(relativePath) {
  const url = new URL(relativePath, baseDir).href
  const raw = await fetchRaw(url)
  return resolveIncludes(raw, url, new Set([url]))
}

// loadShaderProgram is a tiny convenience helper that fetches both
// vertex + fragment shaders in parallel and returns them as
// { vs, fs }.  Saves a few await chains in the renderer.
export async function loadShaderProgram(vsPath, fsPath) {
  const [vs, fs] = await Promise.all([
    loadShaderSource(vsPath),
    loadShaderSource(fsPath),
  ])
  return { vs, fs }
}

// SHADER_MANIFEST: declarative table of every shader program the
// renderer needs.  Calling loadAllShaders() returns the resolved
// sources keyed by the same names; the renderer references those
// instead of in-file template literals.
export const SHADER_MANIFEST = {
  main:      { vs: 'main/main.vert',           fs: 'main/main.frag' },
  sky:       { vs: 'sky/sky.vert',             fs: 'sky/sky.frag' },
  ground:    { vs: 'ground/ground.vert',       fs: 'ground/ground.frag' },
  shadow:    { vs: 'shadow/shadow.vert',       fs: 'shadow/shadow.frag' },
  wire:      { vs: 'wire/wire.vert',           fs: 'wire/wire.frag' },
  dof:       { vs: 'dof/dof.vert',             fs: 'dof/dof.frag' },
  fxaa:      { vs: 'fxaa/fxaa.vert',           fs: 'fxaa/fxaa.frag' },
  bloomBright: { vs: 'bloom/bloom.vert',       fs: 'bloom/bright.frag' },
  bloomBlur:   { vs: 'bloom/bloom.vert',       fs: 'bloom/blur.frag' },
  particles: { vs: 'particles/particles.vert', fs: 'particles/particles.frag' },
  sprites:   { vs: 'sprites/sprites.vert',     fs: 'sprites/sprites.frag' },
  impostor:  { vs: 'impostor/impostor.vert',   fs: 'impostor/impostor.frag' },
}

// loadAllShaders fetches every shader in the manifest in parallel and
// returns a map { main: {vs, fs}, sky: {vs, fs}, ... }.  Errors short-
// circuit the whole load.
export async function loadAllShaders() {
  const entries = Object.entries(SHADER_MANIFEST)
  const sources = await Promise.all(entries.map(async ([key, paths]) => {
    const { vs, fs } = await loadShaderProgram(paths.vs, paths.fs)
    return [key, { vs, fs }]
  }))
  return Object.fromEntries(sources)
}
