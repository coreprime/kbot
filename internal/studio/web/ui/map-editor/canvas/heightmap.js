// heightmap.js
//
// Heightmap drawing passes for the 2D canvas renderer:
//
//   - drawHeightmap        Heightmap view's main pass — paints
//                          state.heights as a normalised grayscale
//                          at the attribute-cell resolution (2×
//                          tile grid).  Calls drawHeightContours
//                          when state.showContours is on.
//   - drawHeightmapOverlay Translucent grayscale on top of the
//                          regular tile render, used by the
//                          Blended display mode.
//   - drawHeightContours   Thin lines along every CONTOUR_STEP-byte
//                          height change between neighbouring
//                          attribute cells, plus a thicker blue
//                          line at the configured sea level.
//
// Pure functions of state and the ctx the caller passes in — no DOM
// queries, no module state, no host callbacks.  Lives under
// /ui/map-editor/canvas/ so the renderer subtree owns its own draw
// helpers without involving studio.js.

import { state } from '../../host-context.js'
import { TILE_PX } from '../constants.js'

export function drawHeightmap(ctx) {
  const attrW = state.tileW * 2
  const attrH = state.tileH * 2
  if (state.heights.length !== attrW * attrH) return
  let min = 255, max = 0
  for (let i = 0; i < state.heights.length; i++) {
    if (state.heights[i] < min) min = state.heights[i]
    if (state.heights[i] > max) max = state.heights[i]
  }
  const span = Math.max(1, max - min)
  const cell = TILE_PX / 2
  for (let ay = 0; ay < attrH; ay++) {
    for (let ax = 0; ax < attrW; ax++) {
      const h = state.heights[ay * attrW + ax]
      const v = Math.round(((h - min) / span) * 255)
      ctx.fillStyle = `rgb(${v},${v},${v})`
      ctx.fillRect(ax * cell, ay * cell, cell, cell)
    }
  }
  // Contours are gated on the View → Show Contours toggle so the
  // user controls them in both Heightmap and Map view from one
  // place.
  if (state.showContours) drawHeightContours(ctx, attrW, attrH, cell)
}

// drawHeightContours overlays thin lines along every CONTOUR_STEP-
// byte height change between neighbouring attribute cells, plus a
// thicker blue line at the configured sea level.  Two passes over
// the grid: one stroking horizontal edges, one stroking vertical
// edges; uses a single path per line colour so big maps stay fast.
export function drawHeightContours(ctx, attrW, attrH, cell) {
  // Step grows with zoom-out so we don't draw a dense web of lines
  // at 5–25% zoom.  Each step is a height bucket; lines render
  // where two neighbouring cells fall in different buckets.
  //   ≥75%:  every 16 height units (default detail)
  //   ≥40%:  every 32
  //   ≥20%:  every 64
  //   else:  every 128 (only major bands)
  const z = state.zoom || 1
  let step
  if (z >= 0.75) step = 16
  else if (z >= 0.40) step = 32
  else if (z >= 0.20) step = 64
  else step = 128
  const seaLevel = state.ota?.seaLevel ?? 63
  // Keep strokes at least 1 CSS pixel wide regardless of zoom —
  // same approach the gridlines use, so contours don't alias out
  // at low zoom or balloon at high zoom.
  const minorWidth = Math.max(1, Math.ceil(1 / z))
  const majorWidth = Math.max(2, Math.ceil(2 / z))
  ctx.save()
  ctx.lineWidth = minorWidth
  // Light blue contours so they stand out on both the Map tile
  // textures and the Heightmap greyscale.
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.85)'
  ctx.beginPath()
  for (let ay = 0; ay < attrH; ay++) {
    for (let ax = 0; ax < attrW; ax++) {
      const h = state.heights[ay * attrW + ax]
      // Right edge.
      if (ax + 1 < attrW) {
        const r = state.heights[ay * attrW + (ax + 1)]
        if (Math.floor(h / step) !== Math.floor(r / step)) {
          const x = (ax + 1) * cell
          ctx.moveTo(x, ay * cell)
          ctx.lineTo(x, (ay + 1) * cell)
        }
      }
      // Bottom edge.
      if (ay + 1 < attrH) {
        const b = state.heights[(ay + 1) * attrW + ax]
        if (Math.floor(h / step) !== Math.floor(b / step)) {
          const y = (ay + 1) * cell
          ctx.moveTo(ax * cell, y)
          ctx.lineTo((ax + 1) * cell, y)
        }
      }
    }
  }
  ctx.stroke()
  // Sea-level line — heavier and tinted blue so it stands out from
  // the regular contours.
  ctx.strokeStyle = 'rgba(56, 132, 255, 0.95)'
  ctx.lineWidth = majorWidth
  ctx.beginPath()
  for (let ay = 0; ay < attrH; ay++) {
    for (let ax = 0; ax < attrW; ax++) {
      const h = state.heights[ay * attrW + ax]
      const above = h >= seaLevel
      if (ax + 1 < attrW) {
        const r = state.heights[ay * attrW + (ax + 1)]
        if (above !== (r >= seaLevel)) {
          const x = (ax + 1) * cell
          ctx.moveTo(x, ay * cell)
          ctx.lineTo(x, (ay + 1) * cell)
        }
      }
      if (ay + 1 < attrH) {
        const b = state.heights[(ay + 1) * attrW + ax]
        if (above !== (b >= seaLevel)) {
          const y = (ay + 1) * cell
          ctx.moveTo(ax * cell, y)
          ctx.lineTo((ax + 1) * cell, y)
        }
      }
    }
  }
  ctx.stroke()
  ctx.restore()
}

export function drawHeightmapOverlay(ctx) {
  const attrW = state.tileW * 2
  const attrH = state.tileH * 2
  if (state.heights.length !== attrW * attrH) return
  let min = 255, max = 0
  for (let i = 0; i < state.heights.length; i++) {
    const h = state.heights[i]
    if (h < min) min = h
    if (h > max) max = h
  }
  const span = Math.max(1, max - min)
  const cell = TILE_PX / 2
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 0.55
  for (let ay = 0; ay < attrH; ay++) {
    for (let ax = 0; ax < attrW; ax++) {
      const h = state.heights[ay * attrW + ax]
      const v = Math.round(((h - min) / span) * 255)
      ctx.fillStyle = `rgb(${v},${v},${v})`
      ctx.fillRect(ax * cell, ay * cell, cell, cell)
    }
  }
  ctx.restore()
}
