// http-pack-provider.js
//
// HttpPackProvider — the AssetProvider (see assets.js) over a STATIC
// asset pack: a directory of pre-extracted JSON/PNG/WAV files produced by
// `kbot pack` and served by any plain HTTP host (S3/CloudFront, nginx,
// `python -m http.server`).  No studio server, no dynamic endpoints —
// every asset is one GET of an immutable file, so the whole pack is
// trivially CDN-cacheable and the renderer runs anywhere.
//
//   import { createWorld, HttpPackProvider } from '@kbot/game3d'
//   const world = await createWorld(canvas, {
//     assets: new HttpPackProvider('https://cdn.example.com/packs/ta-31c'),
//   })
//
// Pack layout (mirrors `kbot pack --help`):
//   manifest.json / unitdb.json / palette.json
//   models/<name>.json        cob/<name>.json
//   textures/<name>.png       (name--<side>.png for per-side variants)
//   sounds/<stem>.wav         weaponbitmaps/<weapon>.json
//   cursors/<sequence>.png    groundtiles/<tileset>.png
//   maps/<name>.json          (+ .tiles.png / .minimap.png)
//
// Filenames in a pack are lower-case with characters outside
// [a-z0-9._-] replaced by "_"; packStem() applies the identical mapping
// the extractor used so lookups agree byte-for-byte.

// packStem mirrors the Go extractor's filename sanitiser.
function packStem(name) {
  let out = ''
  for (const ch of String(name).trim().toLowerCase()) {
    out += /[a-z0-9._-]/.test(ch) ? ch : '_'
  }
  return out
}

// loadImage decodes a URL through an <img> element (not fetch+Blob) so the
// browser's HTTP cache applies and UNPACK_FLIP_Y_WEBGL keeps working (see
// toTexImageSource in assets.js for why ImageBitmap is avoided).
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.addEventListener('load', () => resolve(img), { once: true })
    img.addEventListener('error', () => reject(new Error(`image failed: ${url}`)), { once: true })
    img.src = url
  })
}

// neutralTexture is the client-side twin of the studio server's missing-
// texture fallback: a tiny grey canvas so a 3DO referencing an unpacked
// texture still renders instead of wedging the texture cache.
function neutralTexture() {
  const c = document.createElement('canvas')
  c.width = 2
  c.height = 2
  const cx = c.getContext('2d')
  cx.fillStyle = '#707078'
  cx.fillRect(0, 0, 2, 2)
  return c
}

export class HttpPackProvider {
  /**
   * @param {string} baseUrl  The pack directory's base URL (with or
   *   without a trailing slash).  Every asset resolves relative to it.
   */
  constructor(baseUrl) {
    if (!baseUrl) throw new Error('HttpPackProvider: a pack base URL is required')
    this.base = String(baseUrl).replace(/\/+$/, '') + '/'
  }

  url(rel) {
    return this.base + rel
  }

  async fetchJson(rel, what, { optional = false } = {}) {
    const resp = await fetch(this.url(rel))
    if (!resp.ok) {
      if (optional) return null
      throw new Error(`${what}: HTTP ${resp.status} for ${rel}`)
    }
    return resp.json()
  }

  async palette() {
    const json = await this.fetchJson('palette.json', 'palette')
    return json.palette || []
  }

  // enhanceMesh is accepted for contract parity but ignored: packs bake
  // the enhanced (hole-capped) geometry at extraction time, which is what
  // the sandbox renders by default anyway.
  async model(name) {
    return this.fetchJson(`models/${packStem(name)}.json`, `model ${name}`)
  }

  // name may carry a resolver query ("armkbot4?side=ara") — per-side
  // texture variants live at textures/<name>--<side>.png in a pack.
  async texture(name) {
    let stem = String(name)
    let side = ''
    const qi = stem.indexOf('?')
    if (qi !== -1) {
      const query = new URLSearchParams(stem.slice(qi + 1))
      side = query.get('side') || ''
      stem = stem.slice(0, qi)
    }
    const rel = side
      ? `textures/${packStem(stem)}--${packStem(side)}.png`
      : `textures/${packStem(stem)}.png`
    try {
      return await loadImage(this.url(rel))
    } catch {
      // Packs only ship textures that resolved at extraction time; a miss
      // here mirrors the studio server's neutral-grey fallback.
      return neutralTexture()
    }
  }

  // script resolves null on a miss — many units legitimately ship no COB.
  // Packs store the disassembly without the debug decompile text, so the
  // decompile flag is ignored.
  async script(name) {
    return this.fetchJson(`cob/${packStem(name)}.json`, `script ${name}`, { optional: true })
  }

  groundTile(tileset) {
    return loadImage(this.url(`groundtiles/${packStem(tileset)}.png`))
  }

  soundUrl(stem) {
    return this.url(`sounds/${packStem(stem)}.wav`)
  }

  cursorUrl(name) {
    return this.url(`cursors/${packStem(name)}.png`)
  }

  async weaponBitmap(weaponName) {
    return this.fetchJson(`weaponbitmaps/${packStem(weaponName)}.json`, `weapon bitmap ${weaponName}`, { optional: true })
  }

  // ── Driver-side surface (replayer / lobby / map viewer) ──

  async manifest() {
    return this.fetchJson('manifest.json', 'pack manifest')
  }

  async unitDB() {
    return this.fetchJson('unitdb.json', 'unit database')
  }

  async map(name) {
    return this.fetchJson(`maps/${packStem(name)}.json`, `map ${name}`)
  }
}
