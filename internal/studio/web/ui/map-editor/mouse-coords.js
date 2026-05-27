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
import { TILE_PX, FEATURE_HIT_SEARCH_TILES, START_POS_RADIUS } from './constants.js'
import { featuresNear } from './content-cache.js'
import { featureAnchorWorld, featureRenderRect } from './feature-assets.js'
import { gameToCanvas } from './helpers.js'

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

// findFeatureAt hit-tests the actual canvas-pixel cursor position
// against every feature's drawn rectangle.  The old version
// reduced the cursor to its tile centre, which missed clicks
// whose tile centre fell outside a 1×1 sprite — visible as
// features on subtile (1,1) being unclickable while subtile
// (1,0) worked because the anchor offset happened to leave the
// tile centre inside the rect.  Accepts either a MouseEvent or
// pre-resolved canvas pixel coords as `{ cpx, cpy }`.
//
// We re-iterate in z-order (drawn last = on top) so the topmost
// feature wins overlaps.
export function findFeatureAt(e) {
  let cpx, cpy
  if (e && typeof e.clientX === 'number') {
    const canvas = $('#canvas')
    const rect = canvas.getBoundingClientRect()
    cpx = (e.clientX - rect.left) / rect.width * canvas.width
    cpy = (e.clientY - rect.top) / rect.height * canvas.height
  } else if (e && typeof e.cpx === 'number') {
    cpx = e.cpx; cpy = e.cpy
  } else {
    return -1
  }
  const tx = Math.floor(cpx / TILE_PX)
  const ty = Math.floor(cpy / TILE_PX)
  const candidates = featuresNear(tx, ty, FEATURE_HIT_SEARCH_TILES)
  for (let i = candidates.length - 1; i >= 0; i--) {
    const idx = candidates[i]
    const f = state.features[idx]
    const { px, py } = featureAnchorWorld(f)
    const r = featureRenderRect(f, px, py)
    if (cpx >= r.x && cpx <= r.x + r.w && cpy >= r.y && cpy <= r.y + r.h) return idx
  }
  return -1
}

// findStartPositionAt hit-tests a canvas-pixel point against the
// active schema's start markers, returning the index of the
// nearest within START_POS_RADIUS or -1 when nothing is in range.
// Caller passes in the schema explicitly so this helper doesn't
// need to know how state.activeSchema gets resolved.
export function findStartPositionAt(schema, px, py) {
  if (!schema) return -1
  for (let i = schema.startPositions.length - 1; i >= 0; i--) {
    const sp = schema.startPositions[i]
    const { px: spx, py: spy } = gameToCanvas(sp.x, sp.z)
    const dx = spx - px
    const dy = spy - py
    if (dx * dx + dy * dy <= START_POS_RADIUS * START_POS_RADIUS) return i
  }
  return -1
}
