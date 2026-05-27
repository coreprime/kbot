// ruler.js
//
// Ruler overlay — the dashed-line measure tool the user drops with
// Ruler mode.  state.ruler holds {a, b} attribute-cell endpoints
// (plus a locked flag); the overlay draws the line, the endpoint
// markers, and a floating label with distance + height-delta stats.
//
// rulerStats() walks the line in attribute-cell increments so
// every cell the line crosses contributes to min / max / delta —
// the label reports the tightest range across the whole path, not
// just the two endpoints.

import { state } from '../../host-context.js'

// rulerStats summarises the active ruler as { dPx, dTiles, dAttr,
// hMin, hMax, hDelta } — or null when there's nothing to measure.
// Heightmap samples walk the line in attribute-cell increments so
// every cell the line crosses contributes to the min / max /
// delta.
export function rulerStats() {
  const r = state.ruler
  if (!r) return null
  const { a, b } = r
  const aw = state.tileW * 2, ah = state.tileH * 2
  const ainA = a.ax >= 0 && a.ax < aw && a.ay >= 0 && a.ay < ah
  const binA = b.ax >= 0 && b.ax < aw && b.ay >= 0 && b.ay < ah
  // Distance in attr cells (16-px); tiles is half of that;
  // pixels x16.
  const dAttrX = b.ax - a.ax, dAttrY = b.ay - a.ay
  const dAttr = Math.hypot(dAttrX, dAttrY)
  const dTiles = dAttr / 2
  const dPx = dAttr * 16
  // Walk the line sampling heights.  Step in 1-attr increments so
  // we hit every cell along the path.
  let hMin = Infinity, hMax = -Infinity
  const steps = Math.max(1, Math.ceil(dAttr))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const sx = Math.round(a.ax + dAttrX * t)
    const sy = Math.round(a.ay + dAttrY * t)
    if (sx < 0 || sx >= aw || sy < 0 || sy >= ah) continue
    const h = state.heights[sy * aw + sx] | 0
    if (h < hMin) hMin = h
    if (h > hMax) hMax = h
  }
  if (!isFinite(hMin)) { hMin = 0; hMax = 0 }
  return { dPx, dTiles, dAttr, hMin, hMax, hDelta: hMax - hMin, ainA, binA }
}

export function drawRulerOverlay(ctx) {
  const r = state.ruler
  if (!r) return
  const stats = rulerStats()
  if (!stats) return
  // Convert attr cells (16-px) to map pixels.  Centre of the cell
  // so the line endpoints sit nicely inside the highlighted
  // square.
  const ax = r.a.ax * 16 + 8
  const ay = r.a.ay * 16 + 8
  const bx = r.b.ax * 16 + 8
  const by = r.b.ay * 16 + 8

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // Soft outer glow then bright inner line.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.lineWidth = 5
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
  ctx.strokeStyle = r.locked ? 'rgba(255, 220, 80, 0.95)' : 'rgba(255, 255, 255, 0.95)'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()

  // Endpoint markers.
  const drawEnd = (x, y) => {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = r.locked ? 'rgb(255, 220, 80)' : '#fff'
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill()
  }
  drawEnd(ax, ay)
  drawEnd(bx, by)

  // Floating label near the midpoint with the measurement.
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const lines = [
    `${stats.dTiles.toFixed(2)} tiles  ·  ${stats.dAttr.toFixed(1)} attr  ·  ${Math.round(stats.dPx)} px`,
    `Δh ${stats.hDelta}  (${stats.hMin}–${stats.hMax})`,
  ]
  ctx.font = '600 12px var(--mono, monospace)'
  // Measure width for the bg rect.
  let w = 0
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width)
  const padX = 8, padY = 6, lineH = 14
  const boxW = w + padX * 2
  const boxH = lines.length * lineH + padY * 2
  // Offset the label so it doesn't sit on top of the line.
  const off = 16
  let bxL = mx + off
  let byL = my + off
  // Keep inside the canvas if possible.
  const mapW = state.tileW * 32, mapH = state.tileH * 32
  if (bxL + boxW > mapW) bxL = mx - off - boxW
  if (byL + boxH > mapH) byL = my - off - boxH
  if (bxL < 0) bxL = 0
  if (byL < 0) byL = 0
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)'
  ctx.beginPath()
  ctx.roundRect ? ctx.roundRect(bxL, byL, boxW, boxH, 4) : ctx.rect(bxL, byL, boxW, boxH)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'top'
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], bxL + padX, byL + padY + i * lineH)
  }
  ctx.restore()
}
