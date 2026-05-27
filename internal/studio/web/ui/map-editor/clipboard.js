// clipboard.js
//
// Map editor clipboard, in two flavours:
//
//   - "Terrain clipboard" — the floating rectangle the user drags
//     around the map after a Select-Terrain capture (captureTerrain
//     lifts tiles + heights + features off into state.terrainClipboard).
//     Rotation, dropping back, and cancel-back-to-origin all happen
//     in-process; nothing leaves the browser tab.
//
//   - "System clipboard" — Ctrl+C / Ctrl+V / Ctrl+X.  Same payload
//     shape as the terrain clipboard, but serialised through
//     navigator.clipboard so the user can move terrain between two
//     KBot Studio tabs.  Payload is JSON tagged with the CLIP_PREFIX
//     magic prefix so a Ctrl+V from an unrelated app is ignored.
//
// External callbacks (renderCanvas, setMode, ...) are looked up via
// hostCallbacks rather than imported directly, so this module stays
// free of cycles during the studio.js extraction.

import { state, setStatus, clamp, hostCallbacks } from '../host-context.js'
import { CLIP_PREFIX } from './constants.js'
import { beginTransaction, commitTransaction } from './undo.js'

// shrinkRectToContent returns the tightest tile-grid bounding box
// of any stamped tile or placed feature inside the given rectangle.
// When the rectangle is empty (nothing inside it) we return null so
// the caller can no-op the capture.
export function shrinkRectToContent(x, y, w, h) {
  let minTX = Infinity, maxTX = -Infinity
  let minTY = Infinity, maxTY = -Infinity
  let found = false

  const x2 = x + w, y2 = y + h
  for (let ty = y; ty < y2; ty++) {
    if (ty < 0 || ty >= state.tileH) continue
    for (let tx = x; tx < x2; tx++) {
      if (tx < 0 || tx >= state.tileW) continue
      if (state.tiles[ty * state.tileW + tx]) {
        if (tx < minTX) minTX = tx
        if (tx > maxTX) maxTX = tx
        if (ty < minTY) minTY = ty
        if (ty > maxTY) maxTY = ty
        found = true
      }
    }
  }

  // Features live on the 16-px attribute grid.  Convert to tile
  // coords via floor(ax/2), floor(ay/2) and fold them into the
  // bounding box.
  const minAX = x * 2, maxAX = x2 * 2
  const minAY = y * 2, maxAY = y2 * 2
  for (const f of state.features) {
    if (f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY) {
      const fTX = Math.floor(f.ax / 2)
      const fTY = Math.floor(f.ay / 2)
      if (fTX < minTX) minTX = fTX
      if (fTX > maxTX) maxTX = fTX
      if (fTY < minTY) minTY = fTY
      if (fTY > maxTY) maxTY = fTY
      found = true
    }
  }
  if (!found) return null
  return { x: minTX, y: minTY, w: maxTX - minTX + 1, h: maxTY - minTY + 1 }
}

// captureTerrain pulls a rectangle of tiles + heights into a
// floating "clipboard" the user can drag around the map.  The
// source region on the map is cleared (so the drag visibly lifts
// the terrain off).
//
// Features whose attribute position falls inside the rectangle are
// also lifted off the map and stored with positions relative to the
// rectangle's top-left, so rotation/move acts on them as a group.
export function captureTerrain(x, y, w, h) {
  const tiles = new Array(w * h).fill(null)
  const heights = new Array(w * 2 * h * 2).fill(80)
  const mapAttrW = state.tileW * 2
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const mx = x + dx, my = y + dy
      const cell = state.tiles[my * state.tileW + mx]
      if (cell) tiles[dy * w + dx] = { ...cell }
      state.tiles[my * state.tileW + mx] = null
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          const srcAY = my * 2 + qy
          const srcAX = mx * 2 + qx
          heights[(dy * 2 + qy) * (w * 2) + (dx * 2 + qx)] = state.heights[srcAY * mapAttrW + srcAX]
          state.heights[srcAY * mapAttrW + srcAX] = 80
        }
      }
    }
  }

  // Pick up features inside the rectangle (attribute coords).
  const minAX = x * 2, maxAX = (x + w) * 2 // exclusive on the upper end
  const minAY = y * 2, maxAY = (y + h) * 2
  const features = []
  state.features = state.features.filter((f) => {
    if (f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY) {
      features.push({ ...f, ax: f.ax - minAX, ay: f.ay - minAY })
      return false
    }
    return true
  })

  state.terrainClipboard = { tx: x, ty: y, w, h, tiles, heights, features, rotation: 0 }
  // The placement hint pill normally hides the rotation row for
  // features — explicitly pass 'section' so the Q/E hint stays
  // visible for terrain selections too.
  hostCallbacks.showPlacementHint?.(`Moving ${w}×${h} terrain selection`, 'section')
  const fNote = features.length > 0 ? ` plus ${features.length} feature${features.length === 1 ? '' : 's'}` : ''
  setStatus(`Captured ${w}×${h} terrain${fNote}.  Drag to move, Q/E to rotate, click outside to drop, Esc to put back.`)
  hostCallbacks.renderCanvas?.()
}

