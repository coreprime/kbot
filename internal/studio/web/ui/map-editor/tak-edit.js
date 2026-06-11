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
import { bumpContentVersion } from './content-cache.js'
import { renderCanvas } from './canvas/render.js'
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

// applyStampToLocalState mirrors a server-side section stamp into the
// editor's height layer and feature list. Heights come from the section's
// cached heights (preloaded for the placement overlay); when the cache is
// cold the whole map height layer is refetched instead. Feature placements
// covered by the stamp footprint are dropped — the stamp owns its area.
function applyStampToLocalState(sectionPath, gx, gy) {
  const mapAttrW = state.tileW * 2
  const mapAttrH = state.tileH * 2
  const duX = gx * 2
  const duY = gy * 2
  const sec = state.sectionHeights.get(sectionPath)
  if (sec && Array.isArray(sec.heights) && sec.attrW > 0) {
    for (let sy = 0; sy < sec.attrH; sy++) {
      const dy = duY + sy
      if (dy < 0 || dy >= mapAttrH) continue
      for (let sx = 0; sx < sec.attrW; sx++) {
        const dx = duX + sx
        if (dx < 0 || dx >= mapAttrW) continue
        state.heights[dy * mapAttrW + dx] = sec.heights[sy * sec.attrW + sx] | 0
      }
    }
    dropFeaturesInRect(duX, duY, sec.attrW, sec.attrH)
    bumpContentVersion()
    return
  }
  // Cache miss — refetch the whole map's height layer (the section-heights
  // endpoint parses any TA:K TNT, maps included).
  fetch(`/api/studio/section-heights/${encodeURI(currentTakMapPath)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !Array.isArray(data.heights)) return
      for (let i = 0; i < data.heights.length && i < state.heights.length; i++) {
        state.heights[i] = data.heights[i] | 0
      }
      bumpContentVersion()
      renderCanvas()
    })
    .catch(() => { /* alignment overlay degrades to stale heights */ })
}

// patchTakBackdrop blits a section's cached drawer render into the backdrop
// at graphic-unit (gx, gy), converting the backdrop Image to a canvas on
// first patch so later stamps draw into the same surface. Both renders come
// from the same terrain compositor, so the blit is pixel-faithful at the
// backdrop's scale. Returns false when either image isn't ready.
function patchTakBackdrop(sectionPath, gx, gy) {
  const backdrop = state.sectionImages.get(TAK_TERRAIN_KEY)
  const secImg = state.sectionImages.get(sectionPath)
  if (!backdrop || !secImg || !secImg.complete || !secImg.naturalWidth) return false
  const bw = backdrop.width || backdrop.naturalWidth
  const bh = backdrop.height || backdrop.naturalHeight
  if (!bw || !bh) return false
  let canvas = backdrop
  if (typeof HTMLCanvasElement === 'undefined' || !(backdrop instanceof HTMLCanvasElement)) {
    canvas = document.createElement('canvas')
    canvas.width = bw
    canvas.height = bh
    canvas.getContext('2d').drawImage(backdrop, 0, 0)
    state.sectionImages.set(TAK_TERRAIN_KEY, canvas)
  }
  const scale = bw / (state.tileW * 32)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(secImg, gx * 32 * scale, gy * 32 * scale, secImg.naturalWidth * scale, secImg.naturalHeight * scale)
  invalidateMinimapBase()
  hostCallbacks.renderCanvas?.()
  hostCallbacks.scheduleMinimapRender?.()
  return true
}

// dropFeaturesInRect removes placements whose anchor falls inside a stamped
// DataUnit rect — their cells were overwritten server-side.
function dropFeaturesInRect(duX, duY, w, h) {
  const before = state.features.length
  state.features = state.features.filter((f) =>
    !(f.ax >= duX && f.ax < duX + w && f.ay >= duY && f.ay < duY + h))
  if (state.features.length !== before) bumpContentVersion()
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
    // The stamp rewrote the map's DataUnits server-side; the client's
    // height layer and feature list must follow or the next placement's
    // alignment squares (and the feature overlay) compare against the
    // OLD terrain — which reads as "the heightmap was never applied".
    applyStampToLocalState(sectionPath, gx, gy)
    // Patch the backdrop in place by blitting the section's own render
    // (already cached for the drawer/placement preview) — a full backdrop
    // reload re-composites and re-decodes the whole map (seconds on big
    // maps) for every stamp. Falls back to the reload when the section
    // image isn't cached yet.
    if (!patchTakBackdrop(sectionPath, gx, gy)) {
      await reloadTakBackdrop()
    }
    setStatus(`Stamped section at graphic unit (${gx}, ${gy}).`)
  } catch (e) {
    setStatus(`Stamp error: ${e?.message || e}`)
  }
}
