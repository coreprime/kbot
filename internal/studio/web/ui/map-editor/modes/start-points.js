// start-points.js
//
// Start-position mode handlers — click to select / drag an existing
// marker, click empty space to drop the next sequential marker.
// Re-clicking a marker that was just moved confirms the placement
// and clears the selection.  Selection + drag commit as one undo
// step on mouseup; placing a new marker is a self-contained
// transaction so the user can undo each placement individually.
//
// Module-private drag state (_dragging / _dragOffset) is scoped to
// this module so the studio's abortTransientGestureState helper +
// the mode-swap path can clear it through `resetStartPosDrag()`
// without reaching into a global.  The auto-switch helper in
// studio.js seeds the same state through `beginStartPosDragFromAutoSwitch`
// so clicking a marker while in another mode continues the same
// gesture straight into a drag without requiring a second
// mousedown.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas() — repaint after every selection / placement /
//     drag-step.
//   - tryAutoSwitchAt(e) — set by studio.js so a left-click that
//     lands on a feature or a *different* marker swaps modes
//     first; we early-return when it consumes the click.

import { state, $, setStatus, clamp, hostCallbacks } from '../../host-context.js'
import { MAX_START_POSITIONS } from '../constants.js'
import { findStartPositionAt } from '../mouse-coords.js'
import { gameToCanvas, canvasToGame } from '../helpers.js'
import { beginTransaction, commitTransaction } from '../undo.js'

let _dragging = false
let _dragOffset = null // { dx, dy } in canvas px

// resetStartPosDrag clears the in-flight drag state so a mode swap
// or abortTransientGestureState() doesn't leave us thinking a drag
// is mid-flight after the user's pointer left the canvas.
export function resetStartPosDrag() {
  _dragging = false
  _dragOffset = null
}

// beginStartPosDragFromAutoSwitch seeds the drag state from
// tryAutoSwitchAt's path — when the auto-switch fires from outside
// start-points mode and lands on an existing marker, the same
// click should immediately enter a drag rather than waiting for a
// fresh mousedown.  The caller has already computed dx / dy
// relative to the cursor in canvas px.
export function beginStartPosDragFromAutoSwitch(dx, dy) {
  _dragOffset = { dx, dy }
  _dragging = true
}

function _activeSchema() {
  if (!state.ota || !state.ota.schemas[state.activeSchema]) return null
  return state.ota.schemas[state.activeSchema]
}

export function onStartPosMouseDown(e) {
  // Feature / different-marker click in start-points mode jumps to
  // the matching mode (features → select-features, other marker →
  // re-grab).  tryAutoSwitchAt handles the spacePanHotkey check
  // internally so we can dispatch unconditionally.
  if (e.button === 0 && hostCallbacks.tryAutoSwitchAt?.(e)) return
  const schema = _activeSchema()
  if (!schema) return
  const canvas = $('#canvas')
  const rect = canvas.getBoundingClientRect()
  const cx = (e.clientX - rect.left) / rect.width * canvas.width
  const cy = (e.clientY - rect.top) / rect.height * canvas.height
  const hit = findStartPositionAt(schema, cx, cy)
  if (hit >= 0) {
    // Re-clicking the just-moved start position clears the selection
    // (treat as confirming the move is done).
    if (state.startPosJustMoved === hit) {
      state.startPosJustMoved = -1
      state.selectedStartPos = -1
      hostCallbacks.renderCanvas?.()
      return
    }
    state.selectedStartPos = hit
    const sp = schema.startPositions[hit]
    const { px, py } = gameToCanvas(sp.x, sp.z)
    _dragOffset = { dx: px - cx, dy: py - cy }
    _dragging = true
    state.startPosJustMoved = -1
    beginTransaction()
    hostCallbacks.renderCanvas?.()
    return
  }
  // Empty space — place the next available start position.  Numbering
  // is dense and 1-based: the new marker takes (existing count + 1),
  // capped at MAX_START_POSITIONS (the game-wide multiplayer ceiling).
  // Deleting a marker compacts the list so numbers stay contiguous —
  // see handleDeleteKey.
  const cap = MAX_START_POSITIONS
  if (schema.startPositions.length >= cap) {
    setStatus(`This schema is full — all ${cap} start position${cap === 1 ? '' : 's'} are placed.  Drag a marker or Delete one to free a slot.`)
    return
  }
  const nextNum = schema.startPositions.length + 1
  const { gx, gz } = canvasToGame(cx, cy)
  beginTransaction()
  schema.startPositions.push({ number: nextNum, x: gx, z: gz })
  state.selectedStartPos = schema.startPositions.length - 1
  commitTransaction(`Place start position ${nextNum}`)
  hostCallbacks.renderCanvas?.()
}

export function onStartPosMouseMove(e) {
  if (!_dragging || state.selectedStartPos < 0) return
  const schema = _activeSchema()
  if (!schema) return
  const canvas = $('#canvas')
  const rect = canvas.getBoundingClientRect()
  const cx = (e.clientX - rect.left) / rect.width * canvas.width
  const cy = (e.clientY - rect.top) / rect.height * canvas.height
  const targetPx = cx + (_dragOffset?.dx || 0)
  const targetPy = cy + (_dragOffset?.dy || 0)
  const { gx, gz } = canvasToGame(targetPx, targetPy)
  const sp = schema.startPositions[state.selectedStartPos]
  if (sp) {
    sp.x = clamp(gx, 0, state.tileW * 32)
    sp.z = clamp(gz, 0, state.tileH * 32)
    state.startPosJustMoved = state.selectedStartPos
    hostCallbacks.renderCanvas?.()
  }
}

export function onStartPosMouseUp(_e) {
  if (_dragging) {
    commitTransaction('Move start position')
    _dragging = false
    _dragOffset = null
  }
}
