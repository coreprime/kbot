// host-state.js
//
// Module-private host state for the unit editor: the currently-active
// ModelViewer instance, the persisted Auto-Rotate toggle, the next-
// open intent flag for the Open Unit picker, and the team-colour
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
//   - teamColourForKey is the hue-shift lookup the ribbon's setTeamColor
//     callback consumes; null at 'blue' disables the recolour shader
//     entirely (matches the original game's "Blue (default)" semantics).
//
// External callers that still live in studio.js reach the getters
// through hostCallbacks (registered in studio.js's boot block) so the
// API surface to non-unit-editor code is unchanged.

import { TEAM_SIDES } from '@coreprime/kbot-game3d/team-colors'
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
// into the React state signal).  Default OFF — a freshly-opened unit
// sits still until the user turns rotation on (R key or the Camera
// menu's Auto-Rotate toggle).  Must match the React ribbon signal's
// initial `autoRotate: false` so both surfaces agree on first paint.
let _unitEditorAutoRotate = false

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

// teamColourForKey — hue-shift RGB triplet the renderer's setTeamColor
// applies for a side key, read from the injected game team table (so a
// custom game's sides drive the ribbon's team menu too). The side-0 key
// returns null, disabling the shader's recolour entirely (matching the
// original game's "Blue (default)" semantics). `white` is a viewer-only
// extra the ribbon offers for screenshots; it is not a game side.
const VIEWER_EXTRA_COLOURS = { white: [0.95, 0.95, 0.95] }

export function teamColourForKey(key) {
  const entry = TEAM_SIDES.find((s) => s.key === key)
  if (entry) return entry.rgb
  return VIEWER_EXTRA_COLOURS[key] ?? null
}
