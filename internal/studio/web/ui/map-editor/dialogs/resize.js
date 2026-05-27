// resize.js
//
// "Resize map" dialog.  Lets the user grow or shrink the canvas
// without losing the bits they want to keep.
//
// Two paths in:
//   - Anchor grid (3×3): existing content is pinned to one of the
//     nine compass points; growth pads the opposite edges; shrink
//     trims them.  Live preview counts how many tiles + features
//     would fall off the edge.
//   - "Crop to content": auto-computes the tightest bounding box
//     around every stamped tile and placed feature (with a 1-tile
//     margin), re-pins the anchor to top-left, and stashes a
//     pendingCropOffset so Apply pulls content out of the top-left
//     instead of padding it in.
//
// Apply rebuilds the tile / heights / voids / features arrays at
// the new dimensions in a single undo transaction, then recreates
// the canvas DOM + GL context — the previous bug class came from
// re-using existing canvas elements at a different size.
//
// Cross-module deps via hostCallbacks:
//   - renderMapTabs()       — refresh tab chip sizes after resize
//   - recreateEditorView()  — fresh canvas + GL at new dimensions
//   - renderCanvas()        — first paint at new dimensions

import { state, $, clamp, setStatus, hostCallbacks } from '../../host-context.js'
import { beginTransaction, commitTransaction } from '../undo.js'
import { shrinkRectToContent } from '../clipboard.js'

// resizeState — anchor row + column in [0..2].  Mutable on a plain
// object so the click handlers can write through.
const resizeState = { anchorRow: 1, anchorCol: 1 }

// _state.pendingCropOffset is non-null when the user has just
// clicked "Crop to content" — applyResize honours it by offsetting
// the source rect instead of using the anchor.  Cleared on close.
const _state = { pendingCropOffset: null }

export function wireResizeDialog() {
  const grid = $('#resize-anchor')
  grid.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      resizeState.anchorRow = parseInt(btn.dataset.r, 10)
      resizeState.anchorCol = parseInt(btn.dataset.c, 10)
      grid.querySelectorAll('button').forEach((b) => b.classList.toggle(
        'selected',
        b.dataset.r === btn.dataset.r && b.dataset.c === btn.dataset.c,
      ))
      updateResizePreview()
    })
  })
  $('#resize-w').addEventListener('input', updateResizePreview)
  $('#resize-h').addEventListener('input', updateResizePreview)
  $('#resize-cancel').addEventListener('click', closeResizeDialog)
  $('#resize-apply').addEventListener('click', applyResize)
  $('#resize-crop')?.addEventListener('click', cropToContent)
}

// cropToContent shrinks the map to the bounding box of every
// stamped tile + every placed feature, with a one-tile margin so
// things aren't flush against the new edge.  Driven from the
// Resize dialog so the user can review the new dimensions before
// committing.
function cropToContent() {
  // Tile bounds.
  let bounds = shrinkRectToContent(0, 0, state.tileW, state.tileH)
  let minX = bounds.w > 0 ? bounds.x : null
  let minY = bounds.h > 0 ? bounds.y : null
  let maxX = bounds.w > 0 ? bounds.x + bounds.w - 1 : null
  let maxY = bounds.h > 0 ? bounds.y + bounds.h - 1 : null
  // Feature bounds — features sit on the 16-px attribute grid, so
  // divide by 2 to get back to tile coords and widen by the
  // footprint.
  for (const f of state.features || []) {
    const fx = Math.floor(f.ax / 2)
    const fy = Math.floor(f.ay / 2)
    const fw = Math.max(1, Math.ceil((f.footprintX || 1) / 2))
    const fh = Math.max(1, Math.ceil((f.footprintZ || 1) / 2))
    const lo = { x: fx, y: fy }
    const hi = { x: fx + fw - 1, y: fy + fh - 1 }
    if (minX == null || lo.x < minX) minX = lo.x
    if (minY == null || lo.y < minY) minY = lo.y
    if (maxX == null || hi.x > maxX) maxX = hi.x
    if (maxY == null || hi.y > maxY) maxY = hi.y
  }
  if (minX == null) {
    setStatus('Nothing to crop — the map is empty.')
    return
  }
  // Add a one-tile margin and clamp to the map.
  const margin = 1
  minX = Math.max(0, minX - margin)
  minY = Math.max(0, minY - margin)
  maxX = Math.min(state.tileW - 1, maxX + margin)
  maxY = Math.min(state.tileH - 1, maxY + margin)
  const newW = clamp(maxX - minX + 1, 16, 256)
  const newH = clamp(maxY - minY + 1, 16, 256)
  // Re-pin to top-left so the anchor offset maps directly to the
  // bounding-box origin.
  resizeState.anchorRow = 0
  resizeState.anchorCol = 0
  $('#resize-anchor').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('selected', b.dataset.r === '0' && b.dataset.c === '0')
  })
  $('#resize-w').value = newW
  $('#resize-h').value = newH
  _state.pendingCropOffset = { x: minX, y: minY }
  updateResizePreview()
  setStatus(`Cropping to ${newW}×${newH} starting at (${minX}, ${minY}).  Click Apply to confirm.`)
}

