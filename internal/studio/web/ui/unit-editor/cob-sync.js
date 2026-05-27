// cob-sync.js
//
// Per-tick sync helpers that push COB state into the React UI.  The
// React Script Commands panel + COB-dropdown ribbon row both read
// from signals on the inspector store; these helpers are the
// publishers that keep those signals fresh as threads start / die
// and lifecycle phases progress.
//
// What lives here:
//
//   - mvSyncCobAttrSlidersFromPorts(mv) — push the unit's current
//     damage + build% into the React ribbon's CobDropdown signal
//     so the sliders reflect live state without a manual readback.
//   - syncMvActionsRunning(cob) — Promote `creating` → `created`
//     once the Create thread has died.  The React Script Commands
//     panel reads cob._lifecycle every tick so this transition
//     unlocks the rest of the button bank without an explicit
//     re-render.
//   - syncCobRibbonRunning(cob) — push the live running-scripts
//     Set + lifecycle into the React COB dropdown.  Entry buttons
//     flip between disabled / enabled the instant a thread starts
//     or dies because each row subscribes to that Set.
//   - _collectRunningCobScripts(cob) — Set of lower-cased script
//     names with at least one live thread.  Shared between the
//     per-tick syncCobRibbonRunning fire and refreshCobPanel's
//     full re-publish so the two paths can't drift apart on what
//     counts as "running".
//   - refreshCobPanel(cob) — full reset of the React COB-dropdown
//     state.  Called from tab.js after a unit loads so the panel
//     re-mounts with the right script list + lifecycle + playback
//     rate.  Routes the playback rate through mvSetSimulationSpeed
//     so the Runtime panel + sandbox runtime all stay in lockstep.
//   - isCobScriptRunning(cob, name) — case-insensitive "is this
//     script currently executing a thread?" check.  Used by
//     runCobEntry to no-op a re-click and by the panel renderers
//     to grey out the matching button.
//
// External callers route through `hostCallbacks` (the refresh tick
// in /ui/unit-editor/refresh-tick.js, runtime.js, tab.js); the
// host registrations live in studio.js so the API surface is the
// same as before this extraction.

import { hostCallbacks, getReactUi } from '../host-context.js'
import { mvSetSimulationSpeed } from './sim-controls.js'

// mvSyncCobAttrSlidersFromPorts copies cobDamage / cobBuildPercent
// off the ModelViewer proxy onto the React COB ribbon's slider
// state.  Called every 4 Hz from the inspector refresh tick so the
// sliders stay in sync with whatever the runtime mutated.
export function mvSyncCobAttrSlidersFromPorts(mv) {
  if (!mv) return
  const ui = getReactUi()
  if (ui && typeof ui.setModelViewerRibbonState === 'function') {
    ui.setModelViewerRibbonState({
      cobDamage: mv.cobDamage | 0,
      cobBuild: mv.cobBuildPercent | 0,
    })
  }
}

export function syncMvActionsRunning(cob) {
  if (!cob) return
  // Promote 'creating' → 'created' once the Create thread has died.
  // The React Script Commands panel reads cob._lifecycle every tick
  // so this promotion takes effect on the next publish without an
  // explicit re-render call.
  if (cob._lifecycle === 'creating' && !isCobScriptRunning(cob, 'Create')) {
    cob._lifecycle = 'created'
  }
}

export function syncCobRibbonRunning(cob) {
  if (!cob) return
  const ui = getReactUi()
  if (!ui || typeof ui.setModelViewerCobState !== 'function') return
  // Push the live running-scripts set + lifecycle into the React COB
  // dropdown's signal so the entry buttons + "All scripts" rows flip
  // between disabled / enabled the instant a thread starts or dies.
  // Lower-cased keys mirror the runtime's case-insensitive lookup so
  // the React side can check `runningScripts.has(name.toLowerCase())`.
  ui.setModelViewerCobState({
    runningScripts: _collectRunningCobScripts(cob),
    lifecycle: cob._lifecycle || 'created',
  })
}

// _collectRunningCobScripts — Set of lower-cased script names that
// currently have at least one live thread.  Shared between the
// per-tick syncCobRibbonRunning fire and refreshCobPanel's per-unit
// reset; centralising avoids two slightly-different walkers drifting
// apart on what counts as "running."
export function _collectRunningCobScripts(cob) {
  const set = new Set()
  if (cob && cob.unit && cob.unit._threads) {
    for (const t of cob.unit._threads) {
      if (!t.dead) set.add(t.script.name.toLowerCase())
    }
  }
  return set
}

// refreshCobPanel publishes the WHOLE COB-dropdown state for a freshly-
// loaded unit: script list, running set, lifecycle, current playback
// rate.  Called from tab.js' activateModelTab path after the unit's
// COB lands so the ribbon's COB menu reflects the new unit's scripts.
// Pushes the playback rate through mvSetSimulationSpeed so the Runtime
// panel + the sandbox runtime + the React COB slider all land on the
// same value (single entry point keeps them in lockstep).
export function refreshCobPanel(cob) {
  mvSetSimulationSpeed(cob ? cob.runtime.playbackRate : 1)
  const ui = getReactUi()
  if (ui && typeof ui.setModelViewerRibbonState === 'function') {
    const mv = hostCallbacks.getActiveModelViewer?.()
    ui.setModelViewerRibbonState({
      cobDamage: mv?.cobDamage || 0,
      cobBuild: mv?.cobBuildPercent ?? 100,
    })
  }
  if (ui && typeof ui.setModelViewerCobState === 'function') {
    ui.setModelViewerCobState({
      hasCob: !!cob,
      scriptNames: cob ? cob.listScripts() : [],
      runningScripts: _collectRunningCobScripts(cob),
      lifecycle: cob?._lifecycle || 'created',
    })
  }
}

// isCobScriptRunning reports whether the named script has at least
// one live thread.  Case-insensitive, matches the runtime's own
// script lookup semantics.  Used by runCobEntry to no-op a click
// on a script that's already executing, and by refreshCobPanel +
// the Script Commands panel to grey out the corresponding buttons.
export function isCobScriptRunning(cob, name) {
  if (!cob || !cob.unit) return false
  const lower = name.toLowerCase()
  for (const t of cob.unit._threads) {
    if (!t.dead && t.script.name.toLowerCase() === lower) return true
  }
  return false
}