// rotateTerrainClipboard rotates the captured rectangle in place by
// ±90°.  Each cell's stored rotation is also updated so the section
// graphics still face the right way after the rectangle is dropped.
export function rotateTerrainClipboard(dir) {
  const c = state.terrainClipboard
  if (!c) return
  const oldW = c.w, oldH = c.h
  const newW = oldH, newH = oldW
  const newTiles = new Array(newW * newH).fill(null)
  const newHeights = new Array(newW * 2 * newH * 2).fill(80)
  const oldAttrW = oldW * 2
  const newAttrW = newW * 2

  for (let ry = 0; ry < newH; ry++) {
    for (let rx = 0; rx < newW; rx++) {
      // 90° CW: new(rx, ry) ← old(oy=oldH-1-rx, ox=ry) —
      // equivalently ox=ry, oy=oldW-1-rx.  CCW is its inverse.
      const ox = dir > 0 ? ry : (oldH - 1 - ry)
      const oy = dir > 0 ? (oldW - 1 - rx) : rx
      const cell = c.tiles[oy * oldW + ox]
      if (cell) {
        newTiles[ry * newW + rx] = {
          ...cell,
          rotation: ((cell.rotation || 0) + (dir > 0 ? 1 : 3)) & 3,
        }
      }
      // Rotate the 2×2 attribute sub-cells along with the tile so
      // the alignment hints stay accurate after the rotation.
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          let sqx, sqy
          if (dir > 0) { sqx = qy; sqy = 1 - qx }
          else { sqx = 1 - qy; sqy = qx }
          const srcAY = oy * 2 + sqy
          const srcAX = ox * 2 + sqx
          if (srcAX >= 0 && srcAY >= 0 && srcAY * oldAttrW + srcAX < c.heights.length) {
            newHeights[(ry * 2 + qy) * newAttrW + (rx * 2 + qx)] = c.heights[srcAY * oldAttrW + srcAX]
          }
        }
      }
    }
  }
  c.tiles = newTiles
  c.heights = newHeights

  // Rotate the carried features' attribute positions so they stay
  // aligned with the tiles they were sitting on.  Coordinates are
  // (ax, ay) in attr cells, range [0..oldW*2) × [0..oldH*2).
  if (c.features && c.features.length) {
    const oldAW = oldW * 2
    const oldAH = oldH * 2
    c.features = c.features.map((f) => {
      let nax, nay
      if (dir > 0) {
        // 90° CW: (ax, ay) → ((oldAH-1) - ay, ax)
        nax = (oldAH - 1) - f.ay
        nay = f.ax
      } else {
        // 90° CCW: (ax, ay) → (ay, (oldAW-1) - ax)
        nax = f.ay
        nay = (oldAW - 1) - f.ax
      }
      // Asymmetric footprints rotate too — swap the X/Z extents.
      const newFootprintX = f.footprintZ || 1
      const newFootprintZ = f.footprintX || 1
      return {
        ...f,
        ax: nax,
        ay: nay,
        footprintX: newFootprintX,
        footprintZ: newFootprintZ,
      }
    })
  }

  c.w = newW
  c.h = newH
  c.rotation = ((c.rotation || 0) + (dir > 0 ? 1 : 3)) & 3
}

