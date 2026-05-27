// mouse-router.js
//
// Central canvas mouse dispatcher.  Each editor mode registers a
// `{ down, move, up }` triple in MODE_HANDLERS; this module looks
// up the active mode on every event and forwards to the matching
// callback.  The dispatcher itself owns the cross-mode bookkeeping
// every stroke shares:
//
//   - mousedown: prime paintState (painting=true, painted=false)
//   - mousedown: shouldPan() short-circuits into beginPan(),
//     with a tryAutoSwitchAt() escape hatch for clicks that
//     should swap modes first
//   - mousemove: pan-drag short-circuits into updatePan();
//     otherwise updateHoverLabel runs first + the cursor cell
//     gets cached so Ctrl+V can paste at the user's last hover
//   - mouseup: pan-drag finishes via endPan(); otherwise the
//     mode's up handler runs followed by resetPaintStroke()
//
// Lives in /ui/map-editor/ because every dispatch target is a
// map-editor mode.  Pure dispatch — no DOM beyond pickCell's
// canvas read.

import { state, hostCallbacks } from '../host-context.js'
import { pickCell } from './mouse-coords.js'
import { paintState, resetPaintStroke } from './paint-state.js'

import {
  onPaintMouseDown, onPaintMouseMove, onPaintMouseUp,
} from './modes/paint.js'
import {
  onEraseMouseDown, onEraseMouseMove, onEraseMouseUp,
} from './modes/erase.js'
import {
  onTerrainMouseDown, onTerrainMouseMove, onTerrainMouseUp,
} from './modes/terrain-select.js'
import {
  onFeatureMouseDown, onFeatureMouseMove, onFeatureMouseUp,
} from './modes/feature-select.js'
import {
  onPickerMouseDown, onPickerMouseMove, onPickerMouseUp,
} from './modes/picker.js'
import {
  onStartPosMouseDown, onStartPosMouseMove, onStartPosMouseUp,
} from './modes/start-points.js'
import {
  onVoidsMouseDown, onVoidsMouseMove, onVoidsMouseUp,
} from './modes/voids.js'
import {
  onHeightmapMouseDown, onHeightmapMouseMove, onHeightmapMouseUp,
} from './modes/heightmap.js'
import { onFillMouseDown } from './modes/fill.js'
import { onRulerMouseDown, onRulerMouseMove } from './canvas/ruler.js'

// MODE_HANDLERS — single source of truth for canvas mouse dispatch.
// A mode that doesn't need a particular event leaves the slot undefined;
// the dispatcher just no-ops for that event.  Ruler mode has no
// mouseup handler (the move handler already tracks the line endpoints).
// Fill mode has only mousedown — flood-fill / global-replace is a
// single-click operation with no drag.
const MODE_HANDLERS = new Map([
  ['paint',           { down: onPaintMouseDown,     move: onPaintMouseMove,     up: onPaintMouseUp }],
  ['erase',           { down: onEraseMouseDown,     move: onEraseMouseMove,     up: onEraseMouseUp }],
  ['select-terrain',  { down: onTerrainMouseDown,   move: onTerrainMouseMove,   up: onTerrainMouseUp }],
  ['select-features', { down: onFeatureMouseDown,   move: onFeatureMouseMove,   up: onFeatureMouseUp }],
  ['picker',          { down: onPickerMouseDown,    move: onPickerMouseMove,    up: onPickerMouseUp }],
  ['start-points',    { down: onStartPosMouseDown,  move: onStartPosMouseMove,  up: onStartPosMouseUp }],
  ['voids',           { down: onVoidsMouseDown,     move: onVoidsMouseMove,     up: onVoidsMouseUp }],
  ['heightmap',       { down: onHeightmapMouseDown, move: onHeightmapMouseMove, up: onHeightmapMouseUp }],
  ['fill',            { down: onFillMouseDown }],
  ['ruler',           { down: onRulerMouseDown,     move: onRulerMouseMove }],
])

export function onCanvasMouseDown(e) {
  paintState.paintedDuringStroke = false
  paintState.painting = true

  if (hostCallbacks.shouldPan?.(e)) {
    // Auto-switch on an unambiguous left-click: a clean click on a
    // start position or placed feature in a passive mode (where the
    // click would otherwise just pan) jumps into the matching mode
    // and arms a drag.  Middle-click and space-pan still pan as usual.
    if (e.button === 0 && hostCallbacks.tryAutoSwitchAt?.(e)) return
    hostCallbacks.beginPan?.(e)
    return
  }

  const handler = MODE_HANDLERS.get(state.mode)
  handler?.down?.(e)
}

export function onCanvasMouseMove(e) {
  if (hostCallbacks.isPanning?.()) {
    hostCallbacks.updatePan?.(e)
    return
  }
  hostCallbacks.updateHoverLabel?.(e)
  // Track the cursor cell so Ctrl+V can paste at the user's last hover
  // point.  Reset on mouseleave (handled by the canvas leave listener).
  const cell = pickCell(e)
  if (cell.tx >= 0 && cell.tx < state.tileW && cell.ty >= 0 && cell.ty < state.tileH) {
    hostCallbacks.cursor.lastHover = cell
  }

  const handler = MODE_HANDLERS.get(state.mode)
  handler?.move?.(e)
}

export function onCanvasMouseUp(e) {
  if (hostCallbacks.isPanning?.()) {
    hostCallbacks.endPan?.()
    return
  }
  const handler = MODE_HANDLERS.get(state.mode)
  handler?.up?.(e)
  resetPaintStroke()
}