export function openResizeDialog() {
  $('#resize-w').value = state.tileW
  $('#resize-h').value = state.tileH
  _state.pendingCropOffset = null
  updateResizePreview()
  $('#resize-dialog').classList.remove('hidden')
}

export function closeResizeDialog() {
  $('#resize-dialog').classList.add('hidden')
  _state.pendingCropOffset = null
}

// updateResizePreview shows the user-visible offsets in tiles so
// they can see at a glance what content survives a shrink or where
// the existing content lands inside a larger canvas.
function updateResizePreview() {
  const newW = clamp(parseInt($('#resize-w').value, 10) || state.tileW, 16, 256)
  const newH = clamp(parseInt($('#resize-h').value, 10) || state.tileH, 16, 256)
  const oldW = state.tileW
  const oldH = state.tileH
  const { offsetX, offsetY } = anchorOffsets(oldW, oldH, newW, newH)
  const dW = newW - oldW
  const dH = newH - oldH
  // Count tiles and features that would fall outside the new canvas
  // with the current anchor offset.  Iterates the live grid so it
  // tracks any in-progress edits accurately.
  let lostTiles = 0
  for (let oy = 0; oy < oldH; oy++) {
    const ny = oy + offsetY
    for (let ox = 0; ox < oldW; ox++) {
      if (!state.tiles[oy * oldW + ox]) continue
      const nx = ox + offsetX
      if (nx < 0 || ny < 0 || nx >= newW || ny >= newH) lostTiles++
    }
  }
  let lostFeatures = 0
  const attrOffX = offsetX * 2
  const attrOffY = offsetY * 2
  const newAttrW = newW * 2
  const newAttrH = newH * 2
  for (const f of state.features) {
    const nax = f.ax + attrOffX
    const nay = f.ay + attrOffY
    if (nax < 0 || nay < 0 || nax >= newAttrW || nay >= newAttrH) lostFeatures++
  }
  const lossText = (lostTiles || lostFeatures)
    ? `  · ⚠ would lose ${lostTiles} tile${lostTiles === 1 ? '' : 's'}, ${lostFeatures} feature${lostFeatures === 1 ? '' : 's'}`
    : ''
  const desc = `${oldW}×${oldH} → ${newW}×${newH}` +
    `  (Δ ${dW >= 0 ? '+' : ''}${dW}, ${dH >= 0 ? '+' : ''}${dH})` +
    `  · existing content placed at (${offsetX}, ${offsetY})${lossText}`
  const el = $('#resize-preview')
  el.textContent = desc
  el.classList.toggle('warning', !!(lostTiles || lostFeatures))
}

