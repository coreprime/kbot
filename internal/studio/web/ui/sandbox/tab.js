// tab.js
//
// Sandbox tab lifecycle — the welcome-card entry point that creates a
// new sandbox tab, and the activation path that swaps the canvas /
// renderer / panel set on the way in.  Sister module to
// /ui/unit-editor/tab.js; the two stay close in shape so the
// switchToTab dispatcher in studio.js can hand off without caring
// which path it took.
//
// What lives here:
//
//   - openSandboxStub — welcome-card click handler.  Pushes a 'model'
//     tab marked sandbox: true through the host's pushTab seam +
//     activates it.  The shared 'model' tab type lets the existing
//     close / minimap / ribbon machinery treat the sandbox like
//     "just another unit-editor tab" without special-casing.
//   - sharedModelViewerCanvas() — lazy accessor for the legacy
//     `#model-viewer-canvas` element that ships from the bootstrap
//     HTML.  Sandbox tabs detach it from the stage on first activation
//     to mount their own per-tab canvas; holding a reference here
//     keeps the unit-editor's re-mount path alive when the user
//     navigates back to a model tab and `getElementById` would
//     otherwise return null (the element left the document tree).
//   - activateSandboxTab(tab) — the ~180-line activation routine:
//     stop the unit-editor renderer + every OTHER sandbox tab's
//     renderer, detach their canvases, lazy-construct the
//     SandboxView for this tab, attach its canvas, open(), restore
//     paused/running state, wrap the per-frame inspector publish
//     into renderer.onAfterFrame, show the sandbox panel + force
//     the right inspector set visible, wire the ribbon + Controls
//     intercept, mark the dialog `sandbox-mode` so CSS collapses
//     the unit-editor sidebar.
//   - getActiveSandboxView() / clearActiveSandboxView() — the live
//     reference to the foregrounded SandboxView.  studio.js's tab
//     close + switchToTab cleanup paths read it through these
//     getters so the host doesn't need its own `let`.
//
// Reaches studio.js (modelViewerInstance, tabs[], pushTab seam,
// resumeIncomingTabRuntime, refreshMvInspectors) through hostCallbacks.

import { $, hostCallbacks } from '../host-context.js'
import { mvSetSimulationSpeed } from '../common/sim-controls.js'
import { setMvInspectorVisible } from '../common/inspectors.js'
import { ensureSandboxPanel, showSandboxPanel } from './spawn-picker.js'
import { wireSandboxRibbon } from './ribbon-bridge.js'
import { wireSandboxControlsIntercept } from './controls-intercept.js'
import { resetSandboxFocusedUnit } from '../common/refresh-tick.js'

// `_sandboxViewInstance` tracks the CURRENTLY ACTIVE sandbox tab's
// SandboxView.  Each sandbox tab owns its own SandboxView (stored on
// tab.viewer); on activation we swap this module-local pointer to
// whichever view belongs to the incoming tab so the rest of the studio
// (panels, roster, ribbon-button handlers) reads from the right scene.
// Two sandbox tabs no longer share units / runtime / selection.
let _sandboxViewInstance = null

export function getActiveSandboxView() { return _sandboxViewInstance }

// clearActiveSandboxView — null out the active reference.  The tab
// close handler in studio.js calls this when the tab being torn down
// matched the live view so subsequent reads (ribbon clicks, refresh
// tick) see "no sandbox loaded" and short-circuit cleanly.
export function clearActiveSandboxView() { _sandboxViewInstance = null }

// Captured at first activation — the shared `#model-viewer-canvas`
// element used by the single-unit ModelViewer.  Once a sandbox tab
// detaches it from the stage to mount its own per-tab canvas,
// getElementById('model-viewer-canvas') returns null because the
// element is no longer in the document tree.  Holding a reference
// here keeps the re-mount path on the way back to a unit-editor tab
// alive instead of silently appending nothing.
let _sharedModelViewerCanvas = null
export function sharedModelViewerCanvas() {
  if (!_sharedModelViewerCanvas) {
    _sharedModelViewerCanvas = document.getElementById('model-viewer-canvas')
  }
  return _sharedModelViewerCanvas
}

// openSandboxStub — Sandbox welcome-card entry point.  Routes
// through the host's tab registry — openTab consults the 'sandbox'
// descriptor (registered by /ui/sandbox/register-tab.js at boot),
// builds an instance, pushes the host record, and switches focus.
// No type discriminator + no legacy `sandbox: true` flag — the
// registry handles dispatch by typeId.
export function openSandboxStub() {
  hostCallbacks.openTab?.('sandbox', { displayName: 'Sandbox' })
}