// dropTerrainClipboard pastes the floating selection back into the
// map at its current (tx, ty) position, clipping anything that
// hangs off the edge.
export function dropTerrainClipboard() {
  const c = state.terrainClipboard
  if (!c) return
  const mapAttrW = state.tileW * 2
  const mapAttrH = state.tileH * 2
  // A "paste features only" clipboard intentionally carries no tile
  // or heightmap data; skip the tile overlay so the existing map
  // under the dropped rectangle stays intact.  Features still
  // re-attach below.
  if (!c.skipTiles) {
    for (let dy = 0; dy < c.h; dy++) {
      for (let dx = 0; dx < c.w; dx++) {
        const mx = c.tx + dx, my = c.ty + dy
        if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) continue
        const cell = c.tiles[dy * c.w + dx]
        if (cell) state.tiles[my * state.tileW + mx] = { ...cell }
        for (let qy = 0; qy < 2; qy++) {
          for (let qx = 0; qx < 2; qx++) {
            const h = c.heights[(dy * 2 + qy) * (c.w * 2) + (dx * 2 + qx)]
            state.heights[(my * 2 + qy) * mapAttrW + (mx * 2 + qx)] = h
          }
        }
      }
    }
  }
  // Re-attach the carried features.  Features whose anchor lands
  // off-map after the move are dropped on the floor so they don't
  // pollute the saved file.
  if (c.features) {
    for (const f of c.features) {
      const nax = c.tx * 2 + f.ax
      const nay = c.ty * 2 + f.ay
      if (nax < 0 || nay < 0 || nax >= mapAttrW || nay >= mapAttrH) continue
      state.features.push({ ...f, ax: nax, ay: nay })
    }
  }
  state.terrainClipboard = null
  hostCallbacks.hidePlacementHint?.()
  setStatus('Terrain dropped.')
  hostCallbacks.renderCanvas?.()
}

export function cancelTerrainClipboard() {
  if (!state.terrainClipboard) return
  // We don't track the original capture origin, so cancelling just
  // drops the clipboard back at its current position.
  dropTerrainClipboard()
}

// extractTerrainRect pulls a non-destructive copy of a tile
// rectangle + its attribute-cell heights + any features whose
// anchor lies inside it.  Used by copyToClipboard so a Ctrl+C
// doesn't disturb the map the way captureTerrain() (drag-to-move)
// does.
export function extractTerrainRect(x, y, w, h) {
  const tiles = new Array(w * h).fill(null)
  const heights = new Array(w * 2 * h * 2).fill(80)
  const mapAttrW = state.tileW * 2
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const mx = x + dx, my = y + dy
      const cell = state.tiles[my * state.tileW + mx]
      if (cell) tiles[dy * w + dx] = { ...cell }
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          const srcAY = my * 2 + qy
          const srcAX = mx * 2 + qx
          heights[(dy * 2 + qy) * (w * 2) + (dx * 2 + qx)] = state.heights[srcAY * mapAttrW + srcAX]
        }
      }
    }
  }
  const minAX = x * 2, maxAX = (x + w) * 2
  const minAY = y * 2, maxAY = (y + h) * 2
  const features = []
  for (const f of state.features) {
    if (f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY) {
      features.push({ ...f, ax: f.ax - minAX, ay: f.ay - minAY })
    }
  }
  return { w, h, tiles, heights, features }
}

// clearRegion wipes tiles + heights + features inside the current
// Select-Terrain rectangle.  Different from the Erase brush: this
// clears the entire selection in one transactional shot, with a
// status update and undo support.  No-op when nothing is selected.
export function clearRegion() {
  const r = state.rectSelection
  if (!r || r.w <= 0 || r.h <= 0) {
    setStatus('Nothing to clear — make a Select-Terrain rectangle first.')
    return
  }
  beginTransaction()
  const mapAttrW = state.tileW * 2
  let tilesCleared = 0
  let heightsTouched = 0
  for (let dy = 0; dy < r.h; dy++) {
    for (let dx = 0; dx < r.w; dx++) {
      const mx = r.x + dx, my = r.y + dy
      const idx = my * state.tileW + mx
      if (state.tiles[idx]) { state.tiles[idx] = null; tilesCleared++ }
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          const ay = my * 2 + qy
          const ax = mx * 2 + qx
          const ai = ay * mapAttrW + ax
          if (state.heights[ai] !== 80) { state.heights[ai] = 80; heightsTouched++ }
        }
      }
    }
  }
  const minAX = r.x * 2, maxAX = (r.x + r.w) * 2
  const minAY = r.y * 2, maxAY = (r.y + r.h) * 2
  const before = state.features.length
  state.features = state.features.filter((f) => !(f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY))
  const featuresRemoved = before - state.features.length
  // Reset feature selection if any of its members disappeared.
  if (state.selectedFeature >= 0 && state.selectedFeature >= state.features.length) state.selectedFeature = -1
  if (state.selectedFeatures?.size) state.selectedFeatures.clear()
  commitTransaction(`Clear ${r.w}×${r.h} region`)
  setStatus(`Cleared ${r.w}×${r.h} region — ${tilesCleared} tile(s), ${heightsTouched} height cell(s), ${featuresRemoved} feature(s).`)
  hostCallbacks.renderCanvas?.()
}

