// runtime.js
//
// Per-unit "boot" helpers that run after a model + COB lands in a
// unit-editor tab: pushing persisted Studio Options defaults through
// the renderer, choosing the right ground mode from the FBI metadata,
// fetching the FBI movement + weapon refs from the server, and
// running the 5-second visual auto-build ramp that phases the
// construction-stripe wireframe out into the finished model.
//
// What lives here:
//
//   - applyUnitEditorDefaults() — pushes state.settings.unitDefault*
//     through the active viewer's renderer + into the React ribbon's
//     state signal
//   - applyDefaultGroundFor(meta) — sets ground/submersion mode from
//     the FBI's defaultGround + submersionMode; bumps camera target
//     Y when the unit was lifted off the seabed; re-pitches the
//     camera for submerged units so the eye sits under the water
//   - mvFetchUnitMeta(mv) — GET /api/studio/unit/{name} and stash
//     the result on mv.unitMeta; nudges MvControls + repaints the
//     Weapons tab
//   - startMvAutoBuild(mv) — kicks off the visual build ramp
//   - advanceMvAutoBuild(dtMs) — per-frame ramp advance, called
//     from the renderer's onAfterFrame hook
//
// Cross-module deps come through host-context (state + hostCallbacks
// for the active viewer + active MvControls + the Ports-panel slider
// sync that still lives studio-side) and through the existing
// sidebar.js (renderMvWeaponsTab fires the Weapons-tab repaint after
// the FBI fetch lands).

import { state, hostCallbacks, getReactUi } from '../host-context.js'
import { DEFAULT_SETTINGS } from '../dialogs/settings.js'
import { renderMvWeaponsTab } from './sidebar.js'

// AUTO_BUILD_DURATION_MS — total sim-time for the wireframe → finished
// model ramp.  Five seconds was the sweet spot in user testing: long
// enough to read as a deliberate build animation, short enough that
// the user isn't waiting on it to start commanding the unit.
const AUTO_BUILD_DURATION_MS = 5000

// applyUnitEditorDefaults pushes settings.unitDefault* through the
// renderer's setters + into the React ribbon's state signal so the
// Studio Options dropdown's check-marks + Environment chip reflect
// the freshly-applied defaults.
export function applyUnitEditorDefaults() {
  const mv = hostCallbacks.getActiveModelViewer?.()
  if (!mv?.renderer) return
  const s = state.settings || DEFAULT_SETTINGS
  const r = mv.renderer
  const env = s.unitDefaultEnv || 'greenworld'
  const reflections = s.unitDefaultReflections !== false
  const bob = s.unitDefaultBob !== false
  const waterReflections = s.unitDefaultWaterReflections !== false
  const specular = s.unitDefaultSpecular !== false
  const godbeams = s.unitDefaultGodBeams !== false
  // Environment first because it swaps the sky scheme; the toggles
  // below operate on flags the env doesn't touch.
  r.setEnvironment(env)
  r.setReflectionsEnabled(reflections)
  r.setBobEnabled(bob)
  r.setWaterReflectionsEnabled(waterReflections)
  r.setSpecularEnabled(specular)
  r.setGodBeamsEnabled(godbeams)
  const ui = getReactUi()
  if (ui && typeof ui.setModelViewerRibbonState === 'function') {
    ui.setModelViewerRibbonState({
      env, reflections, bob, waterReflections, specular, godbeams,
    })
  }
}

// mvFetchUnitMeta loads the FBI movement + weapon refs for the
// currently-loaded model and pushes the result onto the viewer +
// the Controls overlay.  Fire-and-forget — failure leaves the
// action buttons disabled (no metadata = "we don't know what the
// unit can do" = safe default).
export async function mvFetchUnitMeta(mv) {
  if (!mv?.model) return
  mv.unitMeta = null
  // The model name comes from the COB unit (set by model-viewer.js
  // open() to the originally-requested model name).  Without a COB
  // the unit isn't a real unit anyway — props/features have no
  // FBI metadata.
  const name = mv.cob?.unit?.name
  if (!name) return
  try {
    const resp = await fetch(`/api/studio/unit/${encodeURIComponent(name)}`)
    if (!resp.ok) return
    mv.unitMeta = await resp.json()
    const ctrls = hostCallbacks.getActiveMvControls?.()
    if (ctrls) ctrls.onMetaLoaded()
    // Controls/Ports panel re-renders off the inspector-store
    // signals; once unitMeta is set the next publish updates the
    // panel's per-port visibility (canMove, isBuilder, onoffable
    // gating) automatically — no imperative call needed.
    // Populate the left-panel Weapons tab now that the FBI + weapon
    // TDF data is in.  Empty-state shows "No weapons declared" for
    // structures / props.  Passed the whole viewer so the renderer
    // can read scriptNames + wire change-weapon / sound-play actions.
    renderMvWeaponsTab(mv)
  } catch (err) {
    console.warn(`[unit-meta:${name}] fetch failed:`, err)
  }
}

