// weapon-fx-loader.js
//
// Asynchronous loader for the real TA explosion APNGs served by the
// Go-side /api/studio/weapon-fx/{weapon}/{variant} endpoint.  One
// loader instance shared across the whole page — the cache key is
// (weapon, variant) so the same impact art only ever fetches once and
// every subsequent explosion at any unit clones the cached <img>.
//
// Result of a fetch is one of:
//   - HTMLImageElement that has finished decoding (success).  The
//     animation IS the APNG's native loop; consumers just position
//     the element and remove it after the desired lifeMs.
//   - null (404 / network error / weapon has no shipped explosion
//     art).  Consumers MUST fall back to the synthetic burst.
//
// Caches the negative case too — a 404'd weapon shouldn't re-fetch
// on every impact.

const _cache = new Map() // key: "WEAPON|variant" → Promise<HTMLImageElement|null>

// loadWeaponFx — fetch the APNG for (weapon, variant).  Returns a
// promise that resolves with the loaded image, or null when the
// server has no shipped art (HTTP 404).  Subsequent calls with the
// same key share the same promise, so a hundred bombs detonating
// in the same frame trigger one network request.
export function loadWeaponFx(weaponName, variant = 'ground') {
  if (!weaponName) return Promise.resolve(null)
  const key = `${String(weaponName).toUpperCase()}|${variant}`
  const cached = _cache.get(key)
  if (cached) return cached
  const url = `/api/studio/weapon-fx/${encodeURIComponent(weaponName)}/${encodeURIComponent(variant)}`
  const p = new Promise((resolve) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
  _cache.set(key, p)
  return p
}

// pickExplosionVariant — choose ground / water / lava from the impact
// Y position vs the scene's water plane.  Hosts pass their renderer /
// scene state in via `ctx`; `waterY` is the world-Y of the water
// surface (when groundMode is 'sea').  Lava worlds set `isLava=true`
// and the same waterY (lava and water both occupy the surface plane
// in TA's tile worlds).
export function pickExplosionVariant(impactY, ctx = {}) {
  const waterY = +ctx.waterY
  const hasWater = Number.isFinite(waterY)
  if (hasWater && impactY < waterY) return ctx.isLava ? 'lava' : 'water'
  return 'ground'
}

// clearWeaponFxCache — testing utility, also useful if a future
// content-reload needs to invalidate cached APNGs.
export function clearWeaponFxCache() { _cache.clear() }