// anchorOffsets returns the (offsetX, offsetY) in tiles that the
// existing content's (0,0) maps to in the new canvas, given the
// chosen anchor.
function anchorOffsets(oldW, oldH, newW, newH) {
  const dW = newW - oldW
  const dH = newH - oldH
  const offsetX = Math.floor(dW * resizeState.anchorCol / 2)
  const offsetY = Math.floor(dH * resizeState.anchorRow / 2)
  return { offsetX, offsetY }
}

function applyResize() {
  const newW = clamp(parseInt($('#resize-w').value, 10) || state.tileW, 16, 256)
  const newH = clamp(parseInt($('#resize-h').value, 10) || state.tileH, 16, 256)
  if (newW === state.tileW && newH === state.tileH && !_state.pendingCropOffset) {
    closeResizeDialog()
    return
  }
  const oldW = state.tileW
  const oldH = state.tileH
  // Crop-to-content pre-stages an offset that shifts old (cropX,
  // cropY) to new (0, 0).  In ordinary resize math the offset is
  // positive (content pushed inward); for crop we want it negative
  // (content pulled out of the top-left).
  let offsetX, offsetY
  if (_state.pendingCropOffset) {
    offsetX = -_state.pendingCropOffset.x
    offsetY = -_state.pendingCropOffset.y
  } else {
    ({ offsetX, offsetY } = anchorOffsets(oldW, oldH, newW, newH))
  }

  // Tile grid: pull each new cell from the corresponding old cell
  // when the offset places it inside the old footprint, else leave
  // null.
  const newTiles = new Array(newW * newH).fill(null)
  for (let ny = 0; ny < newH; ny++) {
    for (let nx = 0; nx < newW; nx++) {
      const ox = nx - offsetX
      const oy = ny - offsetY
      if (ox < 0 || oy < 0 || ox >= oldW || oy >= oldH) continue
      newTiles[ny * newW + nx] = state.tiles[oy * oldW + ox]
    }
  }

  // Heights live on the 16-px attribute grid (2× tile resolution).
  // Same anchored copy, default fill for cells outside the old map.
  const oldAttrW = oldW * 2
  const newAttrW = newW * 2
  const newAttrH = newH * 2
  const offAX = offsetX * 2
  const offAY = offsetY * 2
  const newHeights = new Array(newAttrW * newAttrH).fill(80)
  const newVoids = new Array(newAttrW * newAttrH).fill(0)
  for (let ny = 0; ny < newAttrH; ny++) {
    for (let nx = 0; nx < newAttrW; nx++) {
      const ox = nx - offAX
      const oy = ny - offAY
      if (ox < 0 || oy < 0 || ox >= oldAttrW || oy >= oldH * 2) continue
      newHeights[ny * newAttrW + nx] = state.heights[oy * oldAttrW + ox]
      newVoids[ny * newAttrW + nx] = state.voids[oy * oldAttrW + ox] || 0
    }
  }

  const newFeatures = []
  for (const f of state.features) {
    const nax = f.ax + offAX
    const nay = f.ay + offAY
    if (nax < 0 || nay < 0 || nax >= newAttrW || nay >= newAttrH) continue
    newFeatures.push({ ...f, ax: nax, ay: nay })
  }

  beginTransaction()
  state.tileW = newW
  state.tileH = newH
  state.tiles = newTiles
  state.heights = newHeights
  state.voids = newVoids
  state.features = newFeatures
  hostCallbacks.renderMapTabs?.()
  commitTransaction('Resize map')

  closeResizeDialog()
  // Recreate the canvas DOM + GL context at the new dimensions.
  // The previous map-switch bug class came from re-using the
  // existing canvas elements at a different size; tearing them out
  // and mounting fresh ones guarantees no stale backing buffers
  // survive.
  hostCallbacks.recreateEditorView?.()
  hostCallbacks.renderCanvas?.()
  setStatus(`Resized to ${newW}×${newH}.  Existing content anchored to (${offsetX}, ${offsetY}).`)
}
