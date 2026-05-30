// weapon-bitmap-loader.js
//
// Fetches an animated bitmap projectile sprite from the Go side and
// caches the result indefinitely.  See internal/studio/weapon_bitmap.go
// for the matching endpoint + the "color slot = fx.gaf index" hack
// being faithfully reproduced.
//
// The fetched payload is a horizontal sprite sheet (PNG) plus frame
// metadata (frameCount, frameWidth, frameDurationMs, originX/Y).  We
// decode the PNG into a JS Image() so the renderer can upload it as a
// texture; metadata + the Image come back together in one resolved
// Promise so the spawn site just calls `await loadWeaponBitmap(name)`
// and gets a ready-to-render sprite.
//
// Cache shape: weapon-name (uppercased + trimmed) → Promise<bitmap|null>.
// `null` means we tried and the server 404'd; the cached null prevents
// re-querying on every shot of a non-bitmap weapon.

const SPRITE_ENDPOINT = '/api/studio/weapon-bitmap/'

const _cache = new Map()

// loadWeaponBitmap returns a Promise that resolves to either:
//   { image, frameCount, frameWidth, frameHeight, sheetWidth,
//     sheetHeight, frameDurationMs, originX, originY, sequence }
// or `null` when the weapon has no bitmap projectile.  Always returns
// the SAME promise for the same weapon — callers can rely on shared
// referential identity to dedupe state.
export function loadWeaponBitmap(weaponName) {
  if (!weaponName) return Promise.resolve(null)
  const key = String(weaponName).trim().toUpperCase()
  if (!key) return Promise.resolve(null)
  if (_cache.has(key)) return _cache.get(key)

  const promise = (async () => {
    const url = SPRITE_ENDPOINT + encodeURIComponent(weaponName)
    let resp
    try {
      resp = await fetch(url)
    } catch {
      return null
    }
    if (!resp.ok) return null
    let meta
    try {
      meta = await resp.json()
    } catch {
      return null
    }
    if (!meta || !meta.sheet || meta.frameCount <= 0) return null

    const image = await _decodeBase64Png(meta.sheet)
    if (!image) return null
    return {
      image,
      frameCount:      meta.frameCount | 0,
      frameWidth:      meta.frameWidth | 0,
      frameHeight:     meta.frameHeight | 0,
      sheetWidth:      meta.sheetWidth | 0,
      sheetHeight:     meta.sheetHeight | 0,
      frameDurationMs: Math.max(16, meta.frameDurationMs | 0),
      originX:         meta.originX | 0,
      originY:         meta.originY | 0,
      sequence:        String(meta.sequence || ''),
    }
  })()
  _cache.set(key, promise)
  return promise
}

// clearWeaponBitmapCache drops the entire cache.  Used by tests and by
// the studio reset path so a re-opened tab gets a clean slate.  Live
// promises continue resolving in-flight; new fetches go through.
export function clearWeaponBitmapCache() { _cache.clear() }

// _decodeBase64Png turns a base64 PNG string into an HTMLImageElement
// the GL texture upload can consume.  Returns null on decode failure
// so the caller's fallback path (synthetic point sprite) kicks in.
function _decodeBase64Png(b64) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = 'data:image/png;base64,' + b64
  })
}
