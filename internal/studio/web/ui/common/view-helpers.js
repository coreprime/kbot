// view-helpers.js
//
// Shared view scaffolding used by BOTH the Unit Editor's MvControls
// and the Sandbox's SandboxView.  These are free functions (not class
// methods) on purpose: anything truly shared lives here; anything
// view-specific stays inside the view's own class.  Phase C of the
// model3d/ decontamination — replaces the previous BaseView class
// whose existence was creating cross-contamination every time the
// two consumers had to share a concept.
//
// Each function takes the host `view` as its first argument and
// reaches into the same fields the old BaseView wrote to
// (_engineSubs, _smokeTrails, _hotkeysDetach, _unitSoundDebounce)
// — externalised access, identical semantics.

import { SmokeTrailManager } from '../../model3d/weapon-driver.js'
import { attachUnitHotkeys } from '../../model3d/unit-hotkeys.js'

// initSmokeTrails lazily installs a SmokeTrailManager on
// `view._smokeTrails`.  Idempotent; returns the (possibly pre-
// existing) manager so callers can stash a local ref if convenient.
export function initSmokeTrails(view) {
  if (!view._smokeTrails) view._smokeTrails = new SmokeTrailManager()
  return view._smokeTrails
}

// tickSmokeTrails advances the smoke-trail manager at the sim clock.
// Honours pause (rate = 0) and playbackRate so puffs stop streaming
// out of a frozen missile.  Returns the scaled dt for any caller
// that wants to reuse it for their own subsystems.
export function tickSmokeTrails(view, dtMs) {
  const rate = simRate(view)
  const dtSimMs = dtMs * rate
  if (view._smokeTrails) view._smokeTrails.tick(dtSimMs)
  return dtSimMs
}

// simRate returns the playback-rate multiplier honouring pause.
// Centralised so every subsystem (particles, smoke trails, audio
// cadence, sub-frame interp) reads from one place.
export function simRate(view) {
  const rt = view.runtime
  if (!rt) return 1
  if (rt.paused) return 0
  return rt.playbackRate || 1
}

// subscribeEngine attaches a handler to the view's engine and
// remembers the unsubscribe closure on view._engineSubs so a later
// disposeView(view) tears every listener down in one sweep.  Returns
// the closure as well in case the caller wants to detach early.
export function subscribeEngine(view, eventName, handler) {
  const eng = view.engine
  if (!eng) return () => {}
  const unsub = eng.on(eventName, handler)
  if (!view._engineSubs) view._engineSubs = []
  view._engineSubs.push(unsub)
  return unsub
}

// wireHotkeys attaches the shared unit-hotkey keymap and stashes the
// detach closure on view._hotkeysDetach.  Replaces any previously-
// wired detach so re-arming on a fresh selection doesn't accumulate.
export function wireHotkeys(view, opts) {
  if (view._hotkeysDetach) {
    try { view._hotkeysDetach() } catch { /* ignore */ }
  }
  view._hotkeysDetach = attachUnitHotkeys(opts)
}

// wrapCobWithAggregate returns a NON-mutating proxy of the given cob
// binding with particles/audio overridden to the scene-wide
// aggregators on `view`.  Object.create gives a fresh own-property
// surface that delegates everything else (hasScript, start,
// listScripts, runtime, unit, etc.) to the binding via the proto
// chain.  Critical: assigning particles/audio directly ONTO the
// binding would clobber its own pools and break particle emission
// inside the binding's own _emitFireBurst / getSceneLight etc.
//
// The aggregator functions live on `view` (each view implements its
// own aggregateParticlePool / aggregateAudioPool to walk whatever
// units it manages).
export function wrapCobWithAggregate(view, cob) {
  if (!cob) return cob
  const proxy = Object.create(cob)
  if (typeof view.aggregateParticlePool === 'function') {
    proxy.particles = view.aggregateParticlePool()
  }
  if (typeof view.aggregateAudioPool === 'function') {
    proxy.audio = view.aggregateAudioPool()
  }
  // _lifecycle default — the inspector's per-unit panels read this
  // to gate buttons pre-Create.  Multi-entity / aircraft-Create paths
  // set it on the real binding; the proxy needs a sensible default
  // for the "no binding" stub-cob path that doesn't ship the field.
  if (!proxy._lifecycle && !cob._lifecycle) proxy._lifecycle = 'created'
  return proxy
}

// disposeView tears down the per-view scaffolding (engine
// subscriptions, smoke trails, hotkeys) tracked by the helpers
// above.  Views call this from their own dispose() between any
// pre-teardown (pause, silence) and the renderer/canvas teardown.
export function disposeView(view) {
  if (view._engineSubs) {
    for (const unsub of view._engineSubs) {
      try { unsub() } catch { /* ignore */ }
    }
    view._engineSubs = []
  }
  if (view._smokeTrails) {
    try { view._smokeTrails.clear() } catch { /* ignore */ }
    view._smokeTrails = null
  }
  if (view._hotkeysDetach) {
    try { view._hotkeysDetach() } catch { /* ignore */ }
    view._hotkeysDetach = null
  }
}
