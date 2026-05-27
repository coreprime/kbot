// view-toggles.js
//
// Imperative setters for the View menu's visibility toggles —
// minimap, features, start positions, voids.  Each one flips a
// state.show* flag, debounce-persists the change through
// persistPrefs, republishes the ribbon state for the React UI,
// and either repaints the canvas or drops out of an
// incompatible mode.
//
// Why drop modes?  Hiding features while the user is in a
// feature-centric tool (select-features / picker) would leave
// them with a tool whose targets are invisible.  Same for
// start-points and voids.  Falling back to select-terrain keeps
// the editor in a coherent state regardless of which toggle
// flipped.
//
// Cross-module deps via hostCallbacks:
//   - setMode(mode)             — drop out of incompatible modes
//   - renderCanvas()            — repaint after a toggle
//   - publishMapRibbonState()   — push the new flag into the React ribbon
// Plus getReactUi() for the panel-store passthrough.

import { state, hostCallbacks, getReactUi } from '../host-context.js'
import { persistPrefs } from '../common/prefs.js'

export function setMinimapVisible(visible) {
  state.showMinimap = !!visible
  // React MinimapPanel reads visibility from the shared
  // panel-store; routing through ui.setPanelVisible flips the
  // signal AND writes through the persistence bridge (which
  // keeps state.mvInspectorVisible + persistPrefs in lockstep).
  const ui = getReactUi()
  if (ui && typeof ui.setPanelVisible === 'function') {
    ui.setPanelVisible('minimap-panel', !!visible)
  }
  persistPrefs()
  hostCallbacks.publishMapRibbonState?.()
}

// setFeaturesVisible / setStartPositionsVisible mirror
// setMinimapVisible but cover the two new View toggles.
// Toggling features off while the user is in a feature-centric
// mode (select-features or picker) drops them back to Select,
// since a tool that can't see its targets is useless.  Same for
// start-positions mode.
export function setFeaturesVisible(visible) {
  state.showFeatures = visible
  persistPrefs()
  hostCallbacks.publishMapRibbonState?.()
  if (!visible && (state.mode === 'select-features' || state.mode === 'picker')) {
    hostCallbacks.setMode?.('select-terrain')
  } else {
    hostCallbacks.renderCanvas?.()
  }
}

export function setStartPositionsVisible(visible) {
  state.showStartPositions = visible
  persistPrefs()
  hostCallbacks.publishMapRibbonState?.()
  if (!visible && state.mode === 'start-points') {
    hostCallbacks.setMode?.('select-terrain')
  } else {
    hostCallbacks.renderCanvas?.()
  }
}

// setVoidsVisible toggles the view-menu pref.  The actual draw
// call in drawVoidOverlay reads state.showVoids AND the active
// mode, so a user in Voids mode still sees what they're painting.
export function setVoidsVisible(visible) {
  state.showVoids = visible
  persistPrefs()
  hostCallbacks.publishMapRibbonState?.()
  // Hiding voids while the user is still in Voids paint mode
  // would leave them with an invisible tool — drop back to
  // Select so the editor stays in a coherent state.
  if (!visible && state.mode === 'voids') {
    hostCallbacks.setMode?.('select-terrain')
  } else {
    hostCallbacks.renderCanvas?.()
  }
}

// applyMinimapPosition — vestigial helper.  The legacy code
// wrote directly to the #minimap-panel inline style after a
// drag; the React MinimapPanel now manages its own position via
// the panel-store + FloatingPanel persistence, so this is a
// no-op.  Kept (and exported) for backward-compatible signature
// since the legacy host API still references it.
export function applyMinimapPosition() {
  return
}
