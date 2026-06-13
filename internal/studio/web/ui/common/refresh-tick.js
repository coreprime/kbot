// refresh-tick.js
//
// Per-frame inspector tick — drives every floating-panel + debugger
// repaint at a steady 4 Hz cadence, no matter how fast the model
// renderer's RAF is firing.  Called from the renderer's onAfterFrame
// hook in both the unit-editor's ModelViewer (tab.js) and the
// sandbox's SandboxView (activateSandboxTab wraps the sandbox's own
// hook so the same refresh runs over there too).
//
// What the tick does:
//   1. Pick the data source — sandbox view if a sandbox tab is
//      active, otherwise the single-unit ModelViewer.  Both view
//      classes expose getInspectorMv() returning the same shape:
//      { camera, renderer, cob, ... } (or null if nothing is loaded
//      yet).
//   2. Update the sandbox Controls-panel button enable map based on
//      what the selected units' COBs can do (intersection-of-
//      capabilities semantics when multi-selected).
//   3. Publish the freshly-computed proxy + sandbox flags to the
//      React inspector-store so every signal-subscribed panel
//      (Static Vars, Audio, Effects, Renderer, RuntimePanel, …)
//      re-renders with the latest data.
//   4. Repaint the Weapons-tab live bits (reload bars + recent-
//      projectiles list).
//   5. Promote 'creating' → 'created' once the Create thread has
//      died (host-callback into studio.js).
//   6. Push the runtime's running-scripts set + lifecycle into the
//      React COB-ribbon's signal (host-callback).
//   7. Iterate every open debugger panel and re-paint its PC
//      highlight + bracket overlay.
//
// Throttled to 4 Hz (one publish every 250 ms) so an auto-rotating
// camera doesn't burn DOM ops on every animation frame — anything
// that needs faster updates (PC highlight during stepping) calls
// the relevant refresh function directly instead.

import { hostCallbacks, getReactUi } from '../host-context.js'
import { activeGame } from './game-registry.js'

// Per-tick subscribers registered by section-specific code (e.g. the
// unit-editor's debugger).  refresh-tick lives in /ui/common/ so it
// must not reach down into a particular section's code — instead
// sections call subscribeTick(fn) at module-load and refresh-tick
// fans the per-tick mv proxy out to every subscriber after publishing
// inspector-store state.  Exceptions in any one subscriber are
// swallowed so a broken section doesn't take down the rest of the
// inspector refresh.
const _tickListeners = new Set()

// subscribeTick registers a per-tick handler.  Fires at ~4 Hz with the
// current inspector mv proxy + dtMs since the last publish.  Returns
// an unsubscribe function so callers can detach on teardown.
export function subscribeTick(fn) {
  if (typeof fn !== 'function') return () => {}
  _tickListeners.add(fn)
  return () => _tickListeners.delete(fn)
}

// Cumulative dt since the last publish (in ms).  Cleared on every
// publish so the next publish is exactly 250 ms later.
let _mvInspectorThrottleMs = 0

// Sandbox-only sentinel — tracks which unit's Script Commands panel
// is currently rendered.  refreshMvInspectors rebuilds the panel only
// when this changes so the per-tick refresh doesn't flicker the
// button list mid-hover.  null = no unit focused (zero or multi-
// select; the panel shows "No COB loaded.").
let _mvSandboxFocusedUnitId = -1

// resetSandboxFocusedUnit — invalidates the focused-unit sentinel so
// the next refresh tick rebuilds the per-unit panels.  Called from
// activateSandboxTab so a tab swap forces a re-publish even when the
// previously-focused id happens to match the new selection.
export function resetSandboxFocusedUnit() {
  _mvSandboxFocusedUnitId = -1
}

