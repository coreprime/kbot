// heightmap.js
//
// Heightmap-mode handlers — sculpting the per-attribute-cell
// terrain height byte.  Four tools share the same brush stamp:
//
//   - raise   — add `strength` × falloff to every cell in the brush
//   - lower   — subtract `strength` × falloff
//   - level   — pull every cell toward the height of the first
//               clicked cell ('level samples on mousedown')
//   - smooth  — 3×3 box blur weighted by the brush mask
//
// Falloff is a quadratic — 1 at the centre, 0 at radius — so the
// brush feels soft without per-cell trig.
//
// The hold-timer (HM_HOLD_INTERVAL_MS) keeps stamping at the
// current hover cell while the user holds the button still —
// smooth + level both need continuous application to settle.
// Raise/lower also benefit so the user can sculpt without
// micro-wiggling the cursor.
//
// Module-private timer + the paint-stroke flags (`paintState`)
// drive the gesture.  resetHmHoldTimer is called by the abort
// path so a stuck timer doesn't keep applying the brush after
// the user has switched modes or the canvas lost focus.

import { state, hostCallbacks, clamp } from '../../host-context.js'
import { HM_HOLD_INTERVAL_MS } from '../constants.js'
import { pickAttrCellForVoid } from '../mouse-coords.js'
import { symmetryMatesAttr } from '../symmetry.js'
import { invalidateMinimapBase } from '../minimap.js'
import {
  beginTransaction, commitTransaction, abortTransaction,
} from '../undo.js'
import { paintState } from '../paint-state.js'

let _hmHoldTimer = null

// resetHmHoldTimer cancels the in-flight hold-tick interval.
// Called by abortTransientGestureState + the mouseup path so a
// dropped pointer doesn't leave us stamping silently.
export function resetHmHoldTimer() {
  if (_hmHoldTimer) {
    clearInterval(_hmHoldTimer)
    _hmHoldTimer = null
  }
}

export function onHeightmapMouseDown(e) {
  const { ax, ay } = pickAttrCellForVoid(e)
  beginTransaction()
  // Level samples the cell first clicked so the rest of the stroke
  // flattens to that height.
  const aw = state.tileW * 2
  if (state.hmTool === 'level' && ax >= 0 && ay >= 0 && ax < aw && ay < state.tileH * 2) {
    state.hmLevelHeight = state.heights[ay * aw + ax] | 0
  }
  paintHeightAt(ax, ay)
  paintState.paintedDuringStroke = true
  hostCallbacks.renderCanvas?.()
  // Auto-repeat: keep applying the brush at the most-recent cursor
  // cell until the user releases the button.  Smooth + level are
  // idempotent at the same cell so this is safe to do.
  resetHmHoldTimer()
  _hmHoldTimer = setInterval(() => {
    if (!paintState.painting || !state.hmCursor) return
    paintHeightAt(state.hmCursor.ax, state.hmCursor.ay)
    paintState.paintedDuringStroke = true
    hostCallbacks.renderCanvas?.()
  }, HM_HOLD_INTERVAL_MS)
}

export function onHeightmapMouseMove(e) {
  const { ax, ay } = pickAttrCellForVoid(e)
  if (!state.hmCursor || state.hmCursor.ax !== ax || state.hmCursor.ay !== ay) {
    state.hmCursor = { ax, ay }
    hostCallbacks.renderCanvas?.()
  }
  if (paintState.painting) {
    paintHeightAt(ax, ay)
    paintState.paintedDuringStroke = true
  }
}

export function onHeightmapMouseUp(_e) {
  resetHmHoldTimer()
  if (paintState.painting && paintState.paintedDuringStroke) commitTransaction(`Heightmap ${state.hmTool}`)
  else if (paintState.painting) abortTransaction()
  invalidateMinimapBase()
  hostCallbacks.renderCanvas?.()
}

// paintHeightAt — symmetry-aware brush stamp.  paintHeightAtSingle
// does the actual work for one stamp position.
export function paintHeightAt(ax, ay) {
  paintHeightAtSingle(ax, ay)
  for (const m of symmetryMatesAttr(ax, ay)) paintHeightAtSingle(m.ax, m.ay)
}

// paintHeightAtSingle applies the active heightmap brush at attribute-
// cell (ax, ay).  Falloff is a quadratic so the brush feels soft at the
// edge without per-cell trig.  Smooth runs a 3×3 box blur weighted by
// the brush mask so light passes are clean and heavy passes settle.
export function paintHeightAtSingle(ax, ay) {
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  const r = Math.max(1, state.hmRadius | 0)
  const r2 = r * r
  const tool = state.hmTool
  const strength = Math.max(1, state.hmStrength | 0)
  const target = (tool === 'level') ? clamp(state.hmLevelHeight | 0, 0, 255) : 0
  for (let dy = -r; dy <= r; dy++) {
    const yy = ay + dy
    if (yy < 0 || yy >= ah) continue
    for (let dx = -r; dx <= r; dx++) {
      const xx = ax + dx
      if (xx < 0 || xx >= aw) continue
      const d2 = dx * dx + dy * dy
      if (d2 > r2) continue
      const mask = 1 - d2 / r2 // 0 at the edge, 1 at the centre
      const idx = yy * aw + xx
      const cur = state.heights[idx] | 0
      let next = cur
      if (tool === 'raise') {
        next = cur + Math.round(strength * mask)
      } else if (tool === 'lower') {
        next = cur - Math.round(strength * mask)
      } else if (tool === 'level') {
        // Mix the cell toward the captured height.
        const t = mask * 0.5
        next = Math.round(cur * (1 - t) + target * t)
      } else if (tool === 'smooth') {
        // 3×3 mean of the *current* neighbourhood, mixed in by the mask.
        let sum = 0; let n = 0
        for (let ny = -1; ny <= 1; ny++) {
          const ny2 = yy + ny
          if (ny2 < 0 || ny2 >= ah) continue
          for (let nx = -1; nx <= 1; nx++) {
            const nx2 = xx + nx
            if (nx2 < 0 || nx2 >= aw) continue
            sum += state.heights[ny2 * aw + nx2] | 0
            n++
          }
        }
        const avg = n > 0 ? sum / n : cur
        const t = mask * Math.min(1, strength / 12)
        next = Math.round(cur * (1 - t) + avg * t)
      }
      state.heights[idx] = clamp(next, 0, 255)
    }
  }
}