export async function activateSandboxTab(tab) {
  // Hide the model-viewer dialog if visible — sandbox lives on the
  // same canvas but with its own chrome.  Reuse the model-viewer
  // dialog so the canvas + ribbon are already mounted.
  $('#model-viewer-dialog')?.classList.remove('hidden')
  const modelViewerInstance = hostCallbacks.getActiveModelViewer?.()
  // Stop the regular ModelViewer's renderer if it's running so we
  // don't have two RAF loops fighting over the canvas.  Also silence
  // its audio so the unit editor's COB sounds don't bleed into the
  // sandbox while it owns the screen.
  if (modelViewerInstance && modelViewerInstance.renderer) {
    try { modelViewerInstance.renderer.stop?.() } catch { /* ignore */ }
  }
  if (modelViewerInstance && modelViewerInstance._mvControls
      && typeof modelViewerInstance._mvControls.setSilenced === 'function') {
    try { modelViewerInstance._mvControls.setSilenced(true) } catch { /* ignore */ }
  }
  // Stop every OTHER sandbox tab's renderer too — two sandbox tabs
  // each have their own SandboxView, and only the active one should
  // own the canvas / RAF loop.  Without this, an inactive sandbox
  // tab's renderer kept ticking + drew its scene over the canvas
  // each frame.  Clear the canvas after stopping so the new tab's
  // first paint doesn't get layered over the previous tab's frame.
  const tabs = hostCallbacks.getTabs?.() || []
  for (const t of tabs) {
    if (t === tab) continue
    const v = t.viewer
    if (v && v.renderer && v.renderer.stop) {
      try {
        v.renderer.stop()
        v.renderer.clearCanvas?.()
      } catch { /* ignore */ }
    }
  }
  // Per-tab SandboxView — each sandbox tab owns its own scene,
  // runtime, selection set, camera state, AND canvas.  Lazy-
  // constructed on first activation; reused across re-activations
  // of the SAME tab so units / camera framing survive.  The canvas
  // gets attached into the stage on activation and detached on the
  // way out so an inactive tab's GL surface is not in the DOM and
  // can't bleed through into the active tab's frame.
  const stage = document.querySelector('.model-viewer-stage')
  // Detach every OTHER tab's canvas (sandbox + unit) from the stage
  // so the incoming sandbox's canvas is the only one in the DOM
  // tree.  Both ModelViewer and SandboxView implement detach()
  // identically.  Also drop the legacy boot-time #model-viewer-canvas
  // (if still in the stage from page load) — every tab owns its own
  // per-tab canvas now and the legacy one is never re-attached.
  if (stage) {
    for (const t of tabs) {
      if (t === tab) continue
      if (t.viewer && typeof t.viewer.detach === 'function') t.viewer.detach()
    }
    const legacyCanvas = sharedModelViewerCanvas()
    if (legacyCanvas && legacyCanvas.parentNode === stage) {
      stage.removeChild(legacyCanvas)
    }
  }
  if (!tab.viewer) {
    const mod = await import('../../model3d/sandbox-view.js')
    tab.viewer = new mod.SandboxView({
      statusEl: $('#status'),
    })
  }
  if (typeof tab.viewer.attach === 'function' && stage) tab.viewer.attach(stage)
  // Swap the module-local to whichever tab is now active so the rest
  // of the studio (panels, ribbon handlers, refreshMvInspectors)
  // reads from this tab's view via getActiveSandboxView().
  _sandboxViewInstance = tab.viewer
  await _sandboxViewInstance.open()
  // Push the current Runtime-overlay slider rate into the new
  // sandbox's runtime so it starts at the user's chosen speed instead
  // of the default 1.0×.  Each sandbox tab owns its own CobRuntime,
  // so the value WOULD be reset on every tab switch / new spawn
  // without this — manifests as "projectiles still move at full
  // speed even though the slider is at 0.1×" because the slider
  // updates were only ever forwarded to the unit-editor runtime + the
  // PREVIOUSLY active sandbox.  Read the runtime's current playback
  // rate from whichever cob is alive on the unit-editor's
  // modelViewerInstance (the React Runtime panel's Speed slider
  // routes through mvSetSimulationSpeed which commits to that
  // runtime).  Falls back to 1× when no unit is open.
  try {
    const editorRate = modelViewerInstance?.cob?.runtime?.playbackRate
    mvSetSimulationSpeed(typeof editorRate === 'number' ? editorRate : 1)
  } catch { /* ignore */ }
  // Make sure the RAF loop is live — switchToTab stops it on the way
  // to a map tab so we don't burn frames behind the editor.  Renderer
  // .start() is idempotent.
  try { _sandboxViewInstance.renderer?.start?.() } catch { /* ignore */ }
  // Un-silence audio on the incoming sandbox — outgoing tab's switch
  // muted every viewer; the active one comes back un-muted so weapon
  // fire / unit acks / death sounds play normally.
  if (typeof _sandboxViewInstance.setSilenced === 'function') {
    try { _sandboxViewInstance.setSilenced(false) } catch { /* ignore */ }
  }
  // Restore the sandbox's runtime to the paused/running state it was
  // in before the user switched away.  switchToTab's
  // pauseOutgoingTabRuntime stashed the pre-switch flag on the tab;
  // a fresh sandbox (no snapshot) defaults to running — its
  // weapons/scripts/particles resume ticking exactly where they
  // stopped, instead of the engine racing ahead while the tab was
  // hidden.
  hostCallbacks.resumeIncomingTabRuntime?.(tab)
  // Wrap the sandbox view's onAfterFrame so the inspector refresh +
  // animation-advance pipeline runs on the sandbox renderer's frames
  // too.  The sandbox view sets its own onAfterFrame (scene tick +
  // entity refresh); we wrap it here to ADD the inspector tick so
  // Renderer + Runtime overlays receive their per-frame data.
  if (_sandboxViewInstance.renderer) {
    const innerHook = _sandboxViewInstance.renderer.onAfterFrame
    const refresh = hostCallbacks.refreshMvInspectors
    _sandboxViewInstance.renderer.onAfterFrame = (dtMs) => {
      if (innerHook) innerHook(dtMs)
      refresh?.(dtMs)
    }
  }
  // Hide the left sidebar (Pieces / Textures / Weapons — all
  // single-unit inspectors) by tagging the model-viewer-dialog as
  // sandbox-mode; the CSS rule collapses .sidebar in this mode so
  // the canvas expands to fill the editor width.
  const dlg = $('#model-viewer-dialog')
  if (dlg) dlg.classList.add('sandbox-mode')
  // Show the Sandbox floating panel; it offers Spawn / Move / Attack
  // / Stop buttons + a unit roster.  Lazy-created on first show via
  // the React UI island — the mount is idempotent so awaiting the
  // dynamic import on every activation is cheap (one network round-
  // trip the first time, cached + immediate after).
  await ensureSandboxPanel()
  showSandboxPanel(true)
  // Force-show the inspector panels meaningful in multi-unit mode:
  // Renderer (camera info) + Scripts (runtime telemetry) for the
  // scene as a whole; Static Vars + Controls + Effects + Audio for
  // the focused unit (these render against the currently-selected
  // sandbox unit's binding — when exactly one unit is selected the
  // refreshMvInspectors proxy promotes its binding to mv.cob, which
  // owns .particles + .audio + static vars; with zero or multiple
  // units selected the panels show an empty state).
  //
  // Hide Script Commands (per-script COB buttons — too granular for
  // a strategic view; the unit editor remains the place for that).
  // Route through setMvInspectorVisible (NOT a direct DOM class
  // toggle) so the React panel-store's visible signal flips in
  // lockstep — the Runtime panel's per-tick ThreadsBody is gated on
  // that signal and would render empty if we let the chrome go
  // visible while the signal said hidden.  `persist: false` keeps
  // the user's saved choice from being clobbered by sandbox-mode's
  // forced show.
  for (const id of ['mv-inspector-actions']) {
    setMvInspectorVisible(id, false, { persist: false })
  }
  for (const id of ['mv-inspector-camera', 'mv-inspector-scripts', 'mv-inspector-staticvars', 'mv-inspector-ports', 'mv-inspector-effects', 'mv-inspector-audio']) {
    setMvInspectorVisible(id, true, { persist: false })
  }
  // The Controls panel's action buttons (Move / Primary / Secondary /
  // Tertiary / Stop) are wired into MvControls — which operates on
  // the single-unit ModelViewer.  In sandbox we intercept those
  // clicks in the capture phase and route them through the sandbox
  // command pipeline instead, so the same Controls panel drives the
  // currently-selected sandbox unit.  Idempotent guard so repeated
  // tab activations don't stack listeners.
  wireSandboxControlsIntercept()
  // Reset the focused-unit sentinel so the next refresh tick re-runs
  // the Script Commands panel for whatever's selected (or "No COB
  // loaded" for an empty selection).
  resetSandboxFocusedUnit()
  // Controls panel body is React-managed (see /ui/panels/controls-panel.js);
  // the inspector-store mv signal already carries the active view's
  // proxy so a tab swap re-renders the panel automatically without
  // the old DOM-wipe + sentinel-reset dance.
  // Wire sandbox ribbon buttons.  Idempotent guard so repeated tab
  // switches don't stack listeners.
  wireSandboxRibbon()
  // Patch the global window aliases so refreshMvRuntimeStats +
  // refreshMvCameraPanel (both read mv.cob.runtime / mv.camera /
  // mv.renderer) see the sandbox view's runtime + camera instead of
  // the stale single-unit one.  Stashed on a separate window prop
  // so the single-unit instance state isn't trashed when the user
  // returns to a unit tab.
  if (typeof window !== 'undefined') {
    window.__sandboxView = _sandboxViewInstance
    window.__activeViewer = _sandboxViewInstance
  }
}
