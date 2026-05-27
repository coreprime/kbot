// weapon-driver.js
//
// Shared weapon-firing primitives used by both the single-unit editor
// (MvControls) and the multi-unit Sandbox.  A weapon "shot" needs the
// same things in both modes: a particle of the right visual kind,
// optional smoke trail, an instant-hit laser beam (for beamweapons),
// and the weapon's start sound.  Each path also needs a binding so
// the particle / audio pools live with the firing unit, plus the
// FBI weapon metadata (range / velocity / ballistic / etc.) and a
// palette so laser beams render in TA-accurate colours.
//
// The functions here are pure helpers — they don't keep any state.
// Each call decides the visual kind from the weapon metadata + the
// weapon's name (heuristic carry-over from MvControls' original
// implementation), then routes the emit through the binding's pool.

import {
  SFX_PROJECTILE_BULLET,
  SFX_PROJECTILE_SHELL,
  SFX_PROJECTILE_PLASMA,
  SFX_PROJECTILE_DGUN,
  SFX_PROJECTILE_LASER,
  SFX_PROJECTILE_MISSILE,
  SFX_FIRE_FLASH,
  SFX_SMOKE_WHITE,
} from './cob/cob-particles.js'

// laserColor returns the laser tint [r,g,b,a] in 0..1 floats from the
// weapon's TDF palette indices.  TA's `color=` is the brightest shade
// (used for the beam core); `color2=` is the darker rim — we just use
// `color` since our beam is a single colour.  Falls back to a TA-green
// default when the palette / weapon colour isn't available.
export function laserColor(weapon, palette) {
  const idx = (weapon.colorIdx > 0) ? weapon.colorIdx : (weapon.color2Idx > 0 ? weapon.color2Idx : 0)
  if (palette && idx > 0) {
    const c = palette.colorFor(idx)
    // Boost above 1.0 so the additive blend produces the bright
    // saturated beam look TA's hand-drawn sprites give.  Capped at
    // 2.0 to stay readable when overlapping multiple shots.
    return [Math.min(2, c[0] * 1.8), Math.min(2, c[1] * 1.8), Math.min(2, c[2] * 1.8), 1]
  }
  return [0.45, 1.80, 0.45, 1]
}

// pickProjectileKind decides which particle kind to emit based on
// weapon metadata + name heuristic.  Same priority order MvControls
// used so visuals stay consistent across both views.
export function pickProjectileKind(weapon) {
  if (/disintegrator|dgun|d_gun/i.test(weapon.name)) return SFX_PROJECTILE_DGUN
  if (weapon.smokeTrail || weapon.selfProp || /missile|rocket/i.test(weapon.model || '')) return SFX_PROJECTILE_MISSILE
  if (weapon.ballistic) return SFX_PROJECTILE_SHELL
  if (/laser|plasma|emg|emp|beam/i.test(weapon.name)) return SFX_PROJECTILE_PLASMA
  return SFX_PROJECTILE_BULLET
}

// spawnLaserBeam draws a single-frame "instant hit" beam from anchor
// to target by emitting a chain of bright pulse particles along the
// line.  Real TA renders a coloured beam visible for a frame or two;
// we approximate with one pulse per 4 wu (capped at 120 so the pool
// stays sane on long-range shots).
export function spawnLaserBeam({ binding, weapon, anchor, target, palette }) {
  if (!binding || !binding.particles) return
  const dx = target[0] - anchor[0]
  const dy = target[1] - anchor[1]
  const dz = target[2] - anchor[2]
  const len = Math.hypot(dx, dy, dz)
  if (len < 0.001) return
  const color = laserColor(weapon, palette)
  const segs = Math.max(16, Math.min(120, Math.round(len / 4)))
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const p = [anchor[0] + dx * t, anchor[1] + dy * t, anchor[2] + dz * t]
    binding.particles.emit(SFX_PROJECTILE_LASER, p, {
      color,
      velocity: [0, 0, 0],
      gravity: 0,
      noFade: false,
    })
  }
}

// playWeaponSound routes a weapon's per-shot sound through the
// binding's AudioPool.  Source pos is the muzzle anchor (firing
// piece world XYZ) so the Audio inspector shows the discharge
// location even after the projectile moves on.  No-ops cleanly when
// the binding has no audio pool or the weapon has no soundStart.
export function playWeaponSound({ binding, weapon, anchor }) {
  if (!binding || !binding.audio) return
  if (!weapon || !weapon.soundStart) return
  binding.audio.play(weapon.soundStart, {
    vol: 0.7,
    kind: 'weapon-fire',
    source: weapon.name ? `${weapon.name}: fire` : 'Weapon fire',
    pos: anchor,
  })
}

