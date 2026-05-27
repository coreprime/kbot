// cursor.js
//
// Cursor + pan helpers shared across the canvas mouse-router and
// the keyboard handlers.  Five distinct concerns:
//
//   - Pan state — owned here as a module-private field.  beginPan
//     captures the mouse + scroll origin, updatePan slides the
//     scroll wrapper while the drag is in flight, endPan releases
//     it.  isPanning is consumed by the mouse-router so a mid-drag
//     pan doesn't trip the per-mode dispatchers.
//
//   - Space-pan hotkey — likewise private.  The studio keyboard
//     handler flips it on keydown / off on keyup via
//     setSpacePanHotkey, and the helpers below consult it so a
//     left-click with space held pans regardless of the active
//     tool.
//
//   - shouldPan — the heuristic that decides whether a fresh
//     mousedown is a pan gesture or a tool gesture.  Same triggers
//     the legacy code encoded: middle-click, left-click with
//     space, left-click in passive modes (View / Paint with no
//     selection / Select Features over empty space).
//
//   - updateHoverLabel — the per-mousemove status update.  Reads
//     the cursor cell + the feature under it, pokes the legacy
//     #hover-cell span (for third-party probes), and forwards to
//     the Camera & Cursor floating panel via updateCameraInfoCursor.
//     setCanvasHoverFeature is the private helper that gates the
//     feature-highlight write so the drawer's row hover doesn't
//     fight the canvas hover.
//
//   - tryAutoSwitchAt — auto-mode-swap on an unambiguous left
//     click.  If the click lands on a placed start marker or
//     feature while a *different* mode is active, jump into the
//     matching mode + arm a drag through the per-mode
//     beginFromAutoSwitch helpers.  Returns true when it consumed
//     the click.  Hidden layers skip the test.

import { state, $, setStatus, hostCallbacks } from '../host-context.js'
import {
  pickCell, findFeatureAt, findStartPositionAt, pickFeatureAttrCell,
  pickAttrCellForVoid,
} from './mouse-coords.js'
import { gameToCanvas } from './helpers.js'
import { updateCameraInfoCursor } from './camera-info.js'
import { beginTransaction } from './undo.js'
import { resetPaintStroke } from './paint-state.js'
import { beginStartPosDragFromAutoSwitch } from './modes/start-points.js'
import { beginFeatureDragFromAutoSwitch } from './modes/feature-select.js'

let _panState = null
let _spacePanHotkey = false

export function isPanning() { return _panState !== null }
export function getSpacePanHotkey() { return _spacePanHotkey }

// setSpacePanHotkey — the studio keyboard handler flips this on
// space-keydown / off on space-keyup.  When the flag goes false
// we also drop the grab cursor (unless a pan is mid-drag).
export function setSpacePanHotkey(on) {
  _spacePanHotkey = !!on
  if (!_spacePanHotkey && !_panState) document.body.style.cursor = ''
}

// cancelPan — used by abortTransientGestureState so a mode swap
// mid-drag doesn't leave the body cursor stuck on 'grabbing'.
export function cancelPan() {
  _panState = null
  _spacePanHotkey = false
}

export function shouldPan(e) {
  if (e.button === 1) return true
  if (e.button === 0 && _spacePanHotkey) return true
  if (e.button !== 0) return false
  if (state.mode === 'view') return true
  if (state.mode === 'paint' && !state.selected && !state.placement) return true
  if (state.mode === 'select-features') {
    if (findFeatureAt(e) < 0 && state.selected?.type !== 'feature') return true
  }
  // Erase mode and Picker mode are explicit tools — never pan with a
  // plain left-click; users can still pan via Space-hold or middle-click.
  return false
}

export function beginPan(e) {
  const wrap = $('#canvas-scroll')
  _panState = {
    startX: e.clientX,
    startY: e.clientY,
    startScrollX: wrap.scrollLeft,
    startScrollY: wrap.scrollTop,
  }
  document.body.style.cursor = 'grabbing'
  e.preventDefault()
}

export function updatePan(e) {
  if (!_panState) return
  const wrap = $('#canvas-scroll')
  wrap.scrollLeft = _panState.startScrollX - (e.clientX - _panState.startX)
  wrap.scrollTop = _panState.startScrollY - (e.clientY - _panState.startY)
}

export function endPan() {
  _panState = null
  document.body.style.cursor = _spacePanHotkey ? 'grab' : ''
  resetPaintStroke()
}

