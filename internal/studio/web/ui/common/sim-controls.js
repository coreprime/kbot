// sim-controls.js
//
// Sim-clock controls for the unit editor + sandbox runtimes —
// Pause toggle, sim-speed slider, background-tab auto-pause, and
// the `window.*` hotkey-friendly aliases the keyboard handler in
// mv-controls.js reaches for.  These were the last unit-editor
// concerns left in studio.js after R43h.
//
// _activeRuntime dispatches by which dialog mode the user is in:
// sandbox tab → that tab's engine runtime; otherwise the single-unit
// model viewer's runtime.  Returns null when neither is live (boot
// races), so every caller is null-safe by default.
//
// mvSetSimulationSpeed is the single entry point for changing the
// playback rate — both the COB-menu Playback slider and the Runtime
// overlay's Speed slider call it.  Pushes the rate to BOTH the
// unit-editor runtime (mv.cob.runtime) and the active sandbox
// runtime (sandbox view's scene.runtime, reached through the
// hostCallbacks.getActiveSandboxView getter), then mirrors the value
// into the React COB ribbon's signal so the two sliders stay in
// lock-step.
//
// mvToggleRuntimePaused + mvRefreshRuntimeToggle drive the merged
// Pause/Resume button.  The caption always reflects what the NEXT
// click will do.  On Resume we deliberately leave each thread's
// breakpointHit flag alone — _runThread treats it as "skip the BP
// check on this tick's first instruction" so the BP'd line
// executes once instead of re-firing the same BP forever.
//
// wireMvRuntimeVisibility auto-pauses the COB runtime when the
// browser tab goes background, then restores the captured pre-hide
// paused state when it comes back.  Important for two reasons:
//   1. background tabs get rAF throttled to ~1 Hz, so the next
//      foreground frame's runtime.tick(dtMs) would drain a HUGE
//      dt and burst through 8 fixed sub-steps in one go.
//   2. CPU + battery: an idle background tab shouldn't keep
//      churning bytecode the user can't see.
//
// _wireRuntimeHelpersToWindow stashes the toggle + speed-setter on
// `window` so mv-controls can drive Space + +/- without an ES-module
// circular import.  Section-agnostic on purpose: this file no longer
// reaches into ui/unit-editor/ — unit-editor-specific window bridges
// (e.g. window.startMvAutoBuild) live in their own section's wiring.

import { hostCallbacks, getReactUi } from '../host-context.js'

// _activeRuntime — pick the runtime the Runtime overlay's Pause /
// Step / Stop All controls should target.  Sandbox tab → that tab's
// engine runtime; otherwise the single-unit model viewer's runtime.
// Returns null when neither is live yet (boot races).
export function _activeRuntime() {
  const dlg = document.getElementById('model-viewer-dialog')
  const sandboxOn = dlg && dlg.classList.contains('sandbox-mode')
  if (sandboxOn) {
    const sb = hostCallbacks.getActiveSandboxView?.()
    if (sb) return sb.runtime || null
  }
  const mv = hostCallbacks.getActiveModelViewer?.()
  return (mv && mv.cob && mv.cob.runtime) || null
}

// mvRefreshRuntimeToggle syncs the merged button's caption + title
// to the runtime's current paused state.  Called after every state
// flip (button click, Space hotkey, programmatic pause).  Safe to
// call when the button isn't in the DOM yet.
export function mvRefreshRuntimeToggle() {
  const btn = document.getElementById('mv-threads-toggle')
  if (!btn) return
  const mv = hostCallbacks.getActiveModelViewer?.()
  const paused = !!mv?.cob?.runtime?.paused
  if (paused) {
    btn.textContent = '▶ Resume'
    btn.title = 'Resume — un-pause the runtime and continue past any breakpoint that fired.  Spacebar does the same thing.'
  } else {
    btn.textContent = '⏸ Pause'
    btn.title = 'Pause — freeze every unit’s animators + threads on this runtime.  Spacebar does the same thing.'
  }
}

// mvToggleRuntimePaused flips the active runtime's paused state and
// refreshes the merged Pause/Resume button's label + tooltip so the
// caption always reflects what the NEXT click will do.  Routes through
// _activeRuntime so the Spacebar hotkey and the Runtime overlay's
// Pause button drive whichever runtime the user is actually looking
// at (sandbox engine OR unit-editor viewer).
//
// On Resume: we DELIBERATELY leave each thread's breakpointHit flag
// alone.  _runThread reads `allowFirstBreakpoint = !breakpointHit` —
// when breakpointHit is true (the thread is paused on a BP), the
// first instruction this tick skips the BP check, executes the BP'd
// line once, then re-engages BP checking for subsequent ops.  If we
// cleared the flag here the BP at the same PC would re-fire
// immediately, paused would flip back to true, and the sim would
// look like it "stepped one tick and re-paused" — which is exactly
// the bug Resume used to ship.
export function mvToggleRuntimePaused() {
  const rt = _activeRuntime()
  if (!rt) return
  const willPause = !rt.paused
  rt.setPaused(willPause)
  mvRefreshRuntimeToggle()
  // Kick the React inspector tree so the Pause/Resume button label
  // (and any other panel that reads rt.paused) flips RIGHT NOW
  // instead of after the next 4 Hz publish.  Without this nudge the
  // click → label-change latency was 250 ms, which read as "did the
  // click register?" — bad for a control whose feedback is the label
  // itself.  Cheap: just increments the runtimeTick signal.
  const ui = getReactUi()
  if (ui && typeof ui.bumpRuntimeTick === 'function') {
    ui.bumpRuntimeTick()
  }
}