// SmokeTrailManager owns the per-frame "drop a puff at the missile's
// current position every 40 ms of sim-time" emitter.  Both the
// single-unit viewer and the multi-unit Sandbox need this, and the
// math is non-trivial enough (recompute the projectile's parametric
// position from launch + velocity + gravity·t²/2 because the pool
// compacts dead slots and we can't track an index) that having two
// copies invited drift.  One implementation, both views import it.
//
// Usage:
//   const trails = new SmokeTrailManager()
//   // when a missile fires (typically from a 'fire' event subscriber):
//   trails.schedule(binding, anchor, velocity, gravity, lifeMs)
//   // every frame, with sim-time scaled dtMs (so slow-mo + pause work):
//   trails.tick(dtSimMs)
//   // on view dispose:
//   trails.clear()
//
// Per-frame ticking lets the trail cadence scale with playback rate
// — at 0.1× sim a slow missile leaves puffs every 400 ms wall ≈
// 40 ms sim, matching what its slowed velocity actually traces.
export class SmokeTrailManager {
  constructor() {
    this._trails = []
  }

  // schedule registers a new missile trail.  Captures the launch
  // anchor + velocity + gravity so puffs can be re-derived from
  // (anchor + velocity·t - ½·gravity·t²) without needing a live ref
  // to the projectile particle (which the pool may compact away).
  // Binding ref is held weakly via the trail record — when the unit
  // disposes, the binding's particle pool stops accepting emits and
  // the trail effectively becomes a no-op until it expires.
  schedule(binding, anchor, velocity, gravity, lifeMs) {
    if (!binding || !binding.particles) return
    this._trails.push({
      binding,
      anchor:   [anchor[0], anchor[1], anchor[2]],
      velocity: [velocity[0], velocity[1], velocity[2]],
      gravity:  gravity || 0,
      lifeMs:   Math.max(50, lifeMs || 0),
      ageMs: 0,
      nextEmitMs: 0,
    })
  }

  // tick advances every live trail by dtSimMs and drops puffs at
  // 40 ms sim-intervals.  Trails older than their declared lifeMs
  // are pruned in-place (the projectile is past its max range or
  // would have hit by now).
  tick(dtSimMs) {
    if (!this._trails.length) return
    const INTERVAL_MS = 40
    let writeIdx = 0
    for (let i = 0; i < this._trails.length; i++) {
      const t = this._trails[i]
      t.ageMs += dtSimMs
      if (t.ageMs >= t.lifeMs) continue
      const b = t.binding
      if (!b || !b.particles) continue
      while (t.ageMs >= t.nextEmitMs) {
        t.nextEmitMs += INTERVAL_MS
        const elapsed = Math.min(t.ageMs, t.lifeMs) / 1000
        const px = t.anchor[0] + t.velocity[0] * elapsed
        const py = t.anchor[1] + t.velocity[1] * elapsed - 0.5 * t.gravity * elapsed * elapsed
        const pz = t.anchor[2] + t.velocity[2] * elapsed
        b.particles.emit(SFX_SMOKE_WHITE, [px, py, pz], {
          size: 4,
          lifeMs: 800,
          riseSpeed: 1.5,
          drift: 0.8,
        })
      }
      this._trails[writeIdx++] = t
    }
    this._trails.length = writeIdx
  }

  // clear drops every in-flight trail.  Called on view dispose so a
  // re-open doesn't inherit stale missile wakes from the previous
  // session.
  clear() { this._trails.length = 0 }
}

