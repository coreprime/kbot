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
  200: { name: 'Bullet',           family: 'bullet'  },  // EMG / cannon rounds
  201: { name: 'Shell',            family: 'shell'   },  // tank / artillery shells
  202: { name: 'Plasma',           family: 'plasma'  },  // Guardian / Punisher etc.
  203: { name: 'D-Gun',            family: 'dgun'    },  // Commander disintegrator
  205: { name: 'Missile',          family: 'missile' },  // dead-reckoned missiles
  206: { name: 'Bitmap Projectile', family: 'bullet' },  // rendertype=4 fx.gaf sprite
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
    // Renderer reference is attached by the host view (sandbox / unit
    // editor) so we can look up sprite metadata — weapon name + TDF
    // color slot — for kind=206 bitmap projectiles.  Without it the
    // generic "Bitmap Projectile" label still renders.
    const renderer = u.binding && u.binding._renderer
    for (let i = 0; i < pool.count; i++) {
      if (!pool.alive[i]) continue
      const k = pool.kind[i] | 0
      const def = _PARTICLE_PROJECTILE_KINDS[k]
      if (!def) continue
      // Resolve the display name + slot when this is a bitmap sprite
      // particle.  Falls back to the generic kind name when the
      // renderer can't resolve (e.g. headless test, sprite still
      // loading).
      let weaponName = def.name
      if (k === 206 && renderer && pool.spriteId) {
        const info = renderer.weaponBitmapInfo
          ? renderer.weaponBitmapInfo(pool.spriteId[i] | 0)
          : null
        if (info && info.weaponName) {
          weaponName = info.colorSlot > 0
            ? `Bitmap Projectile #${info.colorSlot} (${info.weaponName})`
            : `Bitmap Projectile (${info.weaponName})`
        }
      }
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
        weaponName,
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

// buildUnitMotion returns the live motion telemetry the Movement panel
// reads off the inspector mv proxy.  Single-source so the sandbox view +
// the unit-editor's MvControls produce identical shapes — the panel
// renders the same regardless of which view is feeding it.
//
// `orient` is the optional renderer-side pose overlay { pitch, roll, heave }
// (radians).  Caller passes renderer.getUnitOrientation(unit.id) — that
// covers aircraft banking, hovercraft wobble, and (single-unit mode only)
// the sea-bob sway of a ship.  When omitted the attitude indicator stays
// level — correct for a ground unit on flat terrain.
//
// Output shape:
//   {
//     speed, maxSpeed, accelerationWUPerSec2, brakeWUPerSec2,
//     heading, pitch, headingDeg, pitchDeg, rollDeg,
//     pos: {x, y, z},
//     isMoving, moveTarget, atkPhase, attackTarget,
//     bombRunBombsLeft, bombRunPoint,
//     meta: { isAircraft, isHover, isHovercraft },
//     // Derived:
//     desiredSpeedFraction — current/max, [0, 1].
//     bearingDeg — heading toward moveTarget (or attackTarget) if set.
//   }
//
// Returns null when `unit` is missing — the panel maps null to an empty
// state ("No Unit Selected" / "Multiple units selected").
export function buildUnitMotion(unit, orient) {
  if (!unit) return null
  // TA's FBI MaxVelocity is wu/frame at the 30 Hz locomotion clock — convert
  // to wu/s for display alongside the engine's already-per-second speed.
  // Same conversion the engine uses inside locomotion.js so the dial's
  // "max" reading matches the unit's actual top speed.
  const TA_MOVE_HZ = 30
  const meta = unit.meta || {}
  const maxSpeed = (meta.maxVelocity > 0) ? meta.maxVelocity * TA_MOVE_HZ : 0
  const acceleration = (meta.acceleration > 0) ? meta.acceleration * TA_MOVE_HZ * TA_MOVE_HZ : 0
  const brake = (meta.brakeRate > 0) ? meta.brakeRate * TA_MOVE_HZ * TA_MOVE_HZ : 0
  const speed = unit.speed || 0
  const heading = unit.heading || 0
  // Pitch + roll come from the renderer's pose overlay (aircraft banking,
  // hovercraft wobble, ship sea-bob) — the engine doesn't store them on
  // the unit record because they're a render-time effect.  Caller passes
  // renderer.getUnitOrientation(unit.id) as `orient`; we fall through to
  // zeros when no overlay applies (ground unit on flat terrain).
  const pitch = (orient && orient.pitch) || 0
  const roll  = (orient && orient.roll)  || 0
  const at = unit.attackTarget
  const atkPhase = (unit._atk && unit._atk.atkPhase) || null
  let bearingDeg = null
  if (unit.moveTarget) {
    bearingDeg = Math.atan2(unit.moveTarget.x - unit.pos.x, unit.moveTarget.z - unit.pos.z) * 180 / Math.PI
  } else if (at && !at.dead) {
    bearingDeg = Math.atan2(at.pos.x - unit.pos.x, at.pos.z - unit.pos.z) * 180 / Math.PI
  }
  return {
    speed,
    maxSpeed,
    accelerationWUPerSec2: acceleration,
    brakeWUPerSec2: brake,
    heading,
    pitch,
    headingDeg: (heading * 180 / Math.PI),
    pitchDeg: pitch * 180 / Math.PI,
    rollDeg:  roll  * 180 / Math.PI,
    pos: { x: unit.pos.x, y: unit.pos.y || 0, z: unit.pos.z },
    isMoving: !!unit.isMoving,
    moveTarget: unit.moveTarget ? { x: unit.moveTarget.x, z: unit.moveTarget.z } : null,
    atkPhase,
    attackTarget: at && !at.dead ? { id: at.id, name: at.name || '' } : null,
    bombRunBombsLeft: (unit._bombRun && unit._bombRun.bombsLeft) || 0,
    bombRunPoint: (unit._bombRun && unit._bombRun.point) ? [...unit._bombRun.point] : null,
    meta: {
      isAircraft:   !!meta.isAircraft,
      isHover:      !!meta.isHover,
      isHovercraft: !!meta.isHovercraft,
      name: unit.name || '',
    },
    desiredSpeedFraction: maxSpeed > 0 ? Math.max(0, Math.min(1, speed / maxSpeed)) : 0,
    bearingDeg,
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