// mvSetSimulationSpeed is the single entry point for changing the
// runtime's playback rate.  Both the COB-menu Playback slider and
// the Runtime overlay's Speed slider call this — it pushes the new
// rate to the runtime and writes the value labels on both sliders
// so the two UIs stay in lock-step.  rate is the multiplier (1.0 =
// real time, 0.01 = 1/100 speed, 10.0 = 10× fast-forward).  Slider
// max range matches CobRuntime.setPlaybackRate clamping (0.01 → 10).
export function mvSetSimulationSpeed(rate) {
  // Resolve `rate` to a number, defaulting to 1 only when the caller
  // passes NaN/undefined/null — `+0` is a valid input that should
  // clamp UP to 0.01, NOT silently fall back to 1.  Old `|| 1`
  // version mis-handled the "+/- key stepped past zero" path.
  const n = Number(rate)
  const v = Math.max(0.01, Math.min(10, Number.isFinite(n) ? n : 1))
  const mv = hostCallbacks.getActiveModelViewer?.()
  const cob = mv?.cob
  if (cob) cob.runtime.setPlaybackRate(v)
  // Sandbox tabs have their own per-tab CobRuntime inside their
  // GameEngine — the unit editor's runtime is unrelated.  Dispatch
  // the rate to the active sandbox view's runtime too so dragging
  // the slider while a sandbox is in front actually slows / speeds
  // its sim.  No-op when no sandbox is open.
  const sb = hostCallbacks.getActiveSandboxView?.() || null
  const sbRt = sb?.scene?.runtime
  if (sbRt && typeof sbRt.setPlaybackRate === 'function') sbRt.setPlaybackRate(v)
  // React COB ribbon's Playback slider — pushed via state signal.
  // The Runtime overlay's SpeedSlider component reads rt.playbackRate
  // directly (subscribed via runtimeTick), so it picks up the new rate
  // on the next publish without an explicit push here.
  const ui = getReactUi()
  if (ui && typeof ui.setModelViewerRibbonState === 'function') {
    ui.setModelViewerRibbonState({ cobPlayback: Math.round(v * 100) })
  }
}

// wireMvRuntimeVisibility pauses the COB runtime whenever the browser
// tab goes background (visibilitychange → hidden) and resumes it
// when the tab comes back.  Important for two reasons:
//   1. background tabs get rAF throttled to ~1 Hz, so the per-frame
//      runtime.tick(dtMs) drains a HUGE dtMs on the next foreground
//      frame — which would burst through 8 fixed sub-steps in one
//      go and look like a teleport / animation jump.
//   2. CPU + battery: a unit-editor tab left in the background
//      shouldn't keep churning script bytecode the user can't see.
// Remembers the prior paused state so we don't blow away an
// explicit user pause (Resume button leaves runtime paused; coming
// back from background must NOT auto-un-pause).
export function wireMvRuntimeVisibility() {
  let savedPaused = null
  document.addEventListener('visibilitychange', () => {
    const mv = hostCallbacks.getActiveModelViewer?.()
    const rt = mv?.cob?.runtime || mv?._runtime
    if (!rt) return
    if (document.hidden) {
      // Capture the prior state on the way DOWN — if already
      // paused (user clicked Pause), savedPaused=true so we leave
      // it paused when we come back.
      savedPaused = !!rt.paused
      if (!rt.paused) rt.setPaused(true)
    } else {
      // Restore the captured pre-hide state.  Defensive null-check
      // — visibilitychange "visible" can fire without a prior
      // "hidden" in some unusual page-load flows.
      if (savedPaused !== null && rt.paused && !savedPaused) {
        rt.setPaused(false)
      }
      savedPaused = null
    }
  })
}

// _wireRuntimeHelpersToWindow exposes the toggle / speed-setter on
// `window` so cross-module callers (mv-controls' keyboard handler)
// can drive Space + +/- hotkeys without having to import the studio
// module bundle or hit an ES-module circular import.  Unit-editor-
// specific bridges (window.startMvAutoBuild) are wired up by the
// unit-editor section instead.
export function _wireRuntimeHelpersToWindow() {
  window.mvToggleRuntimePaused = mvToggleRuntimePaused
  window.mvSetSimulationSpeed = mvSetSimulationSpeed
}