// cutSelection = Copy + Clear region, all in one transactional
// shot.  Falls through cleanly if there's nothing to act on.
export async function cutSelection() {
  // Build the clipboard payload synchronously so it survives any
  // events that fire during the async clipboard write below.  Doing
  // it in this order also means an aborted clipboard write doesn't
  // leave the user with an unexpected "selection cleared but no
  // paste available" state — the clear only happens once the
  // payload is locked in.
  let payload = null
  if (state.terrainClipboard) {
    const c = state.terrainClipboard
    payload = { w: c.w, h: c.h, tiles: c.tiles, heights: c.heights, features: c.features }
  } else if (state.rectSelection) {
    const r = state.rectSelection
    payload = extractTerrainRect(r.x, r.y, r.w, r.h)
  }
  if (!payload) {
    setStatus('Nothing to cut — make a Select-Terrain rectangle first.')
    return
  }
  // Clear synchronously *before* the clipboard write.  This way, an
  // event firing during the await can't sneak in and lose
  // state.rectSelection out from under clearRegion().  When the
  // selection was already a terrainClipboard (drag-lifted), the
  // source cells are already empty so no extra clear is needed.
  const hadRectSelection = !!state.rectSelection
  if (hadRectSelection) {
    clearRegion()
  } else if (state.terrainClipboard) {
    // Drag-lifted content already has its source cells cleared (the
    // captureTerrain that lifted it did that).  Cut should discard
    // the lifted clipboard *without* re-pasting it — that's the
    // point of cut vs. cancel.  Run inside a transaction so the
    // operation is undoable.
    beginTransaction()
    state.terrainClipboard = null
    hostCallbacks.hidePlacementHint?.()
    commitTransaction(`Cut ${payload.w}×${payload.h} terrain`)
    hostCallbacks.renderCanvas?.()
  }
  try {
    await navigator.clipboard.writeText(CLIP_PREFIX + JSON.stringify(payload))
    setStatus(`Cut ${payload.w}×${payload.h} terrain rectangle to clipboard.`)
  } catch (err) {
    // Clipboard permissions can deny the write (no document focus,
    // sandbox, etc.).  The local clear already happened — flag it
    // so the user knows their content isn't on the system clipboard.
    setStatus(`Cut cleared the selection, but clipboard write failed: ${err.message || err}`)
  }
}

// clearAllFeatures wipes every placed feature from the map.
// Voids, tiles and heights are left alone.  Annihilator names this
// "Features → Clear All".
export function clearAllFeatures() {
  if (!state.features || state.features.length === 0) {
    setStatus('No features placed.')
    return
  }
  beginTransaction()
  const removed = state.features.length
  state.features = []
  state.selectedFeature = -1
  if (state.selectedFeatures?.size) state.selectedFeatures.clear()
  commitTransaction(`Clear ${removed} feature(s)`)
  setStatus(`Removed ${removed} feature(s) from the map.`)
  hostCallbacks.renderCanvas?.()
}

// clearFeaturesInSelection removes only the features whose anchor
// lies inside the current Select-Terrain rectangle.  Tiles +
// heights untouched.  Annihilator's "Features → Clear Selection".
export function clearFeaturesInSelection() {
  const r = state.rectSelection
  if (!r || r.w <= 0 || r.h <= 0) {
    setStatus('Nothing to clear — make a Select-Terrain rectangle first.')
    return
  }
  const minAX = r.x * 2, maxAX = (r.x + r.w) * 2
  const minAY = r.y * 2, maxAY = (r.y + r.h) * 2
  const inside = state.features.filter((f) => f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY)
  if (inside.length === 0) {
    setStatus('No features inside the current selection.')
    return
  }
  beginTransaction()
  state.features = state.features.filter((f) => !(f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY))
  state.selectedFeature = -1
  if (state.selectedFeatures?.size) state.selectedFeatures.clear()
  commitTransaction(`Clear ${inside.length} feature(s) in selection`)
  setStatus(`Removed ${inside.length} feature(s) inside the selection.`)
  hostCallbacks.renderCanvas?.()
}

