// scatter.js
//
// "Scatter features" dialog.  Drops N features into the map area
// (whole-map or current Select-Terrain rectangle) honouring a
// minimum spacing halo so the result reads as a natural
// distribution, not a clump.
//
// Three knobs:
//   - Names: comma-separated feature list (exact match).  Empty →
//     use whatever the user already filtered to in the features
//     drawer.
//   - Count: 1..5000.  Hard upper bound prevents runaway scatter
//     freezing the editor.
//   - Spacing: 0..64 attribute cells of halo around each placed
//     feature.  Includes existing features + voids in the
//     occupancy check.
//   - Seed: deterministic via mulberry32 when non-zero; rolls a
//     date-based seed when zero so each scatter is fresh.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas()        — repaint after the scatter commits
//   - bumpContentVersion()  — invalidate the minimap base canvas

import { state, $, clamp, setStatus, hostCallbacks } from '../../host-context.js'
import { beginTransaction, commitTransaction } from '../undo.js'
import { mulberry32, isWreckageFeature } from '../helpers.js'

export function openScatterDialog() {
  $('#scatter-dialog').classList.remove('hidden')
  $('#scatter-names').focus()
}

export function closeScatterDialog() {
  $('#scatter-dialog').classList.add('hidden')
}

export function applyScatter() {
  const namesIn = $('#scatter-names').value.trim()
  const count = clamp(parseInt($('#scatter-count').value, 10) || 0, 1, 5000)
  const spacingTiles = clamp(parseInt($('#scatter-spacing').value, 10) || 0, 0, 64)
  const seedIn = parseInt($('#scatter-seed').value, 10) || 0
  const area = $('#scatter-area').value
  const seed = seedIn > 0 ? seedIn : (Date.now() >>> 0)
  const rand = mulberry32(seed)

  // Resolve the feature pool.  If the user typed names, look
  // them up by exact (case-insensitive) name.  Otherwise honour
  // the current drawer filter — what's visible to the user is
  // what we scatter.
  const library = state.featuresList || []
  let pool = []
  if (namesIn) {
    const wanted = new Set(namesIn.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    for (const f of library) {
      if (wanted.has((f.name || '').toLowerCase())) pool.push(f)
    }
  } else {
    const q = (state.drawerFilters?.features || '').trim().toLowerCase()
    for (const f of library) {
      if (!state.includeWreckage && isWreckageFeature(f)) continue
      const hay = `${f.name || ''} ${f.world || ''} ${f.category || ''} ${f.description || ''}`.toLowerCase()
      if (q && !hay.includes(q)) continue
      pool.push(f)
    }
  }
  if (pool.length === 0) {
    setStatus('Scatter: no matching features.')
    return
  }

  // Build the legal area (attribute-cell rect).
  const attrW = state.tileW * 2
  const attrH = state.tileH * 2
  let x0 = 0, y0 = 0, x1 = attrW, y1 = attrH
  if (area === 'selection' && state.terrainClipboard) {
    const s = state.terrainClipboard
    x0 = s.tx * 2; y0 = s.ty * 2
    x1 = (s.tx + s.w) * 2; y1 = (s.ty + s.h) * 2
  }
  if (x1 <= x0 || y1 <= y0) {
    setStatus('Scatter: empty area.')
    return
  }

  // Occupancy: existing feature anchor cells, plus their
  // footprints, plus void cells.  Spacing is enforced by
  // stamping a halo of size spacingTiles*2 attr-cells around
  // each successful placement.
  const occupied = new Uint8Array(attrW * attrH)
  for (let i = 0; i < state.voids.length && i < occupied.length; i++) {
    if (state.voids[i]) occupied[i] = 1
  }
  const markCell = (ax, ay) => {
    if (ax >= 0 && ay >= 0 && ax < attrW && ay < attrH) occupied[ay * attrW + ax] = 1
  }
  const markFootprint = (ax, ay, fx, fz, halo) => {
    const r = halo
    for (let dy = -r; dy < fz + r; dy++) {
      for (let dx = -r; dx < fx + r; dx++) {
        markCell(ax + dx, ay + dy)
      }
    }
  }
  for (const f of state.features) {
    markFootprint(f.ax, f.ay, f.footprintX || 1, f.footprintZ || 1, 0)
  }

  const spacingHalo = spacingTiles * 2
  beginTransaction()
  let placed = 0
  let attempts = 0
  const maxAttempts = count * 20
  while (placed < count && attempts < maxAttempts) {
    attempts++
    const pick = pool[Math.floor(rand() * pool.length)]
    const fx = pick.footprintX || 1
    const fz = pick.footprintZ || 1
    const ax = x0 + Math.floor(rand() * Math.max(1, x1 - x0 - fx))
    const ay = y0 + Math.floor(rand() * Math.max(1, y1 - y0 - fz))
    // Reject if any cell of the footprint is occupied or void.
    let blocked = false
    for (let dy = 0; dy < fz && !blocked; dy++) {
      for (let dx = 0; dx < fx && !blocked; dx++) {
        const cx = ax + dx
        const cy = ay + dy
        if (cx < x0 || cy < y0 || cx >= x1 || cy >= y1) { blocked = true; break }
        if (occupied[cy * attrW + cx]) blocked = true
      }
    }
    if (blocked) continue
    state.features.push({
      name: pick.name,
      ax, ay,
      footprintX: fx,
      footprintZ: fz,
      previewUrl: pick.previewUrl || null,
      world: pick.world,
      category: pick.category,
      description: pick.description,
      originX: pick.originX || 0,
      originY: pick.originY || 0,
    })
    markFootprint(ax, ay, fx, fz, spacingHalo)
    placed++
  }
  hostCallbacks.bumpContentVersion?.()
  commitTransaction(`Scatter ${placed} feature${placed === 1 ? '' : 's'}`)
  closeScatterDialog()
  hostCallbacks.renderCanvas?.()
  setStatus(`Scattered ${placed} feature${placed === 1 ? '' : 's'} (seed ${seed}).`)
}
