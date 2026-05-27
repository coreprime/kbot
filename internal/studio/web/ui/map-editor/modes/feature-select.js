// feature-select.js
//
// Feature-select mode handlers — click to select / drag an existing
// placed feature on the canvas, click empty space with an armed
// drawer selection to drop another copy.  Re-clicking the
// just-moved feature clears the selection (treats the click as
// confirming the move).  Move commits on mouseup as a single undo;
// "drop a copy" is its own atomic transaction.
//
// Module-private drag state (_dragging / _dragOffset) is scoped
// here so the studio's abortTransientGestureState helper + the
// mode-swap path can clear it through `resetFeatureDrag()`.  The
// auto-switch helper in studio.js seeds the same state through
// `beginFeatureDragFromAutoSwitch` so clicking a placed feature
// while in another mode continues straight into a drag without
// requiring a second mousedown.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas() — repaint after every selection / drag step.
//   - tryAutoSwitchAt(e) — set by studio.js; flips to start-points
//     mode when the click landed on a marker instead.
//   - placeFeature(ax, ay) — set by studio.js; drops `state.selected`
//     at the given attribute cell (with symmetry).  The feature
//     factory + symmetry expansion stay in studio.js because they
//     also feed the paint-mode auto-stamp path; one shared
//     implementation, two call sites.

import { state, hostCallbacks, clamp } from '../../host-context.js'
import { findFeatureAt, pickFeatureAttrCell } from '../mouse-coords.js'
import { beginTransaction, commitTransaction } from '../undo.js'
import { bumpContentVersion } from '../content-cache.js'

let _dragging = false
let _dragOffset = null

// resetFeatureDrag clears the in-flight drag state so a mode swap
// or abortTransientGestureState() doesn't leave us thinking a drag
// is still mid-flight.
export function resetFeatureDrag() {
  _dragging = false
  _dragOffset = null
}

// beginFeatureDragFromAutoSwitch seeds the drag state from
// tryAutoSwitchAt's path — clicking a placed feature while in
// another mode flips into select-features mode and continues the
// same gesture into a drag without waiting for a second
// mousedown.  ax/ay are the attribute-cell offsets the caller
// already computed.
export function beginFeatureDragFromAutoSwitch(ax, ay) {
  _dragOffset = { ax, ay }
  _dragging = true
}

export function onFeatureMouseDown(e) {
  // Start-position click in features mode jumps to start-points mode.
  if (e.button === 0 && hostCallbacks.tryAutoSwitchAt?.(e)) return
  // Hit-test against the actual cursor pixel — the previous tile-centre
  // shortcut missed 1×1 features whose anchor offset pushed the sprite
  // rect off the tile-centre point.
  const hit = findFeatureAt(e)
  if (hit >= 0) {
    // Treat a click on the just-moved selection as "I'm done with that
    // operation" and clear the selection instead of re-grabbing it.
    if (state.featureJustMoved === hit) {
      state.featureJustMoved = -1
      state.selectedFeature = -1
      hostCallbacks.renderCanvas?.()
      return
    }
    state.selectedFeature = hit
    _dragging = true
    beginTransaction()
    const f = state.features[hit]
    const cur = pickFeatureAttrCell(e, f)
    _dragOffset = { ax: f.ax - cur.ax, ay: f.ay - cur.ay }
    state.featureJustMoved = -1
    hostCallbacks.renderCanvas?.()
    return
  }
  // Empty space + a feature in the drawer → drop a copy here.  This is
  // how the user places multiple features without leaving the mode.
  if (state.selected?.type === 'feature') {
    const { ax, ay } = pickFeatureAttrCell(e, state.selected)
    beginTransaction()
    hostCallbacks.placeFeature?.(ax, ay)
    commitTransaction('Place feature')
    return
  }
  // Empty space + nothing armed → deselect any prior pick.
  state.selectedFeature = -1
  hostCallbacks.renderCanvas?.()
}

export function onFeatureMouseMove(e) {
  if (!_dragging || state.selectedFeature < 0) return
  const f = state.features[state.selectedFeature]
  const { ax, ay } = pickFeatureAttrCell(e, f)
  f.ax = clamp(ax + (_dragOffset?.ax || 0), 0, state.tileW * 2 - 1)
  f.ay = clamp(ay + (_dragOffset?.ay || 0), 0, state.tileH * 2 - 1)
  bumpContentVersion()
  // Remember that this selection was just moved — a subsequent click on
  // the same feature clears the selection (treats the click as "done").
  state.featureJustMoved = state.selectedFeature
  hostCallbacks.renderCanvas?.()
}

export function onFeatureMouseUp(_e) {
  if (_dragging) commitTransaction('Move feature')
  _dragging = false
  _dragOffset = null
}