export async function copyToClipboard() {
  let payload = null
  if (state.terrainClipboard) {
    const c = state.terrainClipboard
    payload = { w: c.w, h: c.h, tiles: c.tiles, heights: c.heights, features: c.features }
  } else if (state.rectSelection) {
    const r = state.rectSelection
    payload = extractTerrainRect(r.x, r.y, r.w, r.h)
  }
  if (!payload) {
    setStatus('Nothing to copy — make a Select-Terrain rectangle first.')
    return
  }
  try {
    await navigator.clipboard.writeText(CLIP_PREFIX + JSON.stringify(payload))
    setStatus(`Copied ${payload.w}×${payload.h} terrain rectangle to clipboard.`)
  } catch (err) {
    setStatus(`Copy failed: ${err.message || err}`)
  }
}

// pasteFromClipboard stages the clipboard payload as a
// terrainClipboard the user can position then drop.  `mode` filters
// what comes along:
//   'all'      — tiles + heights + features (default)
//   'tiles'    — tiles + heights only; features dropped on the floor
//   'features' — features only; tiles and heightmap left blank so a
//                drop overlays the existing map without disturbing it
export async function pasteFromClipboard(mode = 'all') {
  let text
  try { text = await navigator.clipboard.readText() }
  catch (err) { setStatus(`Paste failed: ${err.message || err}`); return }
  if (!text || !text.startsWith(CLIP_PREFIX)) {
    setStatus('Clipboard does not contain a KBot Studio selection.')
    return
  }
  let payload
  try { payload = JSON.parse(text.slice(CLIP_PREFIX.length)) }
  catch { setStatus('Clipboard data is corrupted.'); return }
  if (!payload || !Number.isInteger(payload.w) || !Number.isInteger(payload.h) || payload.w <= 0 || payload.h <= 0) {
    setStatus('Clipboard data is invalid.')
    return
  }
  // Drop any in-flight selection / placement so the pasted
  // clipboard is the only thing the user has to drag around.
  if (state.terrainClipboard) cancelTerrainClipboard()
  hostCallbacks.cancelPlacement?.()
  state.rectSelection = null
  // Anchor at the cursor's last hover cell when available, else
  // the map centre.  The user can drag from there before clicking
  // outside to commit.
  const w = payload.w, h = payload.h
  let tx, ty
  const lastHover = hostCallbacks.cursor.lastHover
  if (lastHover) {
    tx = clamp(lastHover.tx - Math.floor(w / 2), 0, Math.max(0, state.tileW - w))
    ty = clamp(lastHover.ty - Math.floor(h / 2), 0, Math.max(0, state.tileH - h))
  } else {
    tx = Math.max(0, Math.floor((state.tileW - w) / 2))
    ty = Math.max(0, Math.floor((state.tileH - h) / 2))
  }
  const includeTiles = mode === 'all' || mode === 'tiles'
  const includeFeatures = mode === 'all' || mode === 'features'
  state.terrainClipboard = {
    tx, ty, w, h,
    tiles: includeTiles
      ? (payload.tiles || new Array(w * h).fill(null))
      : new Array(w * h).fill(null),
    heights: includeTiles
      ? (payload.heights || new Array(w * 2 * h * 2).fill(80))
      : new Array(w * 2 * h * 2).fill(80),
    features: includeFeatures ? (payload.features || []) : [],
    rotation: 0,
    // When pasting tiles-only or features-only, mark the clipboard
    // so dropTerrainClipboard can skip overlaying the empty layer
    // the user didn't ask for.
    skipTiles: !includeTiles,
  }
  if (state.mode !== 'select-terrain') hostCallbacks.setMode?.('select-terrain')
  const what = mode === 'tiles' ? 'tiles' : mode === 'features' ? 'features' : 'terrain'
  hostCallbacks.showPlacementHint?.(`Pasting ${w}×${h} ${what} rectangle`, 'section')
  setStatus(`Pasted ${w}×${h} ${what}.  Drag to move, Q/E to rotate, click outside to drop, Esc to cancel.`)
  hostCallbacks.renderCanvas?.()
}
