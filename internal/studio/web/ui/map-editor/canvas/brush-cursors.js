// brush-cursors.js
//
// On-canvas brush previews — render a translucent footprint at the
// cursor while a brush-style mode is active so the user can see
// what the next click/drag will affect.
//
//   - drawEraseBrush      N×N tile footprint at state.eraseCursor
//                         while in Erase mode.
//   - drawHeightmapBrush  Circular outline at state.hmCursor with
//                         radius state.hmRadius (in attribute
//                         cells), colour-coded by the active
//                         Raise/Lower tool.
//
// Both are pure state-driven ctx passes — drawn after the rest of
// the overlays so the brush hint always sits on top.

import { state } from '../../host-context.js'
import { TILE_PX } from '../constants.js'

export function drawEraseBrush(ctx) {
  if (state.mode !== 'erase' || !state.eraseCursor) return
  const { tx, ty } = state.eraseCursor
  const size = Math.max(1, state.eraseSize || 1)
  const off = Math.floor(size / 2)
  const x0 = (tx - off) * TILE_PX
  const y0 = (ty - off) * TILE_PX
  const w = size * TILE_PX
  const h = size * TILE_PX
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

// drawHeightmapBrush renders a circular outline at the cursor
// while in Heightmap mode, sized to state.hmRadius (in attribute
// cells).  Drawn in the canvas's tile-pixel coordinate space, so
// the circle stays the same size regardless of zoom.
export function drawHeightmapBrush(ctx) {
  if (state.mode !== 'heightmap' || !state.hmCursor) return
  const { ax, ay } = state.hmCursor
  const cellPx = TILE_PX / 2 // one attribute cell = 16px in a 32px tile
  const cx = (ax + 0.5) * cellPx
  const cy = (ay + 0.5) * cellPx
  const r = Math.max(1, state.hmRadius | 0) * cellPx
  const colour = state.hmTool === 'lower' ? 'rgba(56, 132, 255, ' : 'rgba(82, 196, 26, '
  ctx.save()
  ctx.fillStyle = colour + '0.10)'
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = colour + '0.95)'
  ctx.lineWidth = 2
  ctx.setLineDash([6, 4])
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}
