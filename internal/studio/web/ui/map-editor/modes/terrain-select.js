// terrain-select.js
//
// Terrain-select mode handlers — drag a rectangle to capture a
// region into the terrain clipboard, then drag the floating
// clipboard around (or click outside to drop it).  Releasing the
// mouse on a drag commits the move; releasing after a sweep
// captures and shrinks the rectangle to the actual content.
//
// Three module-private fields track the in-flight gesture:
//   _dragging       — true while sweeping a fresh rectangle
//   _dragStart      — { tx, ty } anchor for the in-flight rect
//   _moveAnchor     — { tx, ty, originalTx, originalTy } when
//                     translating an existing clipboard, captured
//                     at mousedown so subsequent moves are
//                     anchor-relative
//
// resetTerrainDrag clears all three so abortTransientGestureState
// can cancel a half-finished gesture without leaving stale state.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas() — repaint after every selection / drag step.
//   - tryAutoSwitchAt(e) — set by studio.js so a click on a placed
//     feature / start marker in this mode flips to that mode
//     first (it already encodes the space-pan guard).

import { state, setStatus, hostCallbacks } from '../../host-context.js'
import { pickCell } from '../mouse-coords.js'
import { normalizedRect } from '../helpers.js'
import { beginTransaction, commitTransaction } from '../undo.js'
import {
  shrinkRectToContent,
  captureTerrain,
  dropTerrainClipboard,
} from '../clipboard.js'

let _dragging = false
let _dragStart = null   // { tx, ty } when starting a rectangle drag
let _moveAnchor = null  // { tx, ty, originalTx, originalTy } when moving clipboard

// resetTerrainDrag clears every in-flight gesture so mode swaps +
// abortTransientGestureState don't carry the half-finished state
// over.
export function resetTerrainDrag() {
  _dragging = false
  _dragStart = null
  _moveAnchor = null
}

export function onTerrainMouseDown(e) {
  const { tx, ty } = pickCell(e)
  if (state.terrainClipboard) {
    const c = state.terrainClipboard
    const insideClipboard = tx >= c.tx && tx < c.tx + c.w && ty >= c.ty && ty < c.ty + c.h
    if (insideClipboard) {
      // Begin dragging the floating clipboard.
      _moveAnchor = { tx, ty, originalTx: c.tx, originalTy: c.ty }
      return
    }
    // Click outside drops the clipboard back onto the canvas — undoable
    // as a single "Drop terrain" step.
    beginTransaction()
    dropTerrainClipboard()
    commitTransaction('Drop terrain')
    return
  }
  // Direct click on a placed feature or start position takes precedence
  // over starting a rectangle selection — it switches to the matching
  // edit mode with that object picked.
  if (e.button === 0 && hostCallbacks.tryAutoSwitchAt?.(e)) return
  if (tx < 0 || tx >= state.tileW || ty < 0 || ty >= state.tileH) return
  _dragging = true
  _dragStart = { tx, ty }
  state.rectSelection = { x: tx, y: ty, w: 1, h: 1 }
  hostCallbacks.renderCanvas?.()
}

export function onTerrainMouseMove(e) {
  if (_moveAnchor && state.terrainClipboard) {
    const { tx, ty } = pickCell(e)
    const dx = tx - _moveAnchor.tx
    const dy = ty - _moveAnchor.ty
    state.terrainClipboard.tx = _moveAnchor.originalTx + dx
    state.terrainClipboard.ty = _moveAnchor.originalTy + dy
    hostCallbacks.renderCanvas?.()
    return
  }
  if (!_dragging) return
  const { tx, ty } = pickCell(e)
  if (!state.rectSelection || !_dragStart) return
  state.rectSelection = {
    x: _dragStart.tx,
    y: _dragStart.ty,
    w: (tx - _dragStart.tx) + (tx >= _dragStart.tx ? 1 : -1),
    h: (ty - _dragStart.ty) + (ty >= _dragStart.ty ? 1 : -1),
  }
  hostCallbacks.renderCanvas?.()
}

export function onTerrainMouseUp(_e) {
  if (_moveAnchor) {
    // Releasing the mouse after a move commits the clipboard at its
    // current position and clears the selection — saves the user a
    // separate "click outside to drop" gesture.
    _moveAnchor = null
    beginTransaction()
    dropTerrainClipboard()
    commitTransaction('Move terrain')
    return
  }
  if (!_dragging) return
  _dragging = false
  if (!state.rectSelection) return
  const r = normalizedRect(state.rectSelection)
  state.rectSelection = null
  if (r.w <= 0 || r.h <= 0) { hostCallbacks.renderCanvas?.(); return }
  // Tighten the captured rectangle to the minimum bounding box of any
  // tiles or features the user actually selected — so a sloppy drag
  // over mostly-empty space still produces a clean clipboard.
  const shrunk = shrinkRectToContent(r.x, r.y, r.w, r.h)
  if (!shrunk) {
    setStatus('No tiles or features in the selected area.')
    hostCallbacks.renderCanvas?.()
    return
  }
  beginTransaction()
  captureTerrain(shrunk.x, shrunk.y, shrunk.w, shrunk.h)
  commitTransaction('Capture terrain')
}
