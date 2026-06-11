// TextureCache fetches and uploads GAF-backed textures to the GPU.
//
// 3DO primitives reference textures by name (e.g. "ARMKBOT4");
// /api/studio/texture/<name> resolves these names against the
// textures/*.gaf bundle and returns a PNG.  The cache is keyed by the
// lowercased texture name so calls are deduplicated across pieces and
// across separate models that share the same atlas entry.
//
// Texture wrapping: TA's 3DO faces are unit-quad mapped — the texture
// is meant to be applied 1:1 to a face, never tiled.  We bind every
// texture with CLAMP_TO_EDGE on both axes so sub-pixel UVs along a face
// edge never bleed in the neighbour's column / row.  Filtering stays at
// NEAREST to preserve TA's chunky paletted look.

import { buildLampAtlas } from './lamp-map.js'

// Cap on cached lamp atlases.  Dragging a running-lights slider mints a
// fresh atlas per (texture, threshold) combo; evict oldest beyond this so
// a long tweaking session doesn't leak GPU textures.
const LAMP_MAP_CACHE_MAX = 48

export class TextureCache {
  constructor(gl) {
    this.gl = gl
    this.entries = new Map() // key → { tex, source, ready, width, height }
    this.pending = new Map() // key → Promise<image>
    // Lamp atlases for the running-lights effect, keyed by
    // `${name}|${keyBright}|${keySat}|${gapPx}` → { tex, ready, width, height }.
    this.lampMaps = new Map()
    this.onAnyTextureReady = null // callback invoked when a texture flips ready
    // Anisotropic filtering extension is detected by ModelRenderer (so
    // tests can run without a context) and pushed in via
    // setAnisotropicExt.  When present, we crank filtering to the
    // hardware max — TA's tiny 32×32 textures benefit enormously from
    // anisotropic sampling at oblique angles.
    this.anisoExt = null
    this.anisoMax = 1
    this.fallback = this.#makeFallbackTexture()
  }

  setAnisotropicExt(ext) {
    this.anisoExt = ext
    if (ext) this.anisoMax = this.gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1
  }

  // get returns the GPU texture handle for `name`, kicking off a fetch
  // if we haven't seen it yet.  Until the PNG decodes, returns a fallback
  // 1×1 grey texture so the renderer can keep drawing every frame.
  get(name) {
    const key = (name || '').toLowerCase()
    if (!key) return this.fallback
    const entry = this.entries.get(key)
    if (entry && entry.ready) return entry
    this.#beginLoad(key)
    return this.entries.get(key) || this.fallback
  }

