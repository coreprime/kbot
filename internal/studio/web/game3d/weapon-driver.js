// weapon-driver.js
//
// Shared weapon-firing primitives used by single-entity and
// multi-entity host views.  A weapon "shot" needs the same things in
// both modes: a particle of the right visual kind, optional smoke
// trail, an instant-hit laser beam (for beamweapons), and the weapon's
// start sound.  Each path also needs a binding so the particle / audio
// pools live with the firing unit, plus the FBI weapon metadata
// (range / velocity / ballistic / etc.) and a palette so laser beams
// render in TA-accurate colours.
//
// The functions here are pure helpers — they don't keep any state.
// Each call decides the visual kind from the weapon metadata + the
// weapon's name (carried over from the original heuristic-based
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
} from '../engine/cob-particles.js'

// Per-kind brightness multipliers applied on top of the palette-derived
// hue so each projectile family keeps its visual identity even when the
// raw colour is the same.  Beams need to glow hot to read at distance,
// d-gun reads as a violent overcharge, missile bodies are dim sparks.
// Values are linear; >1 pushes into the bloom threshold so the FX chain
// can lift them above HDR clamp.
const PROJECTILE_BRIGHTNESS = {
  // Laser multiplier reduced from 1.8 → 1.3 so the beam still reads as
  // saturated against terrain without blowing past the HDR clamp on
  // the post-FX bloom (1.8 was tone-mapping into a fat solid streak).
  [SFX_PROJECTILE_LASER]:   1.3,
  [SFX_PROJECTILE_DGUN]:    1.6,   // bright energy ball
  [SFX_PROJECTILE_PLASMA]:  1.5,
  [SFX_PROJECTILE_SHELL]:   1.1,
  [SFX_PROJECTILE_MISSILE]: 1.1,
  [SFX_PROJECTILE_BULLET]:  1.0,
}

// Per-kind fallback hues used when the weapon's TDF doesn't ship a
// colour index (most non-laser weapons omit `color=`).  These mirror
// the historic KIND_DEFAULTS so a TDF-silent weapon looks the same as
// before this refactor.
const PROJECTILE_FALLBACK_COLOUR = {
  [SFX_PROJECTILE_LASER]:   [0.45, 1.80, 0.45],
  [SFX_PROJECTILE_DGUN]:    [1.10, 0.30, 0.10],
  [SFX_PROJECTILE_PLASMA]:  [0.30, 1.00, 1.10],
  [SFX_PROJECTILE_SHELL]:   [1.00, 0.55, 0.20],
  [SFX_PROJECTILE_MISSILE]: [1.00, 0.75, 0.20],
  [SFX_PROJECTILE_BULLET]:  [1.00, 0.85, 0.20],
}

// projectileColor — the SINGLE source of truth for a projectile's tint
// across every kind.  Reads the TDF `color=` (or `color2=` as a fallback)
// through the palette, then scales it by the per-kind brightness so the
// hand-authored weapon hue still reads as a laser / plasma / bullet
// rather than collapsing to a dim palette entry.  Returns [r,g,b,a] in
// 0..2 float range — the additive blend tolerates >1 channels and the
// post-FX bloom relies on them to bloom on.
export function projectileColor(weapon, kind, palette) {
  const w = weapon || {}
  const mul = PROJECTILE_BRIGHTNESS[kind] || 1.0
  const idx = (w.colorIdx > 0) ? w.colorIdx : (w.color2Idx > 0 ? w.color2Idx : 0)
  if (palette && idx > 0) {
    const c = palette.colorFor(idx)
    return [Math.min(2, c[0] * mul), Math.min(2, c[1] * mul), Math.min(2, c[2] * mul), 1]
  }
  const fb = PROJECTILE_FALLBACK_COLOUR[kind] || [1.0, 1.0, 1.0]
  return [fb[0] * mul, fb[1] * mul, fb[2] * mul, 1]
}

// Back-compat alias — older call sites import `laserColor` directly.
// Beam shots are just the SFX_PROJECTILE_LASER variant of
// projectileColor, so the alias keeps the caller terse without
// duplicating the lookup logic.
export function laserColor(weapon, palette) {
  return projectileColor(weapon, SFX_PROJECTILE_LASER, palette)
}

