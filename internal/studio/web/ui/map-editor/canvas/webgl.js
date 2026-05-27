// webgl.js
//
// Map editor's WebGL tile + feature renderer.  The 2D overlay
// canvas still paints placement previews, gridlines, selection
// rectangles, etc., but the hot per-frame work (tiles + feature
// sprites) goes through this GL pipeline so big maps stay smooth.
//
// Architecture
// ------------
//   - One ortho-projected shader pair (textured quad).  Per-vertex
//     pixel position + UV; uniform `uProj` maps map-pixel coords
//     into clip space with Y flipped to match 2D canvas convention.
//   - One vertex buffer.  Reused with bufferData(DYNAMIC_DRAW) per
//     batch — no static geometry, every frame's positions come
//     from the current viewport.
//   - One texture per asset (tile-sheet image, feature sprite).
//     Cached in `gl.textures` keyed by stable string ids ("path",
//     "feature:armcom_dead", etc.) — uploaded on first use.
//   - Visible tiles are grouped by section path so each section's
//     image becomes exactly one batched drawArrays call.  Feature
//     sprites are sorted by anchor Y (south-painted-later) then
//     grouped into contiguous same-key runs for the same effect.
//
// Forward-reference helpers — `whenImageReady`, `preloadFeatureImage`,
// `renderCanvas`, `transformedSourceCell`, `featureAnchorOffset`,
// `featureAnchorWorld` — live in studio.js for now and are wired
// in through hostCallbacks.  The renderer no-ops cleanly when any
// is unset (early boot, headless harness).

import { state, $, hostCallbacks } from '../../host-context.js'
import { TILE_PX } from '../constants.js'

// gl owns every WebGL resource the renderer needs.  Re-initialised
// from scratch by resetGL on map / view swap so the next
// ensureGLRenderer call rebuilds against the freshly-mounted
// #canvas-gl element.
export const gl = {
  ctx: null,
  prog: null,
  posLoc: -1,
  uvLoc: -1,
  texLoc: -1,
  projLoc: -1,
  vbo: null,
  textures: new Map(),
  failed: false,
}

// resetGL drops the WebGL context, textures, and program references
// so the next ensureGLRenderer() call rebuilds everything against
// the freshly-mounted #canvas-gl element.  EditorView.destroy()
// calls this before removing the canvas from the DOM.
export function resetGL() {
  if (gl.ctx) {
    try {
      for (const t of gl.textures.values()) if (t && t.tex) gl.ctx.deleteTexture(t.tex)
      if (gl.vbo) gl.ctx.deleteBuffer(gl.vbo)
      if (gl.prog) gl.ctx.deleteProgram(gl.prog)
      gl.ctx.getExtension('WEBGL_lose_context')?.loseContext()
    } catch { /* the context may already be lost */ }
  }
  gl.textures.clear()
  gl.ctx = null
  gl.prog = null
  gl.vbo = null
  gl.posLoc = -1
  gl.uvLoc = -1
  gl.texLoc = -1
  gl.projLoc = -1
  // Clear `failed` so a fresh GL context gets a real attempt — the
  // previous failure could have been transient (e.g. a lost context
  // during a map switch).
  gl.failed = false
}

