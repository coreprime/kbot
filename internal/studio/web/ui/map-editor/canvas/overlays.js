// overlays.js
//
// Translucent map overlays drawn on top of the tile pass — the
// gridline grid, the void cells, the buildable patches, and the
// in-flight voids-brush preview.  All four are pure state-driven
// passes; the caller provides the ctx and (for the gridline grid)
// the canvas so the overlay can size its strokes against the map
// bounds.
//
// drawVoidsDragRect is the one entry that runs even when the rest
// of the void overlay is off — it shows the brush footprint at the
// cursor while in Voids mode regardless of the View toggle.

import { state } from '../../host-context.js'
import { TILE_PX, BUILDABLE_MAX_SLOPE, BUILDABLE_FILL } from '../constants.js'

// drawGridlines paints the optional gridline overlay.  Density is
// chosen from zoom directly (user-specified bands), and at each
// band we render the chosen step (the "main" grid, lighter) plus
// the next-larger step (bolder) so the user always has a wider
// reference.
//
// Bands (tile spacing for the main grid):
//   zoom >= 1.50 → 1×1   (with 4×4 reference)
//   zoom >= 1.00 → 4×4   (with 8×8 reference)
//   zoom >= 0.50 → 8×8   (with 16×16)
//   zoom >= 0.25 → 16×16 (with 32×32)
//   zoom >= 0.12 → 32×32 (with 64×64)
//   zoom >= 0.05 → 64×64 (no larger reference)
//   zoom <  0.05 → off
const GRIDLINE_BANDS = [
  { zoom: 1.50, main: 1 },
  { zoom: 1.00, main: 4 },
  { zoom: 0.50, main: 8 },
  { zoom: 0.25, main: 16 },
  { zoom: 0.12, main: 32 },
  { zoom: 0.05, main: 64 },
]

export function drawGridlines(ctx, canvas) {
  const z = state.zoom || 1
  let bandIdx = -1
  for (let i = 0; i < GRIDLINE_BANDS.length; i++) {
    if (z >= GRIDLINE_BANDS[i].zoom) { bandIdx = i; break }
  }
  if (bandIdx < 0) return
  const mainStep = GRIDLINE_BANDS[bandIdx].main
  // The "next larger" reference is the entry with a smaller zoom
  // threshold = wider tile spacing, i.e. the entry AFTER bandIdx.
  const refStep = bandIdx + 1 < GRIDLINE_BANDS.length ? GRIDLINE_BANDS[bandIdx + 1].main : null
  // Stroke widths in game-pixels — we want stable CSS widths
  // regardless of zoom so they don't fade at low zoom or balloon
  // at high zoom.
  const mainWidth = Math.max(1, Math.ceil(1 / z))
  const refWidth = Math.max(2, Math.ceil(2 / z))

  ctx.save()
  ctx.lineCap = 'butt'

  // Main (lighter) — skip lines that coincide with the reference
  // grid so the bolder strokes don't get washed out by the thinner
  // overlay.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
  ctx.lineWidth = mainWidth
  for (let x = 0; x <= state.tileW; x += mainStep) {
    if (refStep && x % refStep === 0) continue
    const xp = x * TILE_PX
    ctx.beginPath(); ctx.moveTo(xp, 0); ctx.lineTo(xp, canvas.height); ctx.stroke()
  }
  for (let y = 0; y <= state.tileH; y += mainStep) {
    if (refStep && y % refStep === 0) continue
    const yp = y * TILE_PX
    ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(canvas.width, yp); ctx.stroke()
  }

  if (refStep) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.lineWidth = refWidth
    for (let x = 0; x <= state.tileW; x += refStep) {
      const xp = x * TILE_PX
      ctx.beginPath(); ctx.moveTo(xp, 0); ctx.lineTo(xp, canvas.height); ctx.stroke()
    }
    for (let y = 0; y <= state.tileH; y += refStep) {
      const yp = y * TILE_PX
      ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(canvas.width, yp); ctx.stroke()
    }
  }
  ctx.restore()
}

