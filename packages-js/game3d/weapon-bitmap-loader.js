// weapon-bitmap-loader.js
//
// Pulls an animated bitmap projectile sprite through the configured
// AssetProvider (provider.weaponBitmap(name)) and caches the result
// indefinitely.
//
// The payload is a horizontal sprite sheet (base64 PNG under `sheet`)
// plus frame metadata (frameCount, frameWidth, frameDurationMs,
// originX/Y).  We decode the PNG into a JS Image() so the renderer can
// upload it as a texture; metadata + the Image come back together in
// one resolved Promise so the spawn site just calls
// `await loadWeaponBitmap(name)` and gets a ready-to-render sprite.
//
// Cache shape: weapon-name (uppercased + trimmed) → Promise<bitmap|null>.
// `null` means we tried and the server 404'd; the cached null prevents
// re-querying on every shot of a non-bitmap weapon.

import { getAssetProvider } from './assets.js'

const _cache = new Map()

// loadWeaponBitmap returns a Promise that resolves to either:
//   { image, frameCount, frameWidth, frameHeight, sheetWidth,
//     sheetHeight, frameDurationMs, originX, originY, sequence }
// or `null` when the weapon has no bitmap projectile (or the provider
// doesn't serve weapon bitmaps).  Always returns
// the SAME promise for the same weapon — callers can rely on shared
// referential identity to dedupe state.
export function loadWeaponBitmap(weaponName) {
  if (!weaponName) return Promise.resolve(null)
  const key = String(weaponName).trim().toUpperCase()
  if (!key) return Promise.resolve(null)
  if (_cache.has(key)) return _cache.get(key)

  const promise = (async () => {
    const provider = getAssetProvider()
    if (!provider || typeof provider.weaponBitmap !== 'function') return null
    let meta
    try {
      meta = await provider.weaponBitmap(weaponName)
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