  // ensure starts a fetch for every name in the list — used by ModelLoader
  // so all textures are inflight before the first render.
  async ensure(names) {
    const promises = []
    for (const n of names) {
      const key = (n || '').toLowerCase()
      if (!key) continue
      promises.push(this.#beginLoad(key))
    }
    await Promise.allSettled(promises)
  }

  // dispose tears down all GPU textures.  Call when the ModelRenderer
  // unbinds its WebGL context so we don't leak handles into a dead
  // context.
  dispose() {
    const gl = this.gl
    for (const entry of this.entries.values()) {
      if (entry.tex) gl.deleteTexture(entry.tex)
    }
    for (const lm of this.lampMaps.values()) {
      if (lm.tex) gl.deleteTexture(lm.tex)
    }
    this.lampMaps.clear()
    this.entries.clear()
    this.pending.clear()
    if (this.fallback?.tex) gl.deleteTexture(this.fallback.tex)
    this.fallback = null
  }

  #beginLoad(key) {
    if (this.pending.has(key)) return this.pending.get(key)
    const existing = this.entries.get(key)
    if (existing?.ready) return Promise.resolve(existing)
    // Seed an entry so synchronous get() callers see the fallback while
    // the real PNG decodes in the background.
    if (!existing) {
      this.entries.set(key, {
        tex: this.fallback.tex,
        ready: false,
        width: this.fallback.width,
        height: this.fallback.height,
      })
    }
    const promise = (async () => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      // Keys may carry a resolver query ("name?side=ara") — split it out so
      // the name is encoded but the query reaches the server intact.
      const qi = key.indexOf('?')
      img.src = qi === -1
        ? `/api/studio/texture/${encodeURIComponent(key)}`
        : `/api/studio/texture/${encodeURIComponent(key.slice(0, qi))}?${key.slice(qi + 1)}`
      await new Promise((resolve, reject) => {
        img.addEventListener('load', resolve, { once: true })
        img.addEventListener('error', reject, { once: true })
      })
      this.#upload(key, img)
      this.pending.delete(key)
      if (this.onAnyTextureReady) this.onAnyTextureReady(key)
    })().catch((err) => {
      console.warn(`texture load failed for ${key}:`, err)
      this.pending.delete(key)
    })
    this.pending.set(key, promise)
    return promise
  }

  #upload(key, image) {
    const gl = this.gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    // Mipmaps + trilinear + anisotropic make the biggest single
    // upgrade to texture quality at oblique angles + at distance.
    // WebGL1 requires power-of-two for mipmaps, so non-POT textures
    // get resized into a POT canvas first; the source pixels stay
    // intact (no quality loss), the canvas just provides the size.
    let src = image
    const w = image.naturalWidth || image.width
    const h = image.naturalHeight || image.height
    if (!this.#isPowerOfTwo(w) || !this.#isPowerOfTwo(h)) {
      const wp = this.#nextPOT(w)
      const hp = this.#nextPOT(h)
      const canvas = document.createElement('canvas')
      canvas.width = wp
      canvas.height = hp
      const cx = canvas.getContext('2d')
      cx.imageSmoothingEnabled = false
      cx.drawImage(image, 0, 0, wp, hp)
      src = canvas
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (this.anisoExt && this.anisoMax > 1) {
      gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, this.anisoMax))
    }
    this.entries.set(key, {
      tex,
      // Keep the decoded source (the original Image, or the POT canvas for
      // non-POT textures) so the running-lights lamp-atlas pre-pass can read
      // its pixels.  `src` matches the exact coordinate space we uploaded,
      // so a generated atlas lines up 1:1 with the sampled texture.
      source: src,
      ready: true,
      width: w,
      height: h,
    })
  }

  // getLampMap returns a GL texture handle for the running-lights lamp
  // atlas of `name`, built for the given detection thresholds.  Returns
  // null until the base texture has decoded (the renderer then skips the
  // effect for that frame).  Cached by (name + thresholds) so it builds
  // once per distinct parameter set; the cache evicts oldest beyond a cap.
  getLampMap(name, opts = {}) {
    const base = (name || '').toLowerCase()
    if (!base) return null
    const keyBright = opts.keyBright != null ? opts.keyBright : 0.20
    const keySat = opts.keySat != null ? opts.keySat : 0.50
    const keyBrightHi = opts.keyBrightHi != null ? opts.keyBrightHi : 0.80
    const minRise = opts.minRise != null ? opts.minRise : 0.12
    const gapPx = Math.max(0, opts.gapPx != null ? opts.gapPx : 0)
    const colorMergePx = Math.max(0, opts.colorMergePx != null ? opts.colorMergePx : 4)
    const key = `${base}|${keyBright}|${keySat}|${keyBrightHi}|${minRise}|${gapPx}|${colorMergePx}`
    const cached = this.lampMaps.get(key)
    if (cached) return cached.ready ? cached : null

    const entry = this.entries.get(base)
    if (!entry || !entry.ready || !entry.source) {
      // Base texture not decoded yet — start its load so a later frame can
      // build the atlas, but don't cache a miss.
      this.get(name)
      return null
    }

    const built = this.#buildLampTexture(entry.source, { keyBright, keySat, keyBrightHi, minRise, gapPx, colorMergePx })
    this.lampMaps.set(key, built)
    if (this.lampMaps.size > LAMP_MAP_CACHE_MAX) {
      const oldest = this.lampMaps.keys().next().value
      const ev = this.lampMaps.get(oldest)
      if (ev?.tex) this.gl.deleteTexture(ev.tex)
      this.lampMaps.delete(oldest)
    }
    return built.ready ? built : null
  }

  #buildLampTexture(source, opts) {
    const gl = this.gl
    const w = source.naturalWidth || source.width
    const h = source.naturalHeight || source.height
    let rgba
    try {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const cx = canvas.getContext('2d', { willReadFrequently: true })
      cx.imageSmoothingEnabled = false
      cx.drawImage(source, 0, 0, w, h)
      rgba = cx.getImageData(0, 0, w, h).data
    } catch (err) {
      console.warn('lamp-map: could not read texture pixels:', err)
      return { tex: null, ready: false, width: w, height: h }
    }
    const atlas = buildLampAtlas(rgba, w, h, opts)
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    // Match the base texture's upload: flip Y so the atlas samples in the
    // same UV space, no premultiply.  Mipmaps give the shader a soft halo
    // sample for the emissive haze (the base is always uploaded POT, so the
    // atlas — built at the same dimensions — is POT too).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(atlas.buffer))
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return { tex, ready: true, width: w, height: h }
  }

  #nextPOT(v) {
    let p = 1
    while (p < v) p <<= 1
    return p
  }

  #isPowerOfTwo(n) {
    return n > 0 && (n & (n - 1)) === 0
  }

  #makeFallbackTexture() {
    const gl = this.gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    const pixel = new Uint8Array([0x70, 0x70, 0x78, 0xff])
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return { tex, ready: true, width: 1, height: 1 }
  }
}