// pickProjectileKind — TDF-flag-driven projectile-kind classifier.
// Order matters: each branch is a tighter signal than the next, so the
// first match wins.  Name regex stays as a last-resort fallback for the
// (mostly mod) TDFs that ship no flags at all.
//
// The D-Gun branch is data-driven (commandFire + huge AoE) rather than
// name-pattern: the original implementation matched /disintegrator/
// which broke for any rename / localisation / mod.
export function pickProjectileKind(weapon) {
  const w = weapon || {}
  // D-Gun family — every D-Gun in the stock TDFs combines commandfire=1
  // with beamweapon=1 (ARM_DISINTEGRATOR / CORE_DISINTEGRATOR are the
  // only weapons that pair those two flags).  Catching that pair BEFORE
  // the beam-weapon branch is essential — without it the D-Gun falls
  // through to the laser path (ARM_DISINTEGRATOR's areaofeffect is 48,
  // below any sensible AoE-based gate).
  if (w.commandFire && w.beamWeapon) return SFX_PROJECTILE_DGUN
  // Secondary D-Gun signal for mod variants that drop the beamweapon
  // flag but keep the canonical "huge blast you fire manually" shape.
  if (w.commandFire && (+w.areaOfEffectWU >= 80)) return SFX_PROJECTILE_DGUN
  // Beam weapons — instant-hit line.  TA's `rendertype=0` is the
  // historic laser render path; `beamweapon=1` is the modern flag.
  // Either one wins.
  if (w.beamWeapon || w.renderType === 0) return SFX_PROJECTILE_LASER
  // Missile family — anything self-propelled, smoke-trailing, dropped
  // gravity bomb, or vertical-launch.  All share the missile visual
  // (small bright body + smoke trail) so they collapse to one kind.
  if (w.smokeTrail || w.selfProp || w.dropped || w.vlaunch) return SFX_PROJECTILE_MISSILE
  // Ballistic shells / mortars / cannons — arc projectiles.
  if (w.ballistic) return SFX_PROJECTILE_SHELL
  // Plasma family — TA's `rendertype=1` (2D bitmap) and 5 (particle)
  // are typically plasma bolts / EMG tracers.  Catches Peewee and Core
  // Crasher style weapons without a name match.
  if (w.renderType === 1 || w.renderType === 5) return SFX_PROJECTILE_PLASMA
  // ── Last-resort name regex (only when every flag above said nothing) ──
  const n = w.name || ''
  if (/disintegrator|dgun|d_gun/i.test(n)) return SFX_PROJECTILE_DGUN
  if (/missile|rocket|torpedo/i.test(n) || /missile|rocket/i.test(w.model || '')) return SFX_PROJECTILE_MISSILE
  if (/laser|beam/i.test(n)) return SFX_PROJECTILE_LASER
  if (/plasma|emg|emp/i.test(n)) return SFX_PROJECTILE_PLASMA
  if (/cannon|mortar|shell/i.test(n)) return SFX_PROJECTILE_SHELL
  return SFX_PROJECTILE_BULLET
}

// Per-kind default size in world units used to derive a sensible visual
// scale when the weapon's TDF doesn't push us anywhere unusual.  Mirrors
// the KIND_DEFAULTS in cob-particles for the projectile families; we
// keep our own copy here so the multiplier scaling below stays decoupled
// from the pool's render defaults.
const PROJECTILE_BASE_SIZE = {
  // Beam pulse base size mirrors the trimmed KIND_DEFAULTS — 12 wu reads
  // as a clean line without dominating the unit's silhouette.
  [SFX_PROJECTILE_LASER]:   12.0,
  [SFX_PROJECTILE_DGUN]:    32.0,
  [SFX_PROJECTILE_PLASMA]:  3.5,
  [SFX_PROJECTILE_SHELL]:   5.0,
  [SFX_PROJECTILE_MISSILE]: 4.0,
  [SFX_PROJECTILE_BULLET]:  2.5,
}

