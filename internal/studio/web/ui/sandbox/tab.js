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

import { $, hostCallbacks, liveStatusEl } from '../host-context.js'
import { mvSetSimulationSpeed } from '../common/sim-controls.js'
import { setMvInspectorVisible } from '../common/inspectors.js'
import { ensureSandboxPanel, showSandboxPanel } from './spawn-picker.js'
import { wireSandboxRibbon } from './ribbon-bridge.js'
import { wireSandboxControlsIntercept } from './controls-intercept.js'
import { resetSandboxFocusedUnit } from '../common/refresh-tick.js'
import {
  mountSandboxSplit,
  detachSandboxSplit,
  createSharedScene,
  ensureSplitState,
  revivePanes,
} from './split-host.js'
import { startTabTick } from '../common/tab-tick.js'
import { advanceCobLifecycle } from '../common/cob-lifecycle.js'

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

// _sandboxLabelCounter — per-page-session counter so the first Sandbox
// gets "Sandbox 1", the next "Sandbox 2", etc.  Resets on page reload.
let _sandboxLabelCounter = 0

// openSandboxStub — Sandbox welcome-card entry point.  Routes
// through the host's tab registry — openTab consults the 'sandbox'
// descriptor (registered by /ui/sandbox/register-tab.js at boot),
// builds an instance, pushes the host record, and switches focus.
// No type discriminator + no legacy `sandbox: true` flag — the
// registry handles dispatch by typeId.
export function openSandboxStub(opts = {}) {
  _sandboxLabelCounter += 1
  // opts.joinUrl (set by the welcome dialog's New Hosted / Join Hosted
  // modes) backs the tab's scene with a WsFrameSource against the
  // authoritative host; absent it the tab runs an in-process wasm
  // world (Local mode).  opts.displayName lets the hosted modes label
  // the tab after the match instead of the generic counter.
  const displayName = opts.displayName || `Sandbox ${_sandboxLabelCounter}`
  hostCallbacks.openTab?.('sandbox', { displayName, joinUrl: opts.joinUrl || null })
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
  // Stop every OTHER tab's renderers too.  Sandbox tabs since Phase 3
  // can host N panes (one renderer per pane) so we walk t.panes when
  // present and fall back to the legacy single-viewer path otherwise.
  // Without this, an inactive sandbox tab's renderers keep ticking +
  // draw their scenes over the canvas each frame.
  const tabs = hostCallbacks.getTabs?.() || []
  for (const t of tabs) {
    if (t === tab) continue
    if (t.panes && t.panes.size > 0) {
      for (const v of t.panes.values()) {
        if (v && v.renderer && v.renderer.stop) {
          try { v.renderer.stop() } catch { /* ignore */ }
          try { v.renderer.clearCanvas?.() } catch { /* ignore */ }
        }
      }
    } else {
      const v = t.viewer
      if (v && v.renderer && v.renderer.stop) {
        try { v.renderer.stop(); v.renderer.clearCanvas?.() } catch { /* ignore */ }
      }
    }
  }
  // Per-tab split mount — each sandbox tab owns its own scene,
  // runtime, selection set, split tree, and the panes that observe
  // them.  Lazy-constructed on first activation; reused across
  // re-activations of the SAME tab so units / camera framing survive.
  // The mount root gets attached into the stage on activation and
  // detached on the way out so an inactive tab's surfaces are not in
  // the DOM and can't bleed through into the active tab's frame.
  const stage = document.querySelector('.model-viewer-stage')
  // Detach every OTHER tab's canvas (sandbox split mount + unit viewer
  // canvas) from the stage so the incoming sandbox's mount is the
  // only canvas-bearing tree in the DOM.  The legacy boot-time
  // #model-viewer-canvas (if still in the stage from page load) is
  // also pulled — every tab owns its own per-tab surface now and the
  // legacy one is never re-attached.
  if (stage) {
    for (const t of tabs) {
      if (t === tab) continue
      if (t._splitMount) detachSandboxSplit(t)
      else if (t.viewer && typeof t.viewer.detach === 'function') t.viewer.detach()
    }
    const legacyCanvas = sharedModelViewerCanvas()
    if (legacyCanvas && legacyCanvas.parentNode === stage) {
      stage.removeChild(legacyCanvas)
    }
  }
  // Shared scene — one engine + smoke trails + audio debounce per tab,
  // observed by every pane the tab hosts.  Lazy-created on first
  // activation so a tab that never gets focused doesn't allocate.
  if (!tab.scene) tab.scene = createSharedScene({ palette: null, joinUrl: tab._joinUrl || null })
  // Per-tab callbacks the generic split-host invokes on top of the
  // adapter's editor-static callbacks.  onPaneFocus updates the
  // module-let alias the inspector refresh + ribbon callbacks read
  // through getActiveSandboxView; the adapter side already updates
  // tab.viewer.
  const paneCb = {
    onPaneFocus: (_tab, _leafId) => {
      const view = tab.panes.get(tab.activePaneId)
      if (view) _sandboxViewInstance = view
    },
  }
  // Seed split state + pre-create the active pane's view BEFORE
  // mountSandboxSplit renders the Preact tree.  The LeafSlot
  // useEffect that mounts the canvas runs AFTER render, so without
  // this we'd race a sync downstream read of tab.viewer against
  // the leaf's async makeLeafView.  The split-host's makeLeafView
  // (defined in the adapter in /ui/sandbox/split-host.js) constructs
  // the SandboxView against tab.scene + opens it; we hit the same
  // path manually here for the first pane so the activation can
  // complete sync wrt panel / ribbon setup.
  ensureSplitState(tab)
  if (!tab.panes.has(tab.activePaneId)) {
    const { SandboxView } = await import('./view.js')
    const v = new SandboxView({
      canvas: null,
      scene: tab.scene,
      statusEl: liveStatusEl,
    })
    await v.open()
    tab.panes.set(tab.activePaneId, v)
  }
  // Swap the module-local + legacy tab.viewer so the rest of the
  // studio reads the active pane's view.
  _sandboxViewInstance = tab.panes.get(tab.activePaneId)
  tab.viewer = _sandboxViewInstance
  // Mount the SplitContainer into the stage + render the tree.  The
  // LeafSlot effect will see the active pane's view already in panes
  // and just appendChild its canvas to the cell.  The per-tab
  // callbacks (paneCb) wrap the editor-static SANDBOX_ADAPTER so the
  // module-let active-view alias updates on pane focus.
  mountSandboxSplit(tab, stage, paneCb)
  // Defensive canvas re-attach pass — Preact's reconciliation on
  // re-render of a multi-pane tree occasionally leaves a pane's
  // canvas orphaned from its slot, which presents as a blank pane
  // with no visible content and no captured right-click.  revivePanes
  // walks tab.panes and re-attaches any canvas that's missing from
  // its current leaf cell.  Idempotent + cheap.
  revivePanes(tab)
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
  // Make sure the RAF loop is live for EVERY pane — switchToTab +
  // SandboxTabInstance.deactivate stop all of them on the way out so
  // background tabs don't burn frames behind a map editor.  Multi-pane
  // tabs need each pane's renderer restarted; before this only the
  // active pane was being woken, leaving sibling panes frozen on
  // their last frame (the canvas stays in the DOM but the RAF loop
  // is dead so nothing repaints).  Renderer.start() is idempotent.
  if (tab.panes && tab.panes.size > 0) {
    for (const v of tab.panes.values()) {
      try { v.renderer?.start?.() } catch { /* ignore */ }
    }
  } else {
    try { _sandboxViewInstance.renderer?.start?.() } catch { /* ignore */ }
  }
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
  // Tab-owned tick loop — drives scene.tick (engine.tick + smoke
  // trails) + cob-lifecycle advance (background-spawn Activate
  // auto-fire) + inspector refresh.  Pre-tab-tick this all hung off
  // the active pane's renderer.onAfterFrame, which made multi-pane
  // sandbox harder to reason about (the active pane "owned" timing)
  // and the inspector refresh was redundant work for backgrounded
  // sandbox tabs.  Moving to a tab-owned rAF makes scene.tick fire
  // once per paint frame regardless of pane count, and lets the
  // deactivate path stop it cleanly.  startTabTick is idempotent.
  startTabTick(tab, (dtMs) => {
    if (!tab.scene) return
    tab.scene.tick(dtMs)
    // COB lifecycle advance — sandbox units have no build-ramp, so
    // we pass the default 100 % build (Activate fires as soon as
    // Create's thread dies).  The shared refresh-tick only walks
    // the focused unit; non-focused background spawns need this
    // walker to flip lifecycle from 'creating' to 'created' and
    // auto-start Activate, otherwise they stay in the pre-Create
    // pose forever.
    for (const u of tab.scene.units()) {
      if (u.dead || !u.binding) continue
      advanceCobLifecycle(u.binding, u.buildPercent != null ? u.buildPercent : 100)
    }
    // Inspector refresh — only when this tab is the active sandbox
    // (a backgrounded sandbox tab keeps its sim running so units
    // animate, but its panels don't need updates the user can't see).
    if (hostCallbacks.getActiveSandboxView?.() === _sandboxViewInstance) {
      hostCallbacks.refreshMvInspectors?.(dtMs)
    }
  })
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
  for (const id of ['mv-inspector-camera', 'mv-inspector-scripts', 'mv-inspector-staticvars', 'mv-inspector-ports', 'mv-inspector-unit-ports', 'mv-inspector-effects', 'mv-inspector-projectiles', 'mv-inspector-audio']) {
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