// applyDefaultGroundFor sets the ground mode based on the unit's
// FBI metadata.  Ships / subs get "sea"; every other unit falls back
// to "terrain" so opening a kbot after a sub doesn't leave it
// floating on water from the previous tab's choice.
export function applyDefaultGroundFor(meta) {
  const mv = hostCallbacks.getActiveModelViewer?.()
  if (!mv?.renderer) return
  const want = meta?.defaultGround || 'terrain'
  // Submersion comes from the FBI's TEDClass / Category / WaterLine
  // (computed server-side in inferSubmersionMode).  Surface ships
  // ride the boot-stripe; subs end up under the water; everything
  // else sits on top.
  mv.renderer.setSubmersionMode(meta?.submersionMode || '')
  mv.renderer.setGroundMode(want)
  // Sub units are lifted UP off the seabed via a model-matrix Y
  // translation; the camera was framed in open() against the
  // un-translated bounds, so without this adjustment the camera
  // target stays at the original centroid (well below the lifted
  // unit).  Bump target Y by the same offset so the camera keeps
  // looking at where the unit is actually rendered.
  const yOff = mv.renderer.getUnitYOffset?.() || 0
  if (yOff !== 0 && mv.camera) {
    mv.camera.target[1] += yOff
    mv.renderer.requestRedraw()
  }
  // Submerged units need the camera eye to sit BELOW the water
  // plane, otherwise the renderer paints the surface from above
  // and the sub itself disappears under the waves.  open() set
  // pitch=18 deg / distance×1.25 unconditionally — for subs we
  // recompute pitch so eye.y lands a few units under uWaterY.
  //   eye.y = target.y + distance · sin(pitch)
  // Solve for pitch given a target eye.y of (waterY - margin).
  if (meta?.submersionMode === 'submerged' && mv.camera) {
    const cam = mv.camera
    const r = mv.renderer
    const waterY = r._getWaterY ? r._getWaterY() : 0
    const margin = 6 // eye sits this far under the surface
    const desiredEyeY = waterY - margin
    const dy = desiredEyeY - cam.target[1]
    const dist = Math.max(1, cam.distance || 1)
    // Clamp the sine to [-1, 0.05] so we always land at or just
    // below horizontal even if the math says the eye should rise.
    const sinP = Math.max(-1, Math.min(0.05, dy / dist))
    cam.pitch = Math.asin(sinP)
    r.requestRedraw()
  }
  // Sync the React Scene/Ground dropdown's selection chip so the
  // closed dropdown shows what's actually applied (ship default sets
  // Sea programmatically; the user never clicked the row so the
  // signal wouldn't otherwise update).
  const ui = getReactUi()
  if (ui && typeof ui.setModelViewerRibbonState === 'function') {
    ui.setModelViewerRibbonState({ ground: want })
  }
}

// startMvAutoBuild kicks off the 5-second wireframe → finished-model
// ramp.  Snaps build% to 0 so the construction stripes are visible
// at frame one; state lives on the viewer (mv._autoBuild) so a tab
// swap to a fresh unit naturally re-arms the ramp and setting it to
// null cancels.
export function startMvAutoBuild(mv) {
  if (!mv) return
  // Snap to 0% so the ramp begins from the construction-stripe
  // wireframe and phases the unit in.
  if (typeof mv.setBuildPercent === 'function') mv.setBuildPercent(0)
  else mv.cobBuildPercent = 0
  mv._autoBuild = { elapsedMs: 0, durationMs: AUTO_BUILD_DURATION_MS }
}

// advanceMvAutoBuild — per-frame ramp advance, called from the
// renderer's onAfterFrame hook.  Uses SIM time (dtMs scaled by the
// runtime's playbackRate) so pause + slow-mo both apply, matching
// every other timing in the studio.
export function advanceMvAutoBuild(dtMs) {
  const mv = hostCallbacks.getActiveModelViewer?.()
  if (!mv || !mv._autoBuild) return
  const rate = mv.cob?.runtime?.playbackRate ?? 1
  const dtSim = Math.max(0, dtMs) * rate
  const buildState = mv._autoBuild
  buildState.elapsedMs += dtSim
  const pct = Math.max(0, Math.min(100, (buildState.elapsedMs / buildState.durationMs) * 100))
  if (typeof mv.setBuildPercent === 'function') mv.setBuildPercent(pct)
  else mv.cobBuildPercent = pct
  // Keep the React ribbon's Damage + Build sliders + the Ports panel
  // in sync as the ramp advances so the user can watch the percentage
  // tick up rather than only seeing the visual wireframe phase in.
  // Both surfaces read off mv.cobBuildPercent so a single push covers
  // them (the Ports panel re-renders off the inspector-store mv signal
  // each publish).  mvSyncCobAttrSlidersFromPorts still lives in
  // studio.js — it pushes the values into the React ribbon's state
  // signal + is also called from the Ports panel's slider handlers,
  // so we reach it through hostCallbacks.
  hostCallbacks.mvSyncCobAttrSlidersFromPorts?.(mv)
  if (buildState.elapsedMs >= buildState.durationMs) {
    mv._autoBuild = null  // ramp complete — release the slot
  }
}
