// studio-asset-provider.js
//
// The studio's implementation of @kbot/game3d's AssetProvider seam: every
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

import { setAssetProvider } from '@kbot/game3d'

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
}

export const studioAssetProvider = new StudioAssetProvider()
setAssetProvider(studioAssetProvider)