// setCanvasHoverFeature updates state.highlightFeatureName from the
// canvas side; the drawer's mouseenter/leave handlers update it from
// the sidebar side.  Whichever source most recently moved wins —
// minimap + outline renderers read state.highlightFeatureName.
let _canvasHoverFeature = null
function _setCanvasHoverFeature(name) {
  if (_canvasHoverFeature === name) return
  _canvasHoverFeature = name
  // The drawer's hover handler does its own dance with hoveredFeatureName
  // (which it uses to gate the animated thumbnail).  Don't fight it: if
  // the user is currently hovering a row, leave their highlight alone.
  if (state.hoveredFeatureName) return
  state.highlightFeatureName = name
  hostCallbacks.renderCanvas?.()
}

export function updateHoverLabel(e) {
  const { tx, ty } = pickCell(e)
  // #hover-cell (legacy canvas-toolbar) is gone — the Camera & Cursor
  // floating panel renders the hovered tile + sub-tile + height + zoom
  // in one place via updateCameraInfoCursor below.  We still touch the
  // legacy span when something else (a probe, a third-party extension)
  // happens to have re-inserted it.
  const hc = document.getElementById('hover-cell')
  if (tx < 0 || tx >= state.tileW || ty < 0 || ty >= state.tileH) {
    if (hc) hc.textContent = '—'
    _setCanvasHoverFeature(null)
    updateCameraInfoCursor(null)
    return
  }
  if (hc) hc.textContent = `(${tx}, ${ty})`
  // Highlight the feature under the cursor (if any) so the minimap can
  // narrow its dot view to that type — see renderMinimap.
  const hit = findFeatureAt(e)
  const name = hit >= 0 ? (state.features[hit]?.name || '').toLowerCase() : null
  _setCanvasHoverFeature(name)
  // Camera & Cursor panel cursor row: sub-tile is computed from the
  // raw attribute cell under the cursor (independent of feature-anchor
  // adjustments).
  const aa = pickAttrCellForVoid(e)
  updateCameraInfoCursor(tx, ty, aa.ax, aa.ay)
}

// tryAutoSwitchAt examines a left-click and, if it lands on a placed
// start position or feature, jumps into the matching editing mode with
// that item picked + drag-armed.  Returns true when it took the click.
// When the current mode already owns the clicked object type, we let
// that mode's native handler deal with the click (no redundant switch).
export function tryAutoSwitchAt(e) {
  // Space-pan hotkey suppresses the auto-mode-swap so the user can
  // hold space + drag without accidentally selecting a marker or
  // feature on the way past.
  if (_spacePanHotkey) return false
  const canvas = $('#canvas')
  if (!canvas) return false
  const rect = canvas.getBoundingClientRect()
  const cpx = (e.clientX - rect.left) / rect.width * canvas.width
  const cpy = (e.clientY - rect.top) / rect.height * canvas.height

  // Start positions are drawn on top of features visually, so they
  // win ties (overlapping click).  Hidden layers don't accept clicks.
  const schema = hostCallbacks.activeSchema?.()
  if (schema && state.mode !== 'start-points' && state.showStartPositions) {
    const hit = findStartPositionAt(schema, cpx, cpy)
    if (hit >= 0) {
      hostCallbacks.setMode?.('start-points')
      state.selectedStartPos = hit
      const sp = schema.startPositions[hit]
      const { px, py } = gameToCanvas(sp.x, sp.z)
      beginStartPosDragFromAutoSwitch(px - cpx, py - cpy)
      beginTransaction()
      hostCallbacks.renderCanvas?.()
      setStatus(`Picked start position ${sp.number} — drag to reposition, Delete to remove.`)
      return true
    }
  }

  // Features are anchored at (ax, ay) in 16-px attr coords; hit-test by
  // the tile they sit on.  Skip when features are hidden — clicks fall
  // through to whatever's underneath.
  if (state.mode !== 'select-features' && state.showFeatures) {
    const { tx, ty } = pickCell(e)
    if (tx >= 0 && tx < state.tileW && ty >= 0 && ty < state.tileH) {
      const fhit = findFeatureAt(e)
      if (fhit >= 0) {
        hostCallbacks.setMode?.('select-features')
        state.selectedFeature = fhit
        beginTransaction()
        const f = state.features[fhit]
        const cur = pickFeatureAttrCell(e, f)
        beginFeatureDragFromAutoSwitch(f.ax - cur.ax, f.ay - cur.ay)
        state.featureJustMoved = -1
        hostCallbacks.renderCanvas?.()
        setStatus(`Picked ${f.name} — drag to reposition, Delete to remove.`)
        return true
      }
    }
  }

  return false
}