// projectileSize — visual sprite size derived from the weapon's blast
// radius.  TA's `areaofeffect` is the blast DIAMETER in world units, so
// half of it is the radius; we scale the kind's base size up smoothly
// (with a soft cap) so a big AoE warhead reads visibly bigger than a
// pinpoint bullet without making every shell fill the screen.  Falls
// through to the kind base when the TDF doesn't ship areaofeffect.
export function projectileSize(weapon, kind) {
  const base = PROJECTILE_BASE_SIZE[kind] || 3.0
  const aoe = +((weapon || {}).areaOfEffectWU) || 0
  if (aoe <= 0) return base
  // Reference AoE = 32 wu (a typical Peewee/cannon round).  Square-root
  // scaling so a 4× larger AoE only doubles the sprite — keeps
  // pinpoint vs. heavy weapons distinguishable without making a 256-wu
  // nuke literally 16× the size of a bullet.
  const refAoE = 32
  const factor = Math.sqrt(aoe / refAoE)
  return base * Math.max(0.6, Math.min(3.5, factor))
}

// projectileLightStrength — dynamic-light reach derived from the AoE.
// Bigger blast → wider pulse on nearby surfaces.  The Laser and D-Gun
// kinds have non-zero base reach baked into KIND_DEFAULTS already; this
// helper computes an additional AoE-scaled value the emitter can pass
// when it wants every shot's glow to track its real game-data magnitude.
export function projectileLightStrength(weapon, kind) {
  const aoe = +((weapon || {}).areaOfEffectWU) || 0
  if (aoe <= 0) return 0
  // Lasers and the D-gun keep their baked-in floor (90 / 300) — only
  // raise it for AoE that's beyond that floor.  Other kinds get a
  // proportional pulse so a heavy plasma weapon visibly throbs the
  // scene more than a peashooter.
  const base = (kind === SFX_PROJECTILE_LASER) ? 90
             : (kind === SFX_PROJECTILE_DGUN)  ? 300
             : 0
  const scaled = aoe * 1.4
  return Math.max(base, Math.min(400, scaled))
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
  // Pulse spacing widened from 4 → 6 wu so the chain isn't a solid
  // wall of overlapping sprites — with the trimmed 12 wu pulse size
  // 6 wu spacing keeps adjacent pulses just touching, producing a
  // continuous line without the fat solid streak the dense 4 wu
  // packing was creating.
  const segs = Math.max(12, Math.min(80, Math.round(len / 6)))
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
// current position every 40 ms of sim-time" emitter.  Both single-
// entity and multi-entity host paths need this, and the math is
// non-trivial enough (recompute the projectile's parametric position
// from launch + velocity + gravity·t²/2 because the pool compacts
// dead slots and we can't track an index) that having two copies
// invited drift.  One implementation, every host imports it.
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
  //
  // intervalMs is the per-trail puff cadence (TA `smokedelay`).  Falls
  // back to the historic 40 ms default when omitted so existing
  // weapons (and weapons that don't ship the TDF field) keep their
  // current visual.
  schedule(binding, anchor, velocity, gravity, lifeMs, intervalMs, opts = {}) {
    if (!binding || !binding.particles) return
    this._trails.push({
      binding,
      anchor:   [anchor[0], anchor[1], anchor[2]],
      velocity: [velocity[0], velocity[1], velocity[2]],
      gravity:  gravity || 0,
      lifeMs:   Math.max(50, lifeMs || 0),
      // Floor at 20 ms so a bogus 0 / negative TDF field doesn't
      // spin up an infinite emit loop in the inner while().
      intervalMs: Math.max(20, +intervalMs > 0 ? +intervalMs : 40),
      ageMs: 0,
      nextEmitMs: 0,
      // Per-puff kind / size / life override.  Defaults give the
      // original white smoke trail used by missiles; the D-Gun path
      // overrides with a hot orange fire puff so the disintegrator
      // ball drags a visible flame behind it instead of trailing
      // missile-style smoke.
      puffKind:  opts.puffKind  || SFX_SMOKE_WHITE,
      puffSize:  +opts.puffSize  || 4,
      puffLife:  +opts.puffLife  || 800,
      puffRise:  +opts.puffRise  || 1.5,
      puffDrift: +opts.puffDrift || 0.8,
      puffColor: opts.puffColor || null,
    })
  }

  // tick advances every live trail by dtSimMs and drops puffs at
  // each trail's own intervalMs (TDF `smokedelay`).  Trails older
  // than their declared lifeMs are pruned in-place (the projectile
  // is past its max range or would have hit by now).
  tick(dtSimMs) {
    if (!this._trails.length) return
    let writeIdx = 0
    for (let i = 0; i < this._trails.length; i++) {
      const t = this._trails[i]
      t.ageMs += dtSimMs
      if (t.ageMs >= t.lifeMs) continue
      const b = t.binding
      if (!b || !b.particles) continue
      while (t.ageMs >= t.nextEmitMs) {
        t.nextEmitMs += t.intervalMs
        const elapsed = Math.min(t.ageMs, t.lifeMs) / 1000
        const px = t.anchor[0] + t.velocity[0] * elapsed
        const py = t.anchor[1] + t.velocity[1] * elapsed - 0.5 * t.gravity * elapsed * elapsed
        const pz = t.anchor[2] + t.velocity[2] * elapsed
        const emitOpts = {
          size:      t.puffSize,
          lifeMs:    t.puffLife,
          riseSpeed: t.puffRise,
          drift:     t.puffDrift,
        }
        if (t.puffColor) emitOpts.color = t.puffColor
        b.particles.emit(t.puffKind, [px, py, pz], emitOpts)
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
  // travelling projectile.  The "is this really a beam vs. a D-gun
  // misflagged as beamWeapon" decision now lives in pickProjectileKind
  // (commandFire + huge AoE → DGUN); we just ask the classifier.
  const preKind = pickProjectileKind(weapon)
  if (preKind === SFX_PROJECTILE_LASER) {
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

  const kind = preKind
  // Per-shot visual props derived from the weapon's TDF — colour from
  // the palette index, size + lightStrength from the blast radius.
  // emit() honours each opt, falling back to the kind defaults when a
  // field is omitted; we always pass colour so even a flag-only TDF
  // (no `color=`) gets its kind's branded hue rather than the smoke
  // grey default.
  const color = projectileColor(weapon, kind, palette)
  const size = projectileSize(weapon, kind)
  const light = projectileLightStrength(weapon, kind)
  const emitOpts = {
    velocity: [vx, vy, vz],
    gravity: weapon.ballistic ? gravity : 0,
    lifeMs,
    noFade: true,
    color,
    size,
  }
  if (light > 0) emitOpts.lightStrength = light
  binding.particles.emit(kind, anchor, emitOpts)
  playWeaponSound({ binding, weapon, anchor })
  // Remember the weapon on the binding so _onParticleExpire knows what
  // to look up when the projectile lifeMs elapses and the impact fires.
  // Best-effort: shared across every concurrent in-flight shot from this
  // binding, so multi-weapon units use the LAST fired weapon's art for
  // whichever expires next.  Acceptable for the common case.
  binding._lastFiredWeapon = weapon
  // TDF startSmoke=1 — puff of grey smoke at the muzzle on each fire.
  // Most cannons + plasma weapons ship this so the discharge has a
  // visible cloud independent of the impact burst at the other end.
  if (weapon.startSmoke) {
    binding.particles.emit(SFX_SMOKE_WHITE, anchor, { size: 7, lifeMs: 600, riseSpeed: 1.4, drift: 1.0 })
  }
  // Missiles trail smoke along their flight path.  Caller passes a
  // SmokeTrailManager via opts.smokeTrails when it wants this — hosts
  // either hold one per active unit or one shared across every
  // spawned unit's bindings.  No-ops cleanly when the manager isn't
  // supplied or the kind isn't a missile.
  if (smokeTrails && kind === SFX_PROJECTILE_MISSILE) {
    const intervalMs = (+weapon.smokeDelaySec > 0) ? weapon.smokeDelaySec * 1000 : 40
    smokeTrails.schedule(binding, anchor, [vx, vy, vz], weapon.ballistic ? gravity : 0, lifeMs, intervalMs)
  }
  // D-Gun trail — the disintegrator ball drags a hot orange flame
  // behind it in the original game.  We re-use the SmokeTrailManager
  // (it's geometry-only — re-derives puff positions from the launch
  // anchor + velocity) and tell it to emit fire-flash puffs instead
  // of the missile-default white smoke.  Cadence is faster than a
  // missile trail (every 30 ms) so the flame reads as continuous at
  // the D-Gun's slow 200 wu/s flight.
  if (smokeTrails && kind === SFX_PROJECTILE_DGUN) {
    smokeTrails.schedule(binding, anchor, [vx, vy, vz], weapon.ballistic ? gravity : 0, lifeMs, 30, {
      puffKind:  SFX_FIRE_FLASH,
      puffSize:  10,
      puffLife:  350,
      puffRise:  0,
      puffDrift: 0,
      puffColor: [2.0, 0.7, 0.2, 1.0],
    })
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