// drawVoidOverlay paints translucent red over every void
// attribute cell.  Each cell is 16 game-pixels (TILE_PX / 2).
// Skipped entirely when the array is empty or the cells slice is
// dimensioned wrong (e.g. mid-resize) to avoid out-of-bounds reads.
// While the user is mid-drag in Voids mode, the rectangle they're
// sweeping renders as a dashed red selection on top of the
// committed overlay.
export function drawVoidOverlay(ctx) {
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  // Voids mode forces the overlay on regardless of the View pref
  // so the user can always see what they're painting.
  const visible = state.showVoids || state.mode === 'voids'
  if (!visible) {
    // Still draw the in-flight drag rectangle so the cursor
    // preview shows up even when the toggle is off — but only
    // when actively dragging, which only happens in Voids mode
    // anyway.
    drawVoidsDragRect(ctx)
    return
  }
  if (!state.voids || state.voids.length !== aw * ah) {
    // Still draw the drag rectangle even if no committed voids
    // exist.
    drawVoidsDragRect(ctx)
    return
  }
  const cell = TILE_PX / 2
  ctx.save()
  ctx.fillStyle = 'rgba(220, 38, 38, 0.42)'
  for (let y = 0; y < ah; y++) {
    let runStart = -1
    for (let x = 0; x <= aw; x++) {
      const v = x < aw ? state.voids[y * aw + x] : 0
      if (v) {
        if (runStart < 0) runStart = x
      } else if (runStart >= 0) {
        // Flush a horizontal run of void cells as one fillRect —
        // keeps 70-tile maps from issuing thousands of single-
        // cell fills.
        ctx.fillRect(runStart * cell, y * cell, (x - runStart) * cell, cell)
        runStart = -1
      }
    }
  }
  ctx.restore()
  drawVoidsDragRect(ctx)
}

// drawBuildableOverlay paints a translucent light-blue square on
// every attribute cell where a TA builder could plant a structure.
// Rules (per BUILDABLE_* constants in /ui/map-editor/constants.js):
//   - cell isn't a void
//   - cell sits at or above sea level (land-based structures)
//   - height delta across the cell's 3×3 patch is within
//     BUILDABLE_MAX_SLOPE units (a structure's footprint sits
//     across multiple cells, so the engine's slope tolerance is
//     really about the height differential across a patch, not
//     just a single neighbour edge — broad flat regions pass,
//     plateau interiors pass, slope cells fail)
//
// Each painted rectangle is lifted by Height/2 pixels to match the
// visual elevation offset features apply via featureAnchorWorld,
// so the build-plate sits visually on top of the tall structure
// where the player would actually drop a building — not floating
// at the flat tile-grid position with the tower top above it.
//
// Runs of cells in a row that share both buildability AND height
// are flushed as one fillRect so a 256×256 map still renders in a
// frame.
export function drawBuildableOverlay(ctx) {
  if (!state.showBuildable) return
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  if (!state.heights || state.heights.length !== aw * ah) return
  const voids = state.voids && state.voids.length === aw * ah ? state.voids : null
  const seaLevel = state.ota?.seaLevel ?? 0
  const heights = state.heights
  const cell = TILE_PX / 2
  const slopeMax = BUILDABLE_MAX_SLOPE

  const buildable = new Uint8Array(aw * ah)
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const idx = y * aw + x
      if (voids && voids[idx]) continue
      const h = heights[idx]
      if (h < seaLevel) continue
      let minH = h, maxH = h
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= ah) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= aw) continue
          const nh = heights[ny * aw + nx]
          if (nh < minH) minH = nh
          if (nh > maxH) maxH = nh
        }
      }
      if (maxH - minH <= slopeMax) buildable[idx] = 1
    }
  }

  ctx.save()
  ctx.fillStyle = BUILDABLE_FILL
  for (let y = 0; y < ah; y++) {
    let runStart = -1
    let runShift = 0
    for (let x = 0; x <= aw; x++) {
      const v = x < aw ? buildable[y * aw + x] : 0
      const shift = v ? (heights[y * aw + x] >> 1) : 0
      if (v && (runStart < 0 || shift === runShift)) {
        if (runStart < 0) { runStart = x; runShift = shift }
      } else {
        if (runStart >= 0) {
          ctx.fillRect(runStart * cell, y * cell - runShift, (x - runStart) * cell, cell)
        }
        if (v) { runStart = x; runShift = shift } else { runStart = -1 }
      }
    }
  }
  ctx.restore()
}

// drawVoidsDragRect renders the void brush footprint at the cursor
// — a dashed red square sized to state.voidsBrushSize so the user
// sees what their next stamp will affect.  Drawn even when not
// actively painting so the brush size is discoverable on hover.
export function drawVoidsDragRect(ctx) {
  if (state.mode !== 'voids' || !state.voidsCursor) return
  const cell = TILE_PX / 2
  const size = Math.max(1, state.voidsBrushSize || 1)
  const off = Math.floor(size / 2)
  const x0 = (state.voidsCursor.ax - off) * cell
  const y0 = (state.voidsCursor.ay - off) * cell
  const w = size * cell
  const h = size * cell
  ctx.save()
  ctx.fillStyle = 'rgba(248, 81, 73, 0.20)'
  ctx.fillRect(x0, y0, w, h)
  ctx.strokeStyle = 'rgba(248, 81, 73, 0.95)'
  ctx.lineWidth = 2
  ctx.setLineDash([6, 4])
  ctx.strokeRect(x0 + 1, y0 + 1, w - 2, h - 2)
  ctx.setLineDash([])
  ctx.restore()
}
