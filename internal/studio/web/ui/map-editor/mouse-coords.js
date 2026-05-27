// mouse-coords.js
//
// Convert raw MouseEvent client coordinates into the various
// grid spaces the map editor needs:
//
//   - pickCell             tile coords (32-px tile grid).
//   - pickAttrCellForVoid  attribute-cell coords (16-px void
//                          brush + heightmap brush grid).
//   - pickFeatureAttrCell  attribute-cell coords with feature-
//                          anchor offset compensation, so a
//                          released feature lands where the
//                          cursor actually is — accounting for
//                          the footprint*8 X offset and the
//                          footprint*8 - Height/2 Y offset
//                          featureAnchorWorld applies on the way
//                          out.
//
// All three are pure functions of the event + state and live in
// canvas-bounding-rect space so they survive zoom + CSS scaling.

import { state, $, clamp } from './host-context.js'
import { TILE_PX } from './constants.js'

export function pickCell(e) {
  const canvas = $('#canvas')
  const rect = canvas.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width * state.tileW
  const y = (e.clientY - rect.top) / rect.height * state.tileH
  return { tx: Math.floor(x), ty: Math.floor(y) }
}

export function pickAttrCellForVoid(e) {
  const canvas = $('#canvas')
  const rect = canvas.getBoundingClientRect()
  const ax = Math.floor((e.clientX - rect.left) / rect.width * state.tileW * 2)
  const ay = Math.floor((e.clientY - rect.top) / rect.height * state.tileH * 2)
  return { ax, ay }
}

// pickFeatureAttrCell returns the (ax, ay) attribute cell to
// assign to a feature placed under the cursor.  It inverts the
// same offset featureAnchorWorld applies on the way out —
// Footprint*8 in X plus Footprint*8 - Height/2 in Y — so the
// rendered anchor visually lines up with the cursor (modulo the
// unavoidable ±8 px snap to the 16-px attribute grid).  Height is
// sampled at the cursor's plain cell as a one-step estimate; the
// stored ax/ay round-trips through load/save unchanged.
export function pickFeatureAttrCell(e, sel) {
  const canvas = $('#canvas')
  const rect = canvas.getBoundingClientRect()
  const cx = (e.clientX - rect.left) / rect.width * canvas.width
  const cy = (e.clientY - rect.top) / rect.height * canvas.height
  const fw = (sel && sel.footprintX) || 1
  const fh = (sel && sel.footprintZ) || 1
  const cellPx = TILE_PX / 2 // 16
  const anchorPx = TILE_PX / 4 // 8
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  const heights = state.heights
  const sampleH = (ax, ay) => {
    if (!heights || !heights.length) return 0
    if (ax < 0 || ay < 0 || ax >= aw || ay >= ah) return 0
    return heights[ay * aw + ax] | 0
  }
  const ax = clamp(Math.floor((cx - fw * anchorPx) / cellPx), 0, aw - 1)
  // Tentative ay using the cursor cell's height — then iterate
  // so the height we use to compute ay matches the height at the
  // cell ay actually lands in.  Without this, releasing a feature
  // near a slope makes the renderer (which reads state.heights at
  // the final ax/ay) disagree with the picker (which read
  // state.heights at the cursor cell), and the feature visibly
  // snaps to a different position after the drop completes.
  const cursorAy = clamp(Math.floor(cy / cellPx), 0, ah - 1)
  let h = sampleH(ax, cursorAy)
  let ay = clamp(Math.floor((cy + (h >> 1) - fh * anchorPx) / cellPx), 0, ah - 1)
  for (let i = 0; i < 3; i++) {
    const nextH = sampleH(ax, ay)
    if (nextH === h) break
    h = nextH
    ay = clamp(Math.floor((cy + (h >> 1) - fh * anchorPx) / cellPx), 0, ah - 1)
  }
  return { ax, ay }
}
