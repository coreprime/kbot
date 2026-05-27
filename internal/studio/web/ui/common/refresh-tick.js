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
// Residual peer imports into the unit editor — the per-frame tick
// still calls into unit-editor-specific sidebar refreshes (Weapons
// reload bars + piece-tree eyes) and the thread-debugger overlay.
// Phase B follow-up: invert these into an event subscription so
// refresh-tick fires a generic "tick" signal and the unit editor
// listens; that would let map / sandbox tabs use refresh-tick
// without dragging the debugger + sidebar along.
import { refreshMvWeaponsLive, refreshPieceTreeEyes } from '../unit-editor/sidebar.js'
import {
  refreshMvThreadCodeHighlight,
  redrawMvThreadCodeBrackets,
} from '../unit-editor/debugger/asm.js'
import { _mvThreadCodePanels } from '../unit-editor/debugger/modal.js'

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
  const sandbox = (typeof window !== 'undefined') ? window.__sandboxView : null
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
      ? sandbox.getSelectedUnits().filter((u) => u && u.binding && u.binding.hasScript)
      : []
    const everyHasAny = (names) => selectedUnits.length > 0
      && selectedUnits.every((u) => names.some((n) => u.binding.hasScript(n)))
    const ctrlEnabled = {
      move: selectedUnits.length > 0,
      primary:   everyHasAny(['AimPrimary',   'FirePrimary',   'QueryPrimary']),
      secondary: everyHasAny(['AimSecondary', 'FireSecondary', 'QuerySecondary']),
      tertiary:  everyHasAny(['AimTertiary',  'FireTertiary',  'QueryTertiary']),
    }
    for (const btn of document.querySelectorAll('#mv-controls-actions .mv-ctrl-action')) {
      const action = btn.dataset.ctrlAction
      if (action === 'stop' || action === 'reset') continue
      btn.disabled = !ctrlEnabled[action]
    }
  }
  if (!mv) return
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
  // Weapons-tab live bits — reload bars + recent-projectiles lists.
  // Cheap: the panel is in the left sidebar (not an inspector), so
  // we don't gate on hidden-class.  Each card's __mvLiveRefresh
  // closure no-ops when the card has no reload bar / projlist.
  refreshMvWeaponsLive(mv)
  // Promote 'creating' → 'created' once the Create thread has died.
  // The React Controls + Script Commands panels read cob._lifecycle
  // and render the right gated state next refresh, so this is the
  // only imperative bit the host still needs to do.  The ribbon's
  // COB section is still vanilla and gates its own button rows.
  hostCallbacks.syncMvActionsRunning?.(mv.cob)
  hostCallbacks.syncCobRibbonRunning?.(mv.cob)
  // Piece-tree status icons (eye / shade / cache / shadow) — mirror
  // the live COB-driven per-piece state.  Cheap query-and-toggle
  // per row so a Create-script hide / dont-shade lights up in the
  // tree the same tick the opcode runs.
  refreshPieceTreeEyes()
  // Thread code-view modals — refresh every open debugger panel.
  // Each panel tracks its own thread, hover state, and DOM scope so
  // multiple debuggers can run side-by-side.
  for (const state of _mvThreadCodePanels.values()) {
    refreshMvThreadCodeHighlight(state)
    redrawMvThreadCodeBrackets(state)
    _refreshCoverageDim(state)
  }
}

// _refreshCoverageDim — strip the .mv-code-unexecuted class from any
// asm line whose offset has been executed since the debugger opened.
// Cheap: only touches the lines we previously dimmed (querySelectorAll
// over `.mv-code-unexecuted` is bounded by the unexecuted set, which
// shrinks toward zero as the script's hot paths run).  When a
// previously-dormant function (walk, FireWeapon1, ...) finally gets
// called, its lines brighten on the next 4 Hz tick so the user can
// see at a glance "this code is reachable now."
function _refreshCoverageDim(state) {
  const panel = state.panel
  if (!panel) return
  const cov = state.cob?.unit?._executedOffsets
  if (!cov || cov.size === 0) return
  // Asm pane — strip the dim class from any line whose offset got
  // stamped since the last sweep.
  const dimAsm = panel.querySelectorAll('.mv-thread-code-source .mv-code-line.mv-code-unexecuted')
  for (const line of dimAsm) {
    const scr = line.dataset.script
    const off = parseInt(line.dataset.offset, 10)
    if (!scr || !Number.isFinite(off)) continue
    const s = cov.get(scr)
    if (s && s.has(off >>> 0)) line.classList.remove('mv-code-unexecuted')
  }
  // BOS pane — same pass against the (script, startOffset) pair the
  // BOS renderer stamped on each mapped row.  Unmapped rows have no
  // dataset.bosScript so the loop skips them silently.
  const dimBos = panel.querySelectorAll('.mv-thread-code-decompiled > div.bos-unexecuted')
  for (const line of dimBos) {
    const scr = line.dataset.bosScript
    const off = parseInt(line.dataset.bosOffset, 10)
    if (!scr || !Number.isFinite(off)) continue
    const s = cov.get(scr)
    if (s && s.has(off >>> 0)) line.classList.remove('bos-unexecuted')
  }
}
