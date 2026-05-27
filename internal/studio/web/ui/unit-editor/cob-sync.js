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
import { mvSetSimulationSpeed } from '../common/sim-controls.js'

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

// runCobEntry invokes a script by name, randomising any required
// inputs.  AimWeapon-class scripts expect (heading, pitch) on the
// stack in TA's fixed-point angle units (65536 = 360°); we pick a
// fully random target in the unit's forward hemisphere so every
// click visibly retargets to a fresh spot.  Primary and secondary
// can run concurrently — the runtime supports independent threads
// per weapon (they signal-mask different bits so retargeting one
// weapon does NOT interrupt the other).
//
// Lifecycle + audio-side-effects:
//   - Activate gate: a freshly-built unit only responds to its own
//     Create script.  Once Create completes the Script Commands
//     panel unlocks every entry-point button.
//   - Activate / Deactivate: skip a redundant call when the unit
//     is already in the target state — re-running activatescr
//     would replay the entire opening sequence and a re-Deactivate
//     pops the unit open then closed.
//   - SoundCategory fallbacks: each lifecycle event plays the FBI
//     `activate` / `deactivate` event when present, falling back to
//     `select*` / `build` / `unitcomplete` so the user always hears
//     SOMETHING when they command an open / yard-up.
//   - Aim* scripts: kill stale RestoreAfterDelay threads so the
//     latest aim gets its full reload timer, then push (heading,
//     pitch) onto the new thread.  Pitch is biased to "look at a
//     same-altitude target ≥10× the unit's bbox away" so the gun
//     doesn't tip down through the unit's own hull.
export function runCobEntry(cob, name) {
  if (!cob || !cob.hasScript(name)) return
  // Don't re-start a script that already has a thread alive.  The
  // first line of activatescr-style helpers is usually
  // `turn <piece> to <axis> <0> now` which INSTANTLY snaps the
  // piece back to origin before animating to the open position —
  // re-triggering caused a visible jerk while pieces were already
  // at their target.  For long-running loops (SmokeUnit, MotionControl)
  // this also prevents stacking N threads from N clicks.
  if (isCobScriptRunning(cob, name)) return
  // Create-only gate: while the unit hasn't finished its Create
  // script (state 'unborn' = never started, 'creating' = Create
  // thread is mid-flight), suppress every other action.  Real TA
  // does the same — a freshly-built unit only responds to its own
  // initialisation script.
  const lifecycle = cob._lifecycle || 'created'
  if ((lifecycle === 'unborn' || lifecycle === 'creating') && !/^Create$/i.test(name)) return
  // Starting Create flips the lifecycle into 'creating' so the
  // other buttons stay disabled while the script runs.
  if (/^Create$/i.test(name)) cob._lifecycle = 'creating'
  const mvControls = hostCallbacks.getActiveMvControls?.()
  if (/^Activate$/i.test(name)) {
    if (cob._lifecycle === 'activated') return
    cob._lifecycle = 'activated'
    if (cob.hasScript('activatescr') && !isCobScriptRunning(cob, 'activatescr')) cob.start('activatescr')
    if (cob.hasScript('OpenYard') && !isCobScriptRunning(cob, 'OpenYard')) cob.start('OpenYard')
    mvControls?._playSoundRandom?.(['activate', 'select1', 'select2', 'select3', 'build', 'unitcomplete'])
  }
  if (/^Deactivate$/i.test(name)) {
    if (cob._lifecycle === 'deactivated') return
    cob._lifecycle = 'deactivated'
    if (cob.hasScript('deactivatescr') && !isCobScriptRunning(cob, 'deactivatescr')) cob.start('deactivatescr')
    if (cob.hasScript('CloseYard') && !isCobScriptRunning(cob, 'CloseYard')) cob.start('CloseYard')
    // Same fallback chain as Activate, biased toward the second
    // acknowledge voice so Activate / Deactivate sound distinct
    // even when both fall back to the select bank.
    mvControls?._playSoundRandom?.(['deactivate', 'select2', 'select3', 'select1', 'cant1'])
  }
  // Create script kicks the unit "online" — play the select voice
  // so the user hears the unit acknowledge itself when they bring
  // it to life.  Skipped when the unit has no Create.
  if (/^Create$/i.test(name)) {
    mvControls?._playSoundRandom?.(['select1', 'select2', 'select3', 'unitcomplete'])
  }
  if (/^Aim(Primary|Secondary|Tertiary|Weapon\d+)$/i.test(name)) {
    cob.unit.killThreadsByName('RestoreAfterDelay')
    cob.unit.killThreadsByName('RestorePosition')
    // Independent random heading per click - no per-weapon bias.
    // Forward hemisphere only (±90°): aiming behind a unit clips
    // through the body on most TA models and looks broken.
    const TURNS = 65536
    const heading = Math.floor((Math.random() - 0.5) * TURNS * 0.5)
    const mv = hostCallbacks.getActiveModelViewer?.()
    const m = mv?.model
    let pitch = 0
    if (m && m.bounds && m.bounds.min && m.bounds.max) {
      const ext = [
        m.bounds.max[0] - m.bounds.min[0],
        m.bounds.max[1] - m.bounds.min[1],
        m.bounds.max[2] - m.bounds.min[2],
      ]
      // Unit size = largest horizontal extent; height feeds the
      // turret-mount offset, not the distance, so the aim line
      // stays roughly flat regardless of how tall the unit is.
      const unitSize = Math.max(ext[0], ext[2]) || ext[1] || 1
      const distance = 10 * unitSize
      const turretY = m.bounds.max[1]
      const targetY = (m.bounds.min[1] + m.bounds.max[1]) * 0.5
      const dy = targetY - turretY // negative → looking down
      const pitchRad = Math.atan2(dy, distance)
      pitch = Math.round(pitchRad * TURNS / (2 * Math.PI))
    }
    cob.start(name, [heading, pitch])
    return
  }
  cob.start(name)
}