// ensureGLRenderer is called from renderCanvas; returns true when
// the WebGL context is live and ready to draw.  Returns false (and
// only the first time logs a warning) when WebGL isn't supported,
// so the 2D fallback path stays in play.
export function ensureGLRenderer() {
  if (gl.ctx) return true
  if (gl.failed) return false
  const canvas = $('#canvas-gl')
  if (!canvas) return false
  const ctx = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false })
    || canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false })
  if (!ctx) {
    gl.failed = true
    console.warn('WebGL unavailable — falling back to 2D rendering')
    return false
  }
  // Vertex shader: per-vertex pixel position + UV.  An ortho
  // projection maps map-pixel coords (0..mapW, 0..mapH) into clip
  // space, with Y flipped so (0,0) sits at the top-left like the 2D
  // canvas.
  const vsrc = `
    attribute vec2 aPos;
    attribute vec2 aUV;
    uniform vec2 uProj;
    varying vec2 vUV;
    void main() {
      vec2 ndc = vec2(aPos.x / uProj.x * 2.0 - 1.0, 1.0 - aPos.y / uProj.y * 2.0);
      gl_Position = vec4(ndc, 0.0, 1.0);
      vUV = aUV;
    }
  `
  // Fragment shader: sample the bound texture.  We keep
  // fully-transparent pixels around (no discard) so the GPU's blend
  // stage handles the composite — discarding was eating opaque
  // section tiles whose blue channel happened to coincide with the
  // alpha threshold in tests.
  const fsrc = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    void main() {
      gl_FragColor = texture2D(uTex, vUV);
    }
  `
  const vs = ctx.createShader(ctx.VERTEX_SHADER)
  ctx.shaderSource(vs, vsrc); ctx.compileShader(vs)
  if (!ctx.getShaderParameter(vs, ctx.COMPILE_STATUS)) {
    console.warn('vertex shader compile failed:', ctx.getShaderInfoLog(vs))
    gl.failed = true; return false
  }
  const fs = ctx.createShader(ctx.FRAGMENT_SHADER)
  ctx.shaderSource(fs, fsrc); ctx.compileShader(fs)
  if (!ctx.getShaderParameter(fs, ctx.COMPILE_STATUS)) {
    console.warn('fragment shader compile failed:', ctx.getShaderInfoLog(fs))
    gl.failed = true; return false
  }
  const prog = ctx.createProgram()
  ctx.attachShader(prog, vs); ctx.attachShader(prog, fs); ctx.linkProgram(prog)
  if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) {
    console.warn('program link failed:', ctx.getProgramInfoLog(prog))
    gl.failed = true; return false
  }
  gl.ctx = ctx
  gl.prog = prog
  gl.posLoc = ctx.getAttribLocation(prog, 'aPos')
  gl.uvLoc = ctx.getAttribLocation(prog, 'aUV')
  gl.texLoc = ctx.getUniformLocation(prog, 'uTex')
  gl.projLoc = ctx.getUniformLocation(prog, 'uProj')
  gl.vbo = ctx.createBuffer()
  ctx.enable(ctx.BLEND)
  ctx.blendFunc(ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA)
  return true
}

// glTextureFor uploads an HTMLImageElement to a GPU texture once
// and returns the cached handle.  Images that haven't decoded yet
// return null; callers should fall through and let the load
// listener retry the render once the pixels are available.
export function glTextureFor(key, img) {
  if (!gl.ctx || !img || !img.complete || img.naturalWidth === 0) return null
  const cached = gl.textures.get(key)
  if (cached) return cached
  const ctx = gl.ctx
  const tex = ctx.createTexture()
  ctx.bindTexture(ctx.TEXTURE_2D, tex)
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST)
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST)
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE)
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE)
  ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, false)
  ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, img)
  gl.textures.set(key, { tex, w: img.naturalWidth, h: img.naturalHeight })
  return gl.textures.get(key)
}

// glClearViewport fills the GL canvas with the void colour so the
// non-GL view modes (heightmap) see a clean backdrop.
export function glClearViewport() {
  if (!gl.ctx) return
  const ctx = gl.ctx
  ctx.viewport(0, 0, ctx.drawingBufferWidth, ctx.drawingBufferHeight)
  ctx.clearColor(0x1d / 255, 0x30 / 255, 0x45 / 255, 1)
  ctx.clear(ctx.COLOR_BUFFER_BIT)
}

// glRenderTilesAndFeatures repaints the GL layer.  Walks visible
// tiles grouped by section path, builds one batched vertex buffer
// per group, and draws each group with a single drawArrays call.
// Features are batched the same way, keyed by feature name.
export function glRenderTilesAndFeatures(vp) {
  if (!gl.ctx) return
  const ctx = gl.ctx
  ctx.viewport(0, 0, ctx.drawingBufferWidth, ctx.drawingBufferHeight)
  ctx.clearColor(0x1d / 255, 0x30 / 255, 0x45 / 255, 1)
  ctx.clear(ctx.COLOR_BUFFER_BIT)

  ctx.useProgram(gl.prog)
  ctx.uniform2f(gl.projLoc, ctx.drawingBufferWidth, ctx.drawingBufferHeight)
  ctx.bindBuffer(ctx.ARRAY_BUFFER, gl.vbo)
  ctx.enableVertexAttribArray(gl.posLoc)
  ctx.enableVertexAttribArray(gl.uvLoc)
  // Each vertex is 4 floats: x, y, u, v.  Stride 16 bytes.
  ctx.vertexAttribPointer(gl.posLoc, 2, ctx.FLOAT, false, 16, 0)
  ctx.vertexAttribPointer(gl.uvLoc, 2, ctx.FLOAT, false, 16, 8)

  // ── Tiles ────────────────────────────────────────────────────
  // Group visible tile stamps by section path so each section
  // image turns into exactly one batched draw call.
  const tileGroups = new Map()
  const tw = state.tileW
  for (let ty = vp.minTY; ty <= vp.maxTY; ty++) {
    for (let tx = vp.minTX; tx <= vp.maxTX; tx++) {
      const stamp = state.tiles[ty * tw + tx]
      if (!stamp || !stamp.sectionPath) continue
      let list = tileGroups.get(stamp.sectionPath)
      if (!list) { list = []; tileGroups.set(stamp.sectionPath, list) }
      list.push({ tx, ty, stamp })
    }
  }
  for (const [path, list] of tileGroups) {
    const img = state.sectionImages.get(path)
    const t = glTextureFor(path, img)
    if (!t) {
      hostCallbacks.whenImageReady?.(img, 'render', () => hostCallbacks.renderCanvas?.())
      continue
    }
    const verts = buildTileBatch(list, t.w, t.h)
    ctx.bufferData(ctx.ARRAY_BUFFER, verts, ctx.DYNAMIC_DRAW)
    ctx.activeTexture(ctx.TEXTURE0)
    ctx.bindTexture(ctx.TEXTURE_2D, t.tex)
    ctx.uniform1i(gl.texLoc, 0)
    ctx.drawArrays(ctx.TRIANGLES, 0, list.length * 6)
  }

  // ── Features ─────────────────────────────────────────────────
  // Painted in Y-order (anchor py ascending) so a sprite further
  // south always overlays sprites to its north.  Without this an
  // unsorted batch would let an earlier-in-array tree paint on top
  // of a tree anchored visually below it.  Same-texture features
  // are batched in contiguous runs so the typical "cluster of
  // identical trees" still hits the GPU as one draw call.
  if (!state.showFeatures || state.viewMode === 'tiles') return
  const pxMinX = vp.minTX * TILE_PX, pxMaxX = (vp.maxTX + 1) * TILE_PX
  const pxMinY = vp.minTY * TILE_PX, pxMaxY = (vp.maxTY + 1) * TILE_PX
  const visible = []
  for (const f of state.features) {
    if (!f.previewUrl) continue
    const anchor = hostCallbacks.featureAnchorWorld?.(f)
    if (!anchor) continue
    const { px, py } = anchor
    const img = state.featureImages.get((f.name || '').toLowerCase())
    if (!img || !img.complete || img.naturalWidth === 0) {
      if (img) hostCallbacks.whenImageReady?.(img, 'render', () => hostCallbacks.renderCanvas?.())
      else hostCallbacks.preloadFeatureImage?.(f)
      continue
    }
    const off = hostCallbacks.featureAnchorOffset?.(f, img)
    if (!off) continue
    const { dx, dy } = off
    const x = px - dx, y = py - dy
    if (x + img.naturalWidth < pxMinX || x > pxMaxX || y + img.naturalHeight < pxMinY || y > pxMaxY) continue
    visible.push({ key: (f.name || '').toLowerCase(), x, y, py, img })
  }
  // Sort by anchor py (tie-break on px so order is deterministic).
  visible.sort((a, b) => a.py === b.py ? a.x - b.x : a.py - b.py)
  // Emit batches of same-key contiguous runs.
  let i = 0
  while (i < visible.length) {
    const key = visible[i].key
    const img = visible[i].img
    const run = []
    while (i < visible.length && visible[i].key === key) {
      run.push({ x: visible[i].x, y: visible[i].y })
      i++
    }
    const t = glTextureFor('feature:' + key, img)
    if (!t) continue
    const verts = buildFeatureBatch(run, img.naturalWidth, img.naturalHeight)
    ctx.bufferData(ctx.ARRAY_BUFFER, verts, ctx.DYNAMIC_DRAW)
    ctx.activeTexture(ctx.TEXTURE0)
    ctx.bindTexture(ctx.TEXTURE_2D, t.tex)
    ctx.uniform1i(gl.texLoc, 0)
    ctx.drawArrays(ctx.TRIANGLES, 0, run.length * 6)
  }
}

// buildTileBatch assembles the vertex array for every tile in a
// batch.  Each tile becomes two triangles (6 verts).  The 32×32
// source rect inside the section image is determined by the
// rotated/flipped transformedSourceCell logic — the four corners
// are emitted in an order that bakes the same rotation+flip the 2D
// path would apply, so the sampled UVs hit the right pixels.
export function buildTileBatch(list, imgW, imgH) {
  const out = new Float32Array(list.length * 6 * 4)
  let o = 0
  for (const { tx, ty, stamp } of list) {
    const dx0 = tx * TILE_PX, dy0 = ty * TILE_PX
    const dx1 = dx0 + TILE_PX, dy1 = dy0 + TILE_PX
    const src = stamp.sectionPath
      ? (hostCallbacks.transformedSourceCell?.(0, 0, 1, 1, stamp.rotation || 0, !!stamp.flipH, !!stamp.flipV)
        || { sx: stamp.sx, sy: stamp.sy })
      : { sx: stamp.sx, sy: stamp.sy }
    // The source cell from the stamp is already pre-rotated (it was
    // baked at stamp-time), but the per-tile rotation/flip still
    // controls how the *pixels* sit inside that source slot.
    const sx0 = stamp.sx * 32 / imgW
    const sy0 = stamp.sy * 32 / imgH
    const sx1 = (stamp.sx + 1) * 32 / imgW
    const sy1 = (stamp.sy + 1) * 32 / imgH
    void src
    // Compute the four UV corners after applying rotation + flips
    // so the texture is sampled the same way the 2D
    // drawTransformedTile would paint it.
    let uTL = sx0, vTL = sy0, uTR = sx1, vTR = sy0, uBR = sx1, vBR = sy1, uBL = sx0, vBL = sy1
    const rot = (stamp.rotation || 0) & 3
    for (let i = 0; i < rot; i++) {
      // 90° CW: TL←BL, TR←TL, BR←TR, BL←BR
      const nuTL = uBL, nvTL = vBL
      const nuTR = uTL, nvTR = vTL
      const nuBR = uTR, nvBR = vTR
      const nuBL = uBR, nvBL = vBR
      uTL = nuTL; vTL = nvTL; uTR = nuTR; vTR = nvTR; uBR = nuBR; vBR = nvBR; uBL = nuBL; vBL = nvBL
    }
    if (stamp.flipH) {
      // Mirror across the vertical axis: swap left↔right UVs.
      let t = uTL; uTL = uTR; uTR = t
      t = vTL; vTL = vTR; vTR = t
      t = uBL; uBL = uBR; uBR = t
      t = vBL; vBL = vBR; vBR = t
    }
    if (stamp.flipV) {
      let t = uTL; uTL = uBL; uBL = t
      t = vTL; vTL = vBL; vBL = t
      t = uTR; uTR = uBR; uBR = t
      t = vTR; vTR = vBR; vBR = t
    }
    // Triangle 1: TL, TR, BR
    out[o++] = dx0; out[o++] = dy0; out[o++] = uTL; out[o++] = vTL
    out[o++] = dx1; out[o++] = dy0; out[o++] = uTR; out[o++] = vTR
    out[o++] = dx1; out[o++] = dy1; out[o++] = uBR; out[o++] = vBR
    // Triangle 2: TL, BR, BL
    out[o++] = dx0; out[o++] = dy0; out[o++] = uTL; out[o++] = vTL
    out[o++] = dx1; out[o++] = dy1; out[o++] = uBR; out[o++] = vBR
    out[o++] = dx0; out[o++] = dy1; out[o++] = uBL; out[o++] = vBL
  }
  return out
}

// buildFeatureBatch produces the vertex array for every feature in
// a group.  Each feature is one quad sized to the sprite's natural
// dimensions; no rotation/flip support since the GAF sprites we
// serve for the canvas are already the final pose.
export function buildFeatureBatch(items, w, h) {
  const out = new Float32Array(items.length * 6 * 4)
  let o = 0
  for (const { x, y } of items) {
    const x1 = x + w, y1 = y + h
    out[o++] = x;   out[o++] = y;   out[o++] = 0; out[o++] = 0
    out[o++] = x1;  out[o++] = y;   out[o++] = 1; out[o++] = 0
    out[o++] = x1;  out[o++] = y1;  out[o++] = 1; out[o++] = 1
    out[o++] = x;   out[o++] = y;   out[o++] = 0; out[o++] = 0
    out[o++] = x1;  out[o++] = y1;  out[o++] = 1; out[o++] = 1
    out[o++] = x;   out[o++] = y1;  out[o++] = 0; out[o++] = 1
  }
  return out
}
