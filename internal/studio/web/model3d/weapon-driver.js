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
// Smoke trails for missile-class projectiles are NOT scheduled here
// — that needs a per-frame tick which only the host can drive — but
// the caller can detect SFX_PROJECTILE_MISSILE and wire its own
// trail emitter.  Returns the kind + lifeMs + velocity vector so the
// caller can chain follow-up effects.
export function spawnProjectile({ binding, weapon, anchor, target, palette, gravity = 80 }) {
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