// refreshMvInspectors is called from the model renderer's draw loop
// each frame.  Cheap when nothing is visible — checks each panel's
// hidden flag and bails early.  Throttled to 4 Hz so an
// auto-rotating camera doesn't burn DOM ops every animation tick.
export function refreshMvInspectors(dtMs = 16) {
  _mvInspectorThrottleMs += dtMs
  if (_mvInspectorThrottleMs < 250) return
  _mvInspectorThrottleMs = 0
  // Pick the viewer to source inspector data from — when a sandbox
  // tab is active we want the sandbox view's camera + runtime, not
  // the (possibly stale) single-unit viewer.  Both view classes
  // expose .camera, .renderer, and a .cob-like surface, so the
  // existing panel renderers don't have to know which kind it is.
  // Read through hostCallbacks so this file holds no awareness of
  // where the sandbox view lives — the sandbox section registers
  // the getter at boot.
  const sandbox = hostCallbacks.getActiveSandboxView?.() || null
  const sandboxActive = sandbox && document.getElementById('model-viewer-dialog')?.classList?.contains('sandbox-mode')
  // Build the proxy mv.  When exactly ONE unit is selected in
  // sandbox we promote its CobBinding to mv.cob — the single-unit
  // inspector renderers (Actions / Static Vars / Threads) then
  // populate against the selected unit, mirroring the experience in
  // the Unit Editor.  With zero or multiple units selected we fall
  // back to the runtime-only proxy so the runtime / runtime-list
  // panels still tick but the per-unit panels show "select a unit".
  // mv proxy comes from view.getInspectorMv() now — viewer and
  // sandbox each implement the method against the shared view
  // contract and return the shape the inspector panel renderers
  // below consume.  This
  // collapses what used to be a ~50-line sandbox-vs-viewer branch
  // here into one method call, and pushes the "aggregate scene
  // particles", "synthesise stub cob when 0/multi selected", and
  // "lifecycle backfill" responsibilities home to the views.
  const activeMv = hostCallbacks.getActiveModelViewer?.()
  let mv = sandboxActive
    ? (sandbox && typeof sandbox.getInspectorMv === 'function' ? sandbox.getInspectorMv() : null)
    : (activeMv && typeof activeMv.getInspectorMv === 'function'
        ? activeMv.getInspectorMv()
        : activeMv)
  if (sandboxActive) {
    // Pull focused-unit id back out so the Actions-panel rebuild
    // gating + the Controls button enable map below can read it.
    // The view stashed it on mv._focusedUnitId.
    const focusedId = mv && mv._focusedUnitId != null ? mv._focusedUnitId : null
    // Focused-unit sentinel — kept here so other per-tick code that
    // wants to know "did the selection change this tick?" can read
    // it off _mvSandboxFocusedUnitId.  The Script Commands panel
    // itself now re-renders off the inspector-store mv signal
    // published below (no imperative render here).
    if (focusedId !== _mvSandboxFocusedUnitId) {
      _mvSandboxFocusedUnitId = focusedId
    }
    // Enable the Controls panel's action buttons based on what the
    // selection as a whole supports.  Single-unit selection mirrors
    // the unit-editor's MvControls _refreshButtons logic.  Multi-
    // unit selection takes the INTERSECTION of capabilities — a
    // button only enables when EVERY selected unit's COB carries the
    // matching Aim* / Fire* / Query* scripts, so a Move-and-Primary
    // selection that includes a unit without Tertiary will grey out
    // Tertiary.  Move + Stop are always enabled when there's at
    // least one selected unit (anything that walked into the
    // selection set is moveable / stoppable by definition).
    const selectedUnits = (sandbox && typeof sandbox.getSelectedUnits === 'function')
      ? sandbox.getSelectedUnits().filter((u) => u && u.binding)
      : []
    // COB now runs inside the wasm engine, so the render-side binding's
    // hasScript() is inert (always false). Drive the weapon-slot enable
    // off the unit's FBI weapon declaration — a slot lights up when every
    // selected unit declares a weapon there — and keep the legacy COB
    // script probe as a fallback for any in-process JS binding.
    const slotHasWeapon = (u, idx) => {
      const w = u.meta && u.meta.weapons && u.meta.weapons[idx]
      return !!(w && w.name)
    }
    const everySlot = (idx, names) => selectedUnits.length > 0
      && selectedUnits.every((u) => slotHasWeapon(u, idx)
        || (u.binding.hasScript && names.some((n) => u.binding.hasScript(n))))
    // The game adapter owns which script names mark a slot drivable —
    // TA's per-slot Aim/Fire/Query triples, plus TA:K's shared
    // AimWeapon/FireWeapon/QueryWeapon set (the FBI weapon declaration is
    // what distinguishes the slots there).
    const weapons = activeGame().weapons
    const ctrlEnabled = {
      move: selectedUnits.length > 0,
      primary:   everySlot(0, weapons.slotScripts(0)),
      secondary: everySlot(1, weapons.slotScripts(1)),
      tertiary:  everySlot(2, weapons.slotScripts(2)),
    }
    for (const btn of document.querySelectorAll('#mv-controls-actions .mv-ctrl-action')) {
      const action = btn.dataset.ctrlAction
      if (action === 'stop' || action === 'reset') continue
      btn.disabled = !ctrlEnabled[action]
    }
  }
  // The mv-dependent publishes only run when a unit is actually
  // focused.  The subscriber fan-out below, however, must run on EVERY
  // tick even when mv is null — subscribers like the sandbox roster
  // strip react to the selection going EMPTY (hide themselves), and an
  // early return here would freeze them visible after a deselect.
  if (mv) {
    // Publish the freshly-computed proxy + sandbox flags to the React
    // inspector store.  Every migrated panel (Static Vars, Audio) is
    // subscribed to these signals via @preact/signals and re-renders
    // automatically when its inputs change.  Skipping the per-panel
    // imperative renderMvXxxPanel call below for migrated panels is
    // intentional — the React tree owns those bodies now.
    const ui = getReactUi()
    if (ui && typeof ui.publishInspectorState === 'function') {
      const selSize = (sandbox && sandbox.scene && sandbox.scene.selected)
        ? sandbox.scene.selected.size
        : 0
      ui.publishInspectorState({ mv, sandboxActive: !!sandboxActive, sandboxSelSize: selSize })
    }
    // Per-tick lifecycle advancement for the focused unit — promotes
    // 'creating' → 'created' when the Create thread has died and auto-
    // fires Activate once build% reaches 100.  Takes mv (not mv.cob) so
    // the advance can read the build-percent gate on the auto-Activate
    // transition.  The sandbox additionally walks ALL its units in its
    // own onAfterFrame hook so non-focused units lifecycle-advance too.
    hostCallbacks.syncMvActionsRunning?.(mv)
    hostCallbacks.syncCobRibbonRunning?.(mv.cob)
  }
  // Section-specific tick consumers (e.g. unit-editor's debugger
  // panels, the sandbox roster strip) get their turn now.  Each
  // subscriber receives the current mv proxy (possibly null) + the dt
  // since the last publish and is responsible for its own DOM scope.
  // Errors are swallowed so one broken consumer doesn't strand the rest.
  for (const fn of _tickListeners) {
    try { fn(mv, 250) } catch (e) { /* per-subscriber failures are non-fatal */ void e }
  }
}
