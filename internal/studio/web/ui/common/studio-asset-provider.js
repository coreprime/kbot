// studio-asset-provider.js
//
// The studio's implementation of @coreprime/kbot-game3d's AssetProvider seam: every
// asset the renderer needs is answered from the studio Go server's
// /api/studio/* endpoints.  The URLs are plain absolute paths on purpose —
// the workspace URL shim in index.html patches fetch / Image.src /
// HTMLMediaElement.src to scope /api/… to the active workspace, and this
// provider goes through exactly those patched paths, so multi-workspace
// hubs keep working unchanged.
//
// Importing this module installs a singleton provider immediately
// (module-graph evaluation finishes before anything renders), mirroring
// how game-view3d.js applies the TA view tables at import time.

import { setAssetProvider } from '@coreprime/kbot-game3d'

async function fetchJson(url, what) {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`${what}: HTTP ${resp.status}`)
  return resp.json()
}

// loadImage decodes a URL through an <img> element (not fetch+Blob) so the
// browser cache and the URL shim's Image.src patch both apply.
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.addEventListener('load', () => resolve(img), { once: true })
    img.addEventListener('error', () => reject(new Error(`image failed: ${url}`)), { once: true })
    img.src = url
  })
}

export class StudioAssetProvider {
  async palette() {
    const json = await fetchJson('/api/studio/palette', 'palette')
    return json.palette || []
  }

  async model(name, { enhanceMesh = false } = {}) {
    const qs = enhanceMesh ? '?enhanceMesh=1' : ''
    return fetchJson(`/api/studio/model/${encodeURIComponent(name)}${qs}`, `model ${name}`)
  }

  // name may carry a resolver query ("armkbot4?side=ara") — split it out so
  // the name is encoded but the query reaches the server intact.
  texture(name) {
    const qi = name.indexOf('?')
    const url = qi === -1
      ? `/api/studio/texture/${encodeURIComponent(name)}`
      : `/api/studio/texture/${encodeURIComponent(name.slice(0, qi))}?${name.slice(qi + 1)}`
    return loadImage(url)
  }

  // script resolves null on 404 — many units legitimately ship no COB.
  async script(name, { decompile = false } = {}) {
    const resp = await fetch(`/api/studio/cob/${encodeURIComponent(name)}?decompile=${decompile ? 1 : 0}`)
    if (!resp.ok) return null
    return resp.json()
  }

  // scriptBytes resolves the unit's raw COB bytecode (the engine VM's
  // runnable form) as a Uint8Array, or null when the unit ships no script.
  async scriptBytes(name) {
    const resp = await fetch(`/api/studio/cob-bytes/${encodeURIComponent(name)}`)
    if (!resp.ok) return null
    const buf = await resp.arrayBuffer()
    return buf && buf.byteLength > 0 ? new Uint8Array(buf) : null
  }

  groundTile(tileset) {
    return loadImage(`/api/studio/ground-tile/${encodeURIComponent(tileset)}`)
  }

  soundUrl(stem) {
    return `/api/studio/sound/${encodeURIComponent(stem)}`
  }

  cursorUrl(name) {
    return `/api/studio/cursor/${name}`
  }

  async weaponBitmap(weaponName) {
    const resp = await fetch(`/api/studio/weapon-bitmap/${encodeURIComponent(weaponName)}`)
    if (!resp.ok) return null
    return resp.json()
  }

  // featureDefs answers the map-feature catalogue keyed by lower-case feature
  // id — each carries category, footprint, real TA height, GAF sprite dims and
  // (for real-model features) the 3DO object name. setTerrain's stand-in
  // builder sizes and classifies each feature from this, so trees stand at
  // their authored height, rocks at theirs, and flat resource sites (metal,
  // vents, scars) fall onto the decal path. {} when the workspace ships none —
  // stand-ins then use the small category-less defaults.
  async featureDefs() {
    try {
      return await fetchJson('/api/studio/feature-defs', 'feature defs')
    } catch {
      return {}
    }
  }

  // featureSprite resolves a flat-ground feature's real GAF art as an <img>
  // with alpha, which setTerrain paints onto the terrain as a ground decal.
  // The feature-preview endpoint renders the feature's first frame; static=1
  // pins it to a single frame (the decal is a still). Null on a miss.
  async featureSprite(spriteOrId) {
    const id = String(spriteOrId || '')
    if (!id) return null
    try {
      return await loadImage(`/api/studio/feature-preview/${encodeURIComponent(id)}?static=1`)
    } catch {
      return null
    }
  }

  // unitPic resolves a unit's build picture through the studio's buildpic
  // endpoint, or null when the install ships none — contract parity with
  // HttpPackProvider.unitPic (pack v3).
  async unitPic(name) {
    try {
      return await loadImage(`/api/studio/buildpic/${encodeURIComponent(name)}`)
    } catch {
      return null
    }
  }

  unitPicUrl(name) {
    return `/api/studio/buildpic/${encodeURIComponent(name)}`
  }
}

export const studioAssetProvider = new StudioAssetProvider()
setAssetProvider(studioAssetProvider)
