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

export class TextureCache {
  constructor(gl) {
    this.gl = gl
    this.entries = new Map() // key → { tex, image, ready, width, height }
    this.pending = new Map() // key → Promise<image>
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
      img.src = `/api/studio/texture/${encodeURIComponent(key)}`
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    // Mipmaps + trilinear filtering smooth the chunky TA palette
    // when textures are sampled at oblique angles or far from the
    // camera.  WebGL1's generateMipmap requires power-of-two
    // textures — TA's atlas tiles are all square POT (8 / 16 / 32 /
    // 64), so this is safe.
    const pot = this.#isPowerOfTwo(image.naturalWidth) && this.#isPowerOfTwo(image.naturalHeight)
    if (pot) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (this.anisoExt && this.anisoMax > 1) {
      gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, this.anisoMax))
    }
    this.entries.set(key, {
      tex,
      ready: true,
      width: image.naturalWidth,
      height: image.naturalHeight,
    })
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
