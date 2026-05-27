// start-positions.js
//
// Start-position canvas pass.  Renders the active schema's
// startPositions as labelled gold robot markers, with the other
// schemas' positions dimmed in the background so the user can see
// the whole layout while editing one schema at a time.
//
// State that controls visibility:
//   - state.showStartPositions  View toggle.
//   - state.mode                'start-points' forces the layer on
//                                regardless of the toggle so the
//                                user can always see what they're
//                                editing.
//   - state.activeSchema        Index of the foregrounded schema.
//   - state.selectedStartPos    Index of the position the user has
//                                grabbed in start-points mode.
//
// The marker size auto-scales with zoom (clamped to a sensible max)
// so the badges stay legible from 5% to 200% without ballooning.

import { state } from '../../host-context.js'
import { gameToCanvas } from '../helpers.js'

// activeSchemaSlot mirrors the same inline accessor minimap.js uses
// — local one-liner against state.ota so this module doesn't need
// a back-channel into studio.js for what's a single lookup.
function activeSchemaSlot() {
  if (!state.ota || !state.ota.schemas[state.activeSchema]) return null
  return state.ota.schemas[state.activeSchema]
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

export function drawStartPositions(ctx) {
  if (!state.ota) return
  // Hidden via View toggle, and the user isn't in start-points
  // mode (mode forces the layer on so they can see what they're
  // editing).
  if (!state.showStartPositions && state.mode !== 'start-points') return
  const fontFamily = getComputedStyle(document.body).fontFamily
  // Inverse zoom so the marker keeps a stable CSS size as the user
  // zooms out — clamp upward to avoid mountain-sized badges at 1%
  // zoom while still rescuing them from the 16-px-into-the-void
  // disappear they used to do.  At zoom >= 1 we render at the
  // original sizes.
  const z = state.zoom || 1
  const scale = Math.min(8, Math.max(1, 1 / z))
  const ringR = 16 * scale
  const dotR = 8 * scale
  const iconPx = Math.round(18 * scale)
  const badgePx = Math.round(11 * scale)
  const badgeOffsetX = 12 * scale
  const badgeOffsetY = 6 * scale
  const badgeH = 15 * scale

  // Faded markers for non-active schemas (only render if there's
  // more than one schema, otherwise it's noise).
  if (state.ota.schemas.length > 1) {
    ctx.save()
    ctx.globalAlpha = 0.18
    for (let si = 0; si < state.ota.schemas.length; si++) {
      if (si === state.activeSchema) continue
      const s = state.ota.schemas[si]
      for (const sp of s.startPositions) {
        const { px, py } = gameToCanvas(sp.x, sp.z)
        ctx.fillStyle = '#8b5cf6'
        ctx.beginPath()
        ctx.arc(px, py, dotR, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()
  }

  const schema = activeSchemaSlot()
  if (!schema) return
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < schema.startPositions.length; i++) {
    const sp = schema.startPositions[i]
    const { px, py } = gameToCanvas(sp.x, sp.z)
    // Outer ring — accent when selected, gold otherwise.
    const selected = state.mode === 'start-points' && state.selectedStartPos === i
    ctx.fillStyle = selected ? 'rgba(139, 92, 246, 0.92)' : 'rgba(255, 200, 0, 0.92)'
    ctx.strokeStyle = selected ? '#fff' : 'rgba(0, 0, 0, 0.6)'
    ctx.lineWidth = 2 * scale
    ctx.beginPath()
    ctx.arc(px, py, ringR, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // Robot glyph.
    ctx.fillStyle = '#000'
    ctx.font = `${iconPx}px ${fontFamily}`
    ctx.fillText('🤖', px, py + scale)
    // Number badge — small pill below/right of the marker.
    const label = String(sp.number)
    ctx.font = `bold ${badgePx}px ${fontFamily}`
    const w = ctx.measureText(label).width + 8 * scale
    const bx = px + badgeOffsetX
    const by = py + badgeOffsetY
    ctx.fillStyle = 'rgba(20, 24, 32, 0.95)'
    ctx.strokeStyle = selected ? '#fff' : 'rgba(139, 92, 246, 0.9)'
    ctx.lineWidth = 1.5 * scale
    roundRect(ctx, bx, by, w, badgeH, 4 * scale)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.fillText(label, bx + w / 2, by + badgeH / 2)
  }
  ctx.restore()
}
