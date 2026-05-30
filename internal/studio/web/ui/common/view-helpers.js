// view-helpers.js
//
// Shared view scaffolding used by BOTH the Unit Editor's MvControls
// and the Sandbox's SandboxView.  These are free functions (not class
// methods) on purpose: anything truly shared lives here; anything
// view-specific stays inside the view's own class.  Phase C of the
// game3d/ decontamination — replaces the previous BaseView class
// whose existence was creating cross-contamination every time the
// two consumers had to share a concept.
//
// Each function takes the host `view` as its first argument and
// reaches into the same fields the old BaseView wrote to
// (_engineSubs, _smokeTrails, _hotkeysDetach, _unitSoundDebounce)
// — externalised access, identical semantics.

import { SmokeTrailManager } from '../../game3d/weapon-driver.js'
import { attachUnitHotkeys } from '../../game3d/unit-hotkeys.js'

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

// Particle-pool kind codes that count as "in-flight projectiles" for the
// Projectiles inspector.  Maps each to a friendly name + the family bucket
// the panel uses.  Lasers (204) are skipped — they're instantaneous beams,
// not flying ordnance, and dropping them in here makes the panel churn
// every fire tick.
const _PARTICLE_PROJECTILE_KINDS = {
  200: { name: 'Bullet',  family: 'bullet'  },  // EMG / cannon rounds
  201: { name: 'Shell',   family: 'shell'   },  // tank / artillery shells
  202: { name: 'Plasma',  family: 'plasma'  },  // Guardian / Punisher etc.
  203: { name: 'D-Gun',   family: 'dgun'    },  // Commander disintegrator
  205: { name: 'Missile', family: 'missile' },  // dead-reckoned missiles
}

// appendParticleProjectiles walks every binding's particle pool and pushes a
// projectile record for each alive slot whose kind is one of the projectile-
// family codes above.  Owner is the unit hosting the pool.  Origin /
// destination are EXTRAPOLATED along the velocity vector — the engine's
// dead-reckoned particles carry no explicit launch / aim point, but the
// remaining-life × velocity segment ahead reads as "where this will land",
// and the elapsed-life × velocity segment behind reads as "where it came
// from" — close enough for the inspector to plot a track.
export function appendParticleProjectiles(engine, out) {
  if (!engine) return
  for (const u of engine.units()) {
    if (!u || u.dead) continue
    const pool = u.binding && u.binding.particles
    if (!pool || !pool.count) continue
    for (let i = 0; i < pool.count; i++) {
      if (!pool.alive[i]) continue
      const k = pool.kind[i] | 0
      const def = _PARTICLE_PROJECTILE_KINDS[k]
      if (!def) continue
      const px = pool.x[i], py = pool.y[i], pz = pool.z[i]
      const vx = pool.vx[i], vy = pool.vy[i], vz = pool.vz[i]
      const speed = Math.hypot(vx, vy, vz)
      const lifeMs   = pool.life[i]
      const life0Ms  = pool.life0[i]
      const elapsedMs = Math.max(0, life0Ms - lifeMs)
      const elapsedSec   = elapsedMs / 1000
      const remainingSec = Math.max(0, lifeMs / 1000)
      out.push({
        id: `p-${u.id}-${i}`,
        weaponName: def.name,
        model: '',
        mode: def.family,
        origin:      { x: px - vx * elapsedSec,   y: py - vy * elapsedSec,   z: pz - vz * elapsedSec },
        destination: { x: px + vx * remainingSec, y: py + vy * remainingSec, z: pz + vz * remainingSec },
        liveTarget: null,
        pos: { x: px, y: py, z: pz },
        vel: { x: vx, y: vy, z: vz },
        speed,
        ageSec: elapsedSec,
        lifeSec: life0Ms / 1000,
        owner: {
          id: u.id,
          name: u.name || '',
          side: u.side | 0,
        },
      })
    }
  }
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
  // Projectiles inspector reads off proxy.projectiles — both views populate
  // it via their own aggregateProjectiles().  Absent (or empty array) when
  // the engine has nothing in flight; that's the panel's empty state.
  if (typeof view.aggregateProjectiles === 'function') {
    proxy.projectiles = view.aggregateProjectiles()
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
