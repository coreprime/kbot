// terrain.js
//
// Select-Area / terrain-clipboard overlays.  Three passes:
//
//   - drawTerrainOverlays  Top-level entry — the in-flight
//                          rectangle the user is sweeping plus the
//                          floating clipboard preview.
//   - drawTerrainClipboard The detached chunk of tiles + features
//                          that follows the cursor after Select
//                          Area + drag.  Carried features get
//                          their height read out of c.heights
//                          (not the live map) so they don't jump
//                          when the user drops them onto different
//                          terrain.
//   - drawTerrainEdgeHints Red/white perimeter squares flagging
//                          seam mismatches between the clipboard's
//                          edge heights and the underlying map —
//                          parity with drawPlacementEdgeHints so
//                          the affordance is identical between
//                          Place Tiles and Select Area drag-move.

import { state } from '../../host-context.js'
import { TILE_PX } from '../constants.js'
import { normalizedRect } from '../helpers.js'
import { drawRotatedTile } from './tiles.js'
import { featureAnchorWorld, featureAnchorOffset } from '../feature-assets.js'

export function drawTerrainOverlays(ctx) {
  // Rectangle currently being dragged.
  if (state.rectSelection) {
    const r = normalizedRect(state.rectSelection)
    ctx.fillStyle = 'rgba(139, 92, 246, 0.14)'
    ctx.fillRect(r.x * TILE_PX, r.y * TILE_PX, r.w * TILE_PX, r.h * TILE_PX)
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.9)'
    ctx.setLineDash([6, 4])
    ctx.lineWidth = 2
    ctx.strokeRect(r.x * TILE_PX + 1, r.y * TILE_PX + 1, r.w * TILE_PX - 2, r.h * TILE_PX - 2)
    ctx.setLineDash([])
  }
  // Floating clipboard — preview at current cursor position.
  if (state.terrainClipboard) {
    drawTerrainClipboard(ctx)
  }
}

function drawTerrainClipboard(ctx) {
  const c = state.terrainClipboard
  const tx = c.tx, ty = c.ty
  ctx.save()
  ctx.globalAlpha = 0.85
  for (let dy = 0; dy < c.h; dy++) {
    for (let dx = 0; dx < c.w; dx++) {
      const cell = c.tiles[dy * c.w + dx]
      const mx = tx + dx, my = ty + dy
      if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) continue
      if (!cell) {
        ctx.fillStyle = 'rgba(139, 92, 246, 0.12)'
        ctx.fillRect(mx * TILE_PX, my * TILE_PX, TILE_PX, TILE_PX)
        continue
      }
      const img = state.sectionImages.get(cell.sectionPath)
      if (img && img.complete && img.naturalWidth > 0) {
        drawRotatedTile(ctx, img, cell.sx, cell.sy, cell.rotation || 0, mx * TILE_PX, my * TILE_PX)
      } else {
        ctx.fillStyle = '#3a4d61'
        ctx.fillRect(mx * TILE_PX, my * TILE_PX, TILE_PX, TILE_PX)
      }
    }
  }
  ctx.restore()

  // Draw carried features so the user can see them following the
  // rectangle.  Positioned with the same bottom-centre anchor
  // drawFeatures uses on the regular map.
  if (c.features && c.features.length) {
    ctx.save()
    ctx.globalAlpha = 0.9
    ctx.font = '14px ' + getComputedStyle(document.body).fontFamily
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const cAttrW = c.w * 2
    const cAttrH = c.h * 2
    for (const f of c.features) {
      // Carried features have ax/ay relative to the clipboard,
      // not the world.  featureGroundHeight would read
      // state.heights at the wrong (or zeroed-out) cell — pass
      // the height from the captured c.heights array so the lift
      // matches what the feature had before the user grabbed it.
      let groundH = 0
      if (f.ax >= 0 && f.ay >= 0 && f.ax < cAttrW && f.ay < cAttrH) {
        groundH = c.heights[f.ay * cAttrW + f.ax] | 0
      }
      const local = featureAnchorWorld(f, groundH)
      const px = c.tx * TILE_PX + local.px
      const py = c.ty * TILE_PX + local.py
      const img = f.previewUrl ? state.featureImages.get(f.name.toLowerCase()) : null
      if (img && img.complete && img.naturalWidth > 0) {
        const { dx, dy } = featureAnchorOffset(f, img)
        ctx.drawImage(img, px - dx, py - dy, img.naturalWidth, img.naturalHeight)
      } else {
        ctx.fillStyle = 'rgba(255, 200, 0, 0.7)'
        ctx.beginPath()
        ctx.arc(px, py, 6, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#000'
        ctx.fillText('🌲', px, py)
      }
    }
    ctx.restore()
  }

  ctx.strokeStyle = 'rgba(139, 92, 246, 0.9)'
  ctx.lineWidth = 2
  ctx.strokeRect(tx * TILE_PX + 1, ty * TILE_PX + 1, c.w * TILE_PX - 2, c.h * TILE_PX - 2)

  // Edge-alignment hints — same affordance as the section
  // placement preview so the user has parity between Place Tiles
  // and Select Area drag-move.  The rotation badge that used to
  // render alongside was deprecated in round 33 (the live
  // preview's rotation conveys the same info).
  drawTerrainEdgeHints(ctx, c)
}

