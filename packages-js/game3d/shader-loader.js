// shader-loader.js
// Resolves the renderer's GLSL programs from the shader sources embedded
// in the package at build time, including `#include "<relative path>"`
// directives so shaders can share helper libraries (see
// shaders/lib/sea-waves.glsl).
//
// The GLSL lives in real .vert/.frag/.glsl files under shaders/ so they
// open in an editor with proper highlighting; scripts/gen-assets.mjs
// embeds them into generated/shader-sources.js as part of the package
// build.  Embedding (rather than fetching from a served asset tree)
// keeps the published package self-contained: the renderer's first
// frame gates on no network fetches and no host asset routes.
//
// The loader is intentionally tiny and tolerant - it does NOT try to
// implement the C preprocessor.  Just one directive, no nesting
// guards, no #ifdefs.  Cyclic includes are detected and rejected.

import { SHADER_SOURCES } from './generated/shader-sources.js'

// sourceFor returns the raw text of a shaders/-relative path.  Errors
// surface so the renderer can report a meaningful failure rather than
// ship a broken shader to the GPU.
function sourceFor(relPath) {
  const src = SHADER_SOURCES[relPath]
  if (typeof src !== 'string') {
    throw new Error(`shader-loader: no embedded source for ${relPath}`)
  }
  return src
}

// joinRel resolves an include reference relative to the including
// file's directory, collapsing `.` / `..` segments — the same path
// math URL resolution performed when the tree was served over HTTP.
function joinRel(fromPath, rel) {
  const parts = fromPath.split('/').slice(0, -1)
  for (const seg of rel.split('/')) {
    if (seg === '..') { parts.pop(); continue }
    if (seg === '.' || seg === '') continue
    parts.push(seg)
  }
  return parts.join('/')
}

// resolveIncludes walks the source line-by-line.  Whenever it sees
// `#include "<path>"` it looks up the referenced file (relative to the
// current file's path) and substitutes its resolved body.  The visited
// set guards against cycles, which would otherwise loop forever.
function resolveIncludes(source, currentPath, visited) {
  const lines = source.split('\n')
  const out = []
  for (const line of lines) {
    const m = line.match(/^\s*#include\s+"([^"]+)"\s*$/)
    if (!m) { out.push(line); continue }
    const includePath = joinRel(currentPath, m[1])
    if (visited.has(includePath)) {
      throw new Error(`shader-loader: cyclic include of ${includePath}`)
    }
    visited.add(includePath)
    const resolved = resolveIncludes(sourceFor(includePath), includePath, visited)
    // Add origin markers so compiler errors point back at the file the
    // line actually came from.  WebGL implementations ignore #line in
    // GLSL ES 1.00 by default but Chrome's translator honours it -
    // the marker comment is the reliable fallback.
    out.push(`// >>> ${m[1]}`)
    out.push(resolved)
    out.push(`// <<< ${m[1]}`)
    visited.delete(includePath)
  }
  return out.join('\n')
}

// loadShaderSource resolves a shader file by relative path (relative
// to the shaders/ directory) and returns the resolved source text.
// Still async — callers were written against the fetching loader and
// the renderer awaits these during init().
export async function loadShaderSource(relativePath) {
  return resolveIncludes(sourceFor(relativePath), relativePath, new Set([relativePath]))
}

// loadShaderProgram is a tiny convenience helper that resolves both
// vertex + fragment shaders and returns them as { vs, fs }.
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
  feat:      { vs: 'feat/feat.vert',           fs: 'feat/feat.frag' },
  featDecal: { vs: 'featdecal/featdecal.vert', fs: 'featdecal/featdecal.frag' },
  fx:        { vs: 'fx/fx.vert',               fs: 'fx/fx.frag' },
  sprites:   { vs: 'sprites/sprites.vert',     fs: 'sprites/sprites.frag' },
  impostor:  { vs: 'impostor/impostor.vert',   fs: 'impostor/impostor.frag' },
}

// loadAllShaders resolves every shader in the manifest and returns a
// map { main: {vs, fs}, sky: {vs, fs}, ... }.  Errors short-circuit
// the whole load.
export async function loadAllShaders() {
  const entries = Object.entries(SHADER_MANIFEST)
  const sources = await Promise.all(entries.map(async ([key, paths]) => {
    const { vs, fs } = await loadShaderProgram(paths.vs, paths.fs)
    return [key, { vs, fs }]
  }))
  return Object.fromEntries(sources)
}
