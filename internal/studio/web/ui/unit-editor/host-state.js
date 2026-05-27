// host-state.js
//
// Module-private host state for the unit editor: the currently-active
// ModelViewer instance, the persisted Auto-Rotate toggle, the next-
// open intent flag for the Open Unit picker, and the TEAM_COLOURS
// palette the React ribbon hands back to the renderer.
//
// Why this lives here:
//
//   - modelViewerInstance was the longest-lived module-level let in
//     studio.js — touched from the ribbon, the host bridge, the
//     debugger modal, the per-tab activator, and the open-flow.
//     Centralising it on this side of the seam means tab.js can
//     promote a tab's viewer without studio.js participating, and
//     other unit-editor modules can read the active viewer through
//     a plain function call instead of a hostCallbacks indirection.
//   - _unitEditorAutoRotate is the persisted Auto-Rotate state shared
//     by the React Camera dropdown, the Renderer panel, the R hotkey,
//     and freshly-opened tabs.  Setter mirrors back into the React
//     ribbon signal so dropdown + canvas stay in lockstep.
//   - modelOpenIntent is the next-open intent ('add' | 'replace') the
//     React ribbon's "Open another model…" sets right before kicking
//     openModelPicker.  Lives next to the viewer it controls.
//   - TEAM_COLOURS is the hue-shift table the ribbon's setTeamColor
//     callback consumes; null at 'blue' disables the recolour shader
//     entirely (matches the original game's "Blue (default)" semantics).
//
// External callers that still live in studio.js reach the getters
// through hostCallbacks (registered in studio.js's boot block) so the
// API surface to non-unit-editor code is unchanged.

import { getReactUi } from '../host-context.js'

// modelViewerInstance — the currently-active unit-editor ModelViewer.
// Module-private; readers go through getActiveModelViewer() and the
// per-tab activator flips it via setActiveModelViewer().
let modelViewerInstance = null

export function getActiveModelViewer() {
  return modelViewerInstance
}

// setActiveModelViewer also writes window.__modelViewer so the debug
// global keeps working — model-viewer.js's COB binding used to reach
// back through that hook before the per-tab refactor, and other dev
// scripts in the wild still read it.
export function setActiveModelViewer(v) {
  modelViewerInstance = v
  if (typeof window !== 'undefined') window.__modelViewer = v
}

// _unitEditorAutoRotate — host-side cache of the Auto-Rotate toggle
// state shared by the React Camera dropdown, the Renderer panel, the
// R hotkey, and freshly-opened model tabs.  Mutated through the React
// ribbon's bridge (which writes both this var and the renderer) and
// the configureHostBridge.setAutoRotate callback (which mirrors back
// into the React state signal).  Default matches the React signal's
// initial `autoRotate: true` so an early open before the user touches
// the toggle paints the same default both surfaces show.
let _unitEditorAutoRotate = true

export function getUnitEditorAutoRotate() {
  return _unitEditorAutoRotate
}

// setUnitEditorAutoRotate flips the host cache + mirrors back into
// the React ribbon's Camera dropdown signal so the Auto-Rotate toggle
// row's check flips in lockstep.  Callers that ALSO need to drive the
// renderer call mv.setAutoRotate() separately — the setter intentionally
// only touches host-side state.
export function setUnitEditorAutoRotate(on) {
  _unitEditorAutoRotate = !!on
  const ui = getReactUi()
  if (ui && typeof ui.setModelViewerRibbonState === 'function') {
    ui.setModelViewerRibbonState({ autoRotate: !!on })
  }
}

// __mvNotifyAutoRotateOff — model-viewer.js's orbit-controls fire
// this when a wheel-zoom interrupts an active auto-rotate.  We flip
// the host cache + the React Camera dropdown's check-mark in one
// place; the renderer's own state was already updated by the orbit
// controller, so we don't double-dispatch into setAutoRotate(false).
if (typeof window !== 'undefined') {
  window.__mvNotifyAutoRotateOff = () => {
    _unitEditorAutoRotate = false
    const ui = getReactUi()
    if (ui && typeof ui.setModelViewerRibbonState === 'function') {
      ui.setModelViewerRibbonState({ autoRotate: false })
    }
  }
}

// modelOpenIntent: tells openModelViewer how to handle the next
// load — 'add' pushes a new tab, 'replace' overwrites the current
// active tab (only meaningful when the active tab is already a
// model tab).
let modelOpenIntent = 'add'

export function getModelOpenIntent() {
  return modelOpenIntent
}

export function setModelOpenIntent(v) {
  modelOpenIntent = v
}

// TEAM_COLOURS — hue-shift RGB triplets the renderer's setTeamColor
// applies to the unit's team-colour palette indices.  `blue` is the
// ARM default and intentionally null so picking it disables the
// shader's recolour entirely (matching the original game's "Blue
// (default)" semantics).  Kept at module scope so the React ribbon's
// bridge can look up a colour without re-importing model3d's tables.
export const TEAM_COLOURS = {
  blue:   null,
  red:    [0.92, 0.18, 0.16],
  green:  [0.20, 0.78, 0.28],
  yellow: [0.95, 0.85, 0.20],
  purple: [0.62, 0.30, 0.85],
  cyan:   [0.20, 0.80, 0.92],
  orange: [0.98, 0.55, 0.18],
  white:  [0.95, 0.95, 0.95],
  black:  [0.10, 0.10, 0.12],
}