// spawnProjectile emits a TA-style projectile from `anchor` toward
// `target` at the weapon's FBI velocity.  Handles three categories:
//
//   1. beamWeapon  → instant-hit; spawns the laser-beam streak +
//                    plays start sound.  Returns synchronously with
//                    nothing to track.
//   2. ballistic   → solves the launch angle for a parabolic arc
//                    that intersects the target, applies gravity to
//                    the particle so the shell visibly arcs.
//   3. else        → straight-line projectile at velocity vec.
//
// Common to non-beam paths: lifeMs sized to (range / velocity) ×
// arc-factor so the projectile expires roughly at the target.
//
// When opts.smokeTrails (a SmokeTrailManager) is supplied AND the
// chosen visual kind is SFX_PROJECTILE_MISSILE, the trail is
// scheduled inline — saves callers from duplicating the
// "if (result.kind === MISSILE) trails.schedule(...)" dance and
// keeps the missile-vs-bullet decision behind a single classifier.
//
// Returns { kind, lifeMs, velocity, anchor } so callers can chain
// follow-up effects (e.g. the Weapons-panel projectile recorder).
export function spawnProjectile({ binding, weapon, anchor, target, palette, gravity = 80, smokeTrails = null }) {
  if (!binding || !binding.particles || !weapon) return null
  const dx = target[0] - anchor[0]
  const dy = (target.length >= 3 ? target[1] : 0) - anchor[1]
  const dz = target[2] - anchor[2]
  const horiz = Math.hypot(dx, dz)
  if (horiz < 0.001) return null

  // Beam weapons: instant-hit.  Spawn the streak + play sound; no
  // travelling projectile.
  if (weapon.beamWeapon && !/disintegrator|dgun|d_gun/i.test(weapon.name)) {
    spawnLaserBeam({ binding, weapon, anchor, target, palette })
    playWeaponSound({ binding, weapon, anchor })
    return { kind: SFX_PROJECTILE_LASER, lifeMs: 200, velocity: [dx, dy, dz] }
  }

  const v = +weapon.velocityWU || 200
  let vx, vy, vz
  if (weapon.ballistic) {
    // Solve the launch angle that puts the parabola through the
    // target at the weapon's muzzle velocity.  Same math the unit-
    // editor's _aimAnglesFor uses so the projectile + the turret
    // pitch agree.  Out-of-range falls back to a 45° max-range
    // launch so the shell still flies somewhere reasonable.
    const v2 = v * v
    const disc = v2 * v2 - gravity * (gravity * horiz * horiz + 2 * dy * v2)
    let pitchRad
    if (disc >= 0) {
      pitchRad = Math.atan((v2 - Math.sqrt(disc)) / (gravity * horiz))
    } else {
      pitchRad = Math.PI / 4
    }
    const horizDir = [dx / horiz, dz / horiz]
    const cosP = Math.cos(pitchRad)
    vx = horizDir[0] * v * cosP
    vz = horizDir[1] * v * cosP
    vy = v * Math.sin(pitchRad)
  } else {
    const len = Math.hypot(dx, dy, dz)
    vx = (dx / len) * v
    vy = (dy / len) * v
    vz = (dz / len) * v
  }

  // Lifetime: range / velocity gives the time-of-flight at top speed.
  // Multiply by 1.5 for ballistic arcs (longer path along the arc) so
  // the shell doesn't vanish mid-flight on a long shot.
  const range = +weapon.rangeWU || (v * 3)
  const lifeFactor = weapon.ballistic ? 1.5 : 1.0
  const lifeMs = Math.max(300, (range / v) * 1000 * lifeFactor)

  const kind = pickProjectileKind(weapon)
  const emitOpts = {
    velocity: [vx, vy, vz],
    gravity: weapon.ballistic ? gravity : 0,
    lifeMs,
    noFade: true,
  }
  binding.particles.emit(kind, anchor, emitOpts)
  playWeaponSound({ binding, weapon, anchor })
  // Missiles trail smoke along their flight path.  Caller passes a
  // SmokeTrailManager via opts.smokeTrails when it wants this — the
  // viewer's MvControls holds one for the active unit; the Sandbox
  // holds one shared across every spawned unit's bindings.  No-ops
  // cleanly when the manager isn't supplied or the kind isn't a
  // missile.
  if (smokeTrails && kind === SFX_PROJECTILE_MISSILE) {
    smokeTrails.schedule(binding, anchor, [vx, vy, vz], weapon.ballistic ? gravity : 0, lifeMs)
  }
  return { kind, lifeMs, velocity: [vx, vy, vz], anchor: [anchor[0], anchor[1], anchor[2]] }
}

// Re-export the SFX kind ids so consumers that need to special-case
// (e.g. "schedule a smoke trail for missiles") can compare against
// pickProjectileKind's return without importing cob-particles.js
// separately.
export {
  SFX_PROJECTILE_BULLET,
  SFX_PROJECTILE_SHELL,
  SFX_PROJECTILE_PLASMA,
  SFX_PROJECTILE_DGUN,
  SFX_PROJECTILE_LASER,
  SFX_PROJECTILE_MISSILE,
  SFX_FIRE_FLASH,
  SFX_SMOKE_WHITE,
}
