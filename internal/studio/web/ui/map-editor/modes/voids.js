// voids.js
//
// Voids-mode mouse handlers — painting the impassable / no-build
// attribute cells.  The first cell clicked sets the brush state
// (toggle of whatever was there); the rest of the drag applies
// that same target state to every attribute cell inside the brush
// footprint.  Mouseup commits as a single undo.
//
// voidsDragState records the toggle target chosen on mousedown so
// the whole drag uses the same paint vs. erase mode.
// resetVoidsDrag() lets setMode swap modes mid-drag without
// leaving a stale drag state behind.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas() — schedule a repaint after every brush stamp.

import { state, hostCallbacks } from '../host-context.js'
import { pickAttrCellForVoid } from '../mouse-coords.js'
import { beginTransaction, commitTransaction } from '../undo.js'
import { invalidateMinimapBase } from '../minimap.js'

let voidsDragState = null // { target } while dragging

export function resetVoidsDrag() {
  voidsDragState = null
}

export function onVoidsMouseDown(e) {
  const { ax, ay } = pickAttrCellForVoid(e)
  if (ax < 0 || ay < 0 || ax >= state.tileW * 2 || ay >= state.tileH * 2) return
  const aw = state.tileW * 2
  const prev = state.voids[ay * aw + ax] | 0
  beginTransaction()
  voidsDragState = { target: prev ? 0 : 1 }
  paintVoidBrush(ax, ay, voidsDragState.target)
  hostCallbacks.renderCanvas?.()
}

export function onVoidsMouseMove(e) {
  const { ax, ay } = pickAttrCellForVoid(e)
  // Track cursor for the brush outline overlay even when not
  // painting.
  if (!state.voidsCursor || state.voidsCursor.ax !== ax || state.voidsCursor.ay !== ay) {
    state.voidsCursor = { ax, ay }
    hostCallbacks.renderCanvas?.()
  }
  if (!voidsDragState) return
  paintVoidBrush(ax, ay, voidsDragState.target)
  hostCallbacks.renderCanvas?.()
}

export function onVoidsMouseUp(_e) {
  if (!voidsDragState) return
  voidsDragState = null
  commitTransaction('Paint voids')
  invalidateMinimapBase()
  hostCallbacks.renderCanvas?.()
}

// paintVoidBrush stamps a size×size block centred on (ax, ay)
// with the given target value (1 = void, 0 = passable).  Centring
// matches the erase brush so a "1×1" stamp is exactly one cell
// under the cursor and even sizes lean toward the top-left of the
// cursor cell.
function paintVoidBrush(ax, ay, target) {
  const size = Math.max(1, state.voidsBrushSize || 1)
  const off = Math.floor(size / 2)
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  const x0 = ax - off
  const y0 = ay - off
  for (let dy = 0; dy < size; dy++) {
    const cy = y0 + dy
    if (cy < 0 || cy >= ah) continue
    for (let dx = 0; dx < size; dx++) {
      const cx = x0 + dx
      if (cx < 0 || cx >= aw) continue
      state.voids[cy * aw + cx] = target
    }
  }
}
