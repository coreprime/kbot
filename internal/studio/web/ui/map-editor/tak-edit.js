// tak-edit.js
//
// TA:Kingdoms maps are texture-mapped, not tile-stamped, so building them from
// sections happens server-side: the editor POSTs the dropped section + its
// graphic-unit position to /api/studio/tak-stamp, the backend composites the
// section's terrain into the map and saves it, and the editor reloads the
// terrain backdrop. This module holds the active TA:K map path and the
// stamp/reload helpers; the drop handler (editor-view.js) routes TA:K section
// drops here instead of the TA tile-stamp flow.

import { state, hostCallbacks, setStatus } from '../host-context.js'
import { TAK_TERRAIN_KEY, TAK_TERRAIN_EDITOR_MAX } from './constants.js'
import { invalidateMinimapBase } from './minimap.js'

// The VFS path of the currently-open TA:K map, or null for a TA map. Set by
// openLoadedMap when a texture-mapped map loads.
let currentTakMapPath = null

export function setCurrentTakMap(path) {
  currentTakMapPath = path || null
}

// isTakMapActive reports whether the active map is a loaded TA:K map (so the
// drop handler should composite via the server rather than stamp tiles).
export function isTakMapActive() {
  return !!currentTakMapPath && state.sectionImages.has(TAK_TERRAIN_KEY)
}

// getCurrentTakMapPath returns the open TA:K map's VFS path ('' for TA maps).
// The save payload carries it so the server updates the 0x4000 TNT in place
// instead of running the TA tile-pool builder.
export function getCurrentTakMapPath() {
  return isTakMapActive() ? currentTakMapPath : ''
}

function terrainURL(bust) {
  const p = currentTakMapPath.split('/').map(encodeURIComponent).join('/')
  const t = bust ? `&t=${Math.floor(performance.now())}` : ''
  return `/api/studio/map-render/${p}?max=${TAK_TERRAIN_EDITOR_MAX}${t}`
}

// reloadTakBackdrop re-fetches the (now-edited) terrain render and swaps it into
// the backdrop slot, refreshing the canvas + minimap once it has decoded.
function reloadTakBackdrop() {
  return new Promise((resolve) => {
    if (!currentTakMapPath) { resolve(); return }
    const img = new Image()
    const finish = (ok) => {
      if (ok) {
        state.sectionImages.set(TAK_TERRAIN_KEY, img)
        invalidateMinimapBase()
        hostCallbacks.renderCanvas?.()
        hostCallbacks.scheduleMinimapRender?.()
      }
      resolve()
    }
    img.addEventListener('load', () => finish(true), { once: true })
    img.addEventListener('error', () => finish(false), { once: true })
    img.src = terrainURL(true)
  })
}

// stampTakSection composites a section into the active TA:K map at graphic-unit
// (gx, gy) and reloads the backdrop. gx/gy are tile (= graphic-unit) coords from
// the canvas, which is exactly what the backend expects.
export async function stampTakSection(sectionPath, gx, gy) {
  if (!currentTakMapPath || !sectionPath) return
  setStatus('Stamping section…')
  try {
    const r = await fetch('/api/studio/tak-stamp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapPath: currentTakMapPath, sectionPath, gx, gy }),
    })
    if (!r.ok) {
      setStatus(`Stamp failed: ${await r.text()}`)
      return
    }
    await reloadTakBackdrop()
    setStatus(`Stamped section at graphic unit (${gx}, ${gy}).`)
  } catch (e) {
    setStatus(`Stamp error: ${e?.message || e}`)
  }
}