// drawTerrainEdgeHints flags seam mismatches between the floating
// clipboard and the map's existing heights — mirrors the section-
// placement edge hints so the user can see at a glance whether
// the drop point will produce ugly elevation steps.
function drawTerrainEdgeHints(ctx, c) {
  const ALIGN_TOLERANCE = 16
  const mapAttrW = state.tileW * 2
  const clipAttrW = c.w * 2

  // Sample the clipboard's height at (fx, fy) sub-cell (qx, qy ∈
  // [0,1]).
  function clipboardHeight(fx, fy, qx, qy) {
    const ax = fx * 2 + qx
    const ay = fy * 2 + qy
    const idx = ay * clipAttrW + ax
    if (idx < 0 || idx >= c.heights.length) return null
    return c.heights[idx]
  }

  function edgeDelta(fx, fy, edge) {
    let mx, my
    const samples = []
    if (edge === 'N') {
      mx = c.tx + fx; my = c.ty + fy - 1
      if (my < 0 || mx < 0 || mx >= state.tileW) return null
      for (let q = 0; q < 2; q++) samples.push({
        clipH: clipboardHeight(fx, fy, q, 0),
        mapH: state.heights[(my * 2 + 1) * mapAttrW + (mx * 2 + q)],
      })
    } else if (edge === 'S') {
      mx = c.tx + fx; my = c.ty + fy + 1
      if (my >= state.tileH || mx < 0 || mx >= state.tileW) return null
      for (let q = 0; q < 2; q++) samples.push({
        clipH: clipboardHeight(fx, fy, q, 1),
        mapH: state.heights[(my * 2) * mapAttrW + (mx * 2 + q)],
      })
    } else if (edge === 'W') {
      mx = c.tx + fx - 1; my = c.ty + fy
      if (mx < 0 || my < 0 || my >= state.tileH) return null
      for (let q = 0; q < 2; q++) samples.push({
        clipH: clipboardHeight(fx, fy, 0, q),
        mapH: state.heights[(my * 2 + q) * mapAttrW + (mx * 2 + 1)],
      })
    } else if (edge === 'E') {
      mx = c.tx + fx + 1; my = c.ty + fy
      if (mx >= state.tileW || my < 0 || my >= state.tileH) return null
      for (let q = 0; q < 2; q++) samples.push({
        clipH: clipboardHeight(fx, fy, 1, q),
        mapH: state.heights[(my * 2 + q) * mapAttrW + (mx * 2)],
      })
    }
    // Skip seams where the neighbour cell is void.
    if (!state.tiles[my * state.tileW + mx]) return null
    let worst = 0
    for (const s of samples) {
      if (s.clipH == null || s.mapH == null) continue
      const d = Math.abs(s.clipH - s.mapH)
      if (d > worst) worst = d
    }
    return worst
  }

  function evaluateRingCell(rx, ry) {
    const mx = c.tx + rx, my = c.ty + ry
    if (rx >= 0 && rx < c.w && ry >= 0 && ry < c.h) return null
    if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) return null
    const edges = []
    if (rx === -1 && ry >= 0 && ry < c.h) edges.push({ fx: 0, fy: ry, edge: 'W' })
    if (rx === c.w && ry >= 0 && ry < c.h) edges.push({ fx: c.w - 1, fy: ry, edge: 'E' })
    if (ry === -1 && rx >= 0 && rx < c.w) edges.push({ fx: rx, fy: 0, edge: 'N' })
    if (ry === c.h && rx >= 0 && rx < c.w) edges.push({ fx: rx, fy: c.h - 1, edge: 'S' })
    if (rx === -1 && ry === -1) edges.push({ fx: 0, fy: 0, edge: 'N' }, { fx: 0, fy: 0, edge: 'W' })
    if (rx === c.w && ry === -1) edges.push({ fx: c.w - 1, fy: 0, edge: 'N' }, { fx: c.w - 1, fy: 0, edge: 'E' })
    if (rx === -1 && ry === c.h) edges.push({ fx: 0, fy: c.h - 1, edge: 'S' }, { fx: 0, fy: c.h - 1, edge: 'W' })
    if (rx === c.w && ry === c.h) edges.push({ fx: c.w - 1, fy: c.h - 1, edge: 'S' }, { fx: c.w - 1, fy: c.h - 1, edge: 'E' })
    if (edges.length === 0) return null
    let worst = 0
    let evaluated = false
    for (const e of edges) {
      const d = edgeDelta(e.fx, e.fy, e.edge)
      if (d == null) continue
      evaluated = true
      if (d > worst) worst = d
    }
    return evaluated ? worst : null
  }

  for (let ry = -1; ry <= c.h; ry++) {
    for (let rx = -1; rx <= c.w; rx++) {
      if (rx >= 0 && rx < c.w && ry >= 0 && ry < c.h) continue
      const delta = evaluateRingCell(rx, ry)
      if (delta == null) continue
      const mx = c.tx + rx, my = c.ty + ry
      const misaligned = delta > ALIGN_TOLERANCE
      ctx.fillStyle = misaligned ? 'rgba(248, 81, 73, 0.45)' : 'rgba(255, 255, 255, 0.22)'
      ctx.fillRect(mx * TILE_PX, my * TILE_PX, TILE_PX, TILE_PX)
      ctx.strokeStyle = misaligned ? 'rgba(248, 81, 73, 0.95)' : 'rgba(255, 255, 255, 0.7)'
      ctx.lineWidth = 1
      ctx.strokeRect(mx * TILE_PX + 0.5, my * TILE_PX + 0.5, TILE_PX - 1, TILE_PX - 1)
    }
  }
}
