// world-fx.js — data-driven weapon + death presentation for createWorld.
//
// The studio sandbox renders game-accurate weapon visuals by feeding each
// unit's FBI weapon meta through weapon-driver.js into a per-unit
// ParticlePool.  A replay driver has no FBI meta and no per-unit bindings —
// it has a pack's weapons.json (id → render fields, format v4) and a single
// world it pushes state into.  This module bridges the two: it normalises a
// pack weapon def into the weapon-driver shape and spawns the SAME visual
// paths the studio uses (laser pulse chains, D-gun fireball + flame trail,
// smoke-trailed missiles, bitmap sprite bolts, muzzle flash + start smoke,
// impact bursts) against a world-level binding.
//
// Everything here is renderer-agnostic: the binding is any object carrying a
// ParticlePool, so the whole module runs headless under Node for tests.

import {
  spawnProjectile,
  spawnLaserBeam,
  SFX_PROJECTILE_LASER,
  SFX_PROJECTILE_DGUN,
  SFX_FIRE_FLASH,
  SFX_SMOKE_WHITE,
} from './weapon-driver.js'
import { SFX_SMOKE_GREY, SFX_SPARK } from './cob-particles.js'
import {
  WEAPON_RENDERTYPE_DGUN,
  WEAPON_RENDERTYPE_LASER,
  WEAPON_RENDERTYPE_MINDGUN,
  WEAPON_RENDERTYPE_LIGHTNING,
  hasRenderType,
} from './weapon-rendertype.js'

// normalizePackWeaponDef maps one weapons.json entry (pack format v4 — see
// internal/studio/pack_weapons.go) onto the field names weapon-driver.js
// dispatches on.  Pre-v4 packs lack the trajectory fields; the result then
// degrades to the def's render type + velocity, which still picks the right
// visual family.  Returns null for an unknown def so callers can fall back
// to an explicit-fields effect.
export function normalizePackWeaponDef(id, def) {
  if (!def) return null
  const colorIdx = def.colorIdx != null ? def.colorIdx : 0
  return {
    name: String(def.id || id || '').toUpperCase(),
    renderType: def.renderType,
    beamWeapon: !!def.beamWeapon,
    ballistic: !!def.ballistic,
    dropped: !!def.dropped,
    smokeTrail: !!def.smokeTrail,
    smokeDelaySec: +def.smokeDelaySec || 0,
    startSmoke: !!def.startSmoke,
    commandFire: !!def.commandFire,
    velocityWU: +def.velocityWU || 0,
    startVelocityWU: +def.startVelocityWU || 0,
    rangeWU: +def.rangeWU || 0,
    areaOfEffectWU: +def.areaOfEffectWU || 0,
    durationSec: +def.durationSec || 0,
    model: def.model || '',
    // weapon-driver reads `color` as the rendertype-4 sprite SLOT and
    // colorIdx/color2Idx as palette tint indices — all three come from the
    // TDF color=/color2= fields the pack carries raw.
    color: colorIdx,
    colorIdx,
    color2Idx: def.color2Idx != null ? def.color2Idx : 0,
    // Resolved RGB triple (0..255) for palette-less callers.
    colorRGB: Array.isArray(def.color) ? def.color : null,
    soundStart: def.soundStart || '',
    soundHit: def.soundHit || '',
  }
}

// isBeamDef — instant-hit beam family (laser / mindgun / lightning).  The
// D-gun ships beamweapon=1 too but flies a visible slow fireball, so it is
// explicitly NOT a beam here.
export function isBeamDef(w) {
  if (!w) return false
  if (hasRenderType(w)) {
    return w.renderType === WEAPON_RENDERTYPE_LASER
      || w.renderType === WEAPON_RENDERTYPE_MINDGUN
      || w.renderType === WEAPON_RENDERTYPE_LIGHTNING
  }
  return !!w.beamWeapon && !w.commandFire
}

// weaponVisualPlan classifies how a shot should be drawn:
//   'beam'  — instant muzzle→target visual (laser pulse chain).
//   'model' — the weapon's packed projectile 3DO flies the trajectory
//             (missiles, rockets, torpedoes, bombs).
//   'particle' — everything else routes through weapon-driver's projectile
//             particles (D-gun fireball, bitmap sprite bolts, shells).
// Pure classification, no side effects — unit-testable headlessly.
export function weaponVisualPlan(w) {
  if (!w) return 'particle'
  if (isBeamDef(w)) return 'beam'
  if (hasRenderType(w) && w.renderType === WEAPON_RENDERTYPE_DGUN) return 'particle'
  if (w.model) return 'model'
  return 'particle'
}

// impactBurst detonates a synthetic impact at `pos`: a bright flash sized by
// the blast diameter, a spray of sparks, and a lingering smoke puff — the
// same cluster the studio's projectileHit path paints.  aoe is the TDF
// blast DIAMETER in world units (defaults to a rifle-round 16).
export function impactBurst(binding, pos, { aoe = 16, sparks = true } = {}) {
  if (!binding || !binding.particles) return
  const p = binding.particles
  const size = Math.max(14, Math.min(120, aoe * 0.9))
  const life = Math.max(300, Math.min(1100, 300 + aoe * 6))
  p.emit(SFX_FIRE_FLASH, pos, {
    size,
    lifeMs: life,
    color: [1.9, 0.75, 0.22, 1.0],
    lightStrength: Math.min(300, aoe * 2.2),
  })
  if (sparks) {
    const n = Math.max(4, Math.min(14, Math.round(aoe / 6)))
    for (let i = 0; i < n; i++) {
      p.emit(SFX_SPARK, pos, {})
    }
  }
  p.emit(SFX_SMOKE_GREY, [pos[0], pos[1] + 2, pos[2]], {
    size: Math.max(10, aoe * 0.6),
    lifeMs: 1200,
  })
}

// spawnWeaponVisual renders one shot of `weapon` (a normalised def — see
// normalizePackWeaponDef) from `from` toward `to` against the world binding.
//
// Returns a descriptor of what was spawned so callers (and tests) can chain
// or assert:
//   { plan: 'beam'|'model'|'particle', kind, color, durationMs,
//     modelShot? }  — modelShot is the live record pushed onto
//     opts.modelShots for 'model' plans (the caller steps it and draws the
//     mesh; see create-world.js).
//
// Overrides: explicit color ([r,g,b] 0..1) / durationMs / velocity /
// width win over the def-derived values.
export function spawnWeaponVisual({
  weapon,
  from,
  to,
  binding,
  palette = null,
  smokeTrails = null,
  modelShots = null,
  gravity = 80,
  overrides = {},
}) {
  if (!Array.isArray(from) || !Array.isArray(to)) return null
  const w = weapon || null
  const plan = weaponVisualPlan(w)
  const aoe = (w && w.areaOfEffectWU) || 16

  if (plan === 'beam') {
    spawnLaserBeam({ binding, weapon: w, anchor: from, target: to, palette })
    // Muzzle pop + impact burst land immediately — a beam has no flight.
    if (binding && binding.particles) {
      binding.particles.emit(SFX_FIRE_FLASH, from, { size: 9, lifeMs: 120 })
    }
    impactBurst(binding, to, { aoe, sparks: true })
    const dur = overrides.durationMs != null
      ? overrides.durationMs
      : Math.max(90, (w && w.durationSec > 0 ? w.durationSec * 1000 : 120))
    return { plan, kind: SFX_PROJECTILE_LASER, durationMs: dur }
  }

  if (plan === 'model' && modelShots) {
    const v = overrides.velocity || (w && w.velocityWU) || 200
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
    const dist = Math.hypot(dx, dy, dz) || 1
    const ballistic = !!(w && (w.ballistic || w.dropped))
    let vel
    if (ballistic) {
      // Lofted launch: aim the horizontal component at the target and give
      // the arc enough vertical speed that gravity brings it down there.
      const horiz = Math.hypot(dx, dz) || 1
      const t = Math.max(0.4, horiz / v)
      vel = [
        dx / t,
        dy / t + 0.5 * gravity * t,
        dz / t,
      ]
    } else {
      vel = [dx / dist * v, dy / dist * v, dz / dist * v]
    }
    const lifeMs = overrides.durationMs != null
      ? overrides.durationMs
      : Math.max(200, (dist / v) * 1000 * (ballistic ? 1.15 : 1.0))
    const shot = {
      model: null,           // caller resolves the mesh asynchronously
      modelName: w.model,
      weapon: w,
      x: from[0], y: from[1], z: from[2],
      vx: vel[0], vy: vel[1], vz: vel[2],
      gravity: ballistic ? gravity : 0,
      ageMs: 0,
      lifeMs,
      aoe,
      binding,
    }
    modelShots.push(shot)
    if (binding && binding.particles) {
      binding.particles.emit(SFX_FIRE_FLASH, from, { size: 12, lifeMs: 140 })
      if (w.startSmoke) {
        binding.particles.emit(SFX_SMOKE_WHITE, from, { size: 6, lifeMs: 500 })
      }
    }
    // Missile wake — same cadence source as the studio (TDF smokedelay).
    if (smokeTrails && w.smokeTrail) {
      const intervalMs = w.smokeDelaySec > 0 ? w.smokeDelaySec * 1000 : 40
      smokeTrails.schedule(binding, from, vel, shot.gravity, lifeMs, intervalMs)
    }
    return { plan, kind: null, durationMs: lifeMs, modelShot: shot }
  }

  // Particle family — D-gun fireball, bitmap sprite bolts, shells, bullets,
  // flame.  weapon-driver handles kind pick, palette tint, AoE sizing,
  // start smoke, D-gun flame trail and missile-particle smoke trails.
  const result = spawnProjectile({
    binding,
    weapon: w || { name: 'ADHOC', velocityWU: overrides.velocity || 300 },
    anchor: from,
    target: to,
    palette,
    gravity,
    smokeTrails,
  })
  return {
    plan: 'particle',
    kind: result ? result.kind : null,
    durationMs: result ? result.lifeMs : 0,
    isDgun: !!result && result.kind === SFX_PROJECTILE_DGUN,
  }
}

// stepModelShots advances the in-flight projectile meshes by dtMs, expiring
// each at its lifeMs with an impact burst at the final position.  Returns
// the surviving list (in place).  onExpire(shot) lets the caller add game
// touches (sounds) without re-deriving the impact point.
export function stepModelShots(modelShots, dtMs, { onExpire = null } = {}) {
  if (!modelShots || !modelShots.length) return modelShots
  const dt = dtMs / 1000
  let w = 0
  for (let i = 0; i < modelShots.length; i++) {
    const s = modelShots[i]
    s.ageMs += dtMs
    s.x += s.vx * dt
    s.y += s.vy * dt
    s.z += s.vz * dt
    if (s.gravity) s.vy -= s.gravity * dt
    if (s.ageMs >= s.lifeMs) {
      impactBurst(s.binding, [s.x, s.y, s.z], { aoe: s.aoe })
      if (onExpire) onExpire(s)
      continue
    }
    modelShots[w++] = s
  }
  modelShots.length = w
  return modelShots
}

// modelShotPose returns the {heading, pitch} the projectile mesh should fly
// with, derived from its velocity in the boundary's game convention
// (heading 0 faces -Z; the renderer's isProjectile flip handles the 3DO's
// nose-toward-+Z authoring).
export function modelShotPose(s) {
  const heading = Math.atan2(-s.vx, -s.vz)
  const horiz = Math.hypot(s.vx, s.vz)
  const pitch = Math.atan2(s.vy, horiz)
  return { heading, pitch }
}

// ── Death presentation ─────────────────────────────────────────────────

// resolveDeathPlan decides wreck vs flying-polygon debris from the death
// severity, mirroring the corpsetype ladder TA's Killed(severity) scripts
// settle on: a clean kill leaves the intact corpse feature, a heavy
// overkill leaves the damaged heap (and throws debris), and a catastrophic
// kill (self-destruct / commander blast, severity ≥ 100) vaporises the
// wreck entirely.
//
//   { severity, corpse, heapCorpse } →
//   { debris: boolean, corpse: string|null }
export function resolveDeathPlan({ severity = 0, corpse = null, heapCorpse = null } = {}) {
  const s = +severity || 0
  if (s >= 100) return { debris: true, corpse: null }
  if (s >= 50) return { debris: true, corpse: heapCorpse || corpse || null }
  return { debris: false, corpse: corpse || null }
}

// damageSmokeIntervalMs — the engine-driven damage-smoke cadence for a unit
// at hp01 (0..1 health fraction).  TA units start smoking below ~2/3 health
// and smoke harder as they approach death; null means "not smoking".
export function damageSmokeIntervalMs(hp01) {
  if (hp01 == null || !(hp01 < 2 / 3)) return null
  const t = Math.max(0, Math.min(1, hp01 / (2 / 3)))   // 1 at threshold → 0 dead
  return 260 + (1400 - 260) * t
}

// debrisBurst builds per-piece flight for a dying model's piece tree: every
// piece gets an outward + upward velocity and a tumble, integrated by
// stepDebris below.  Velocities live in the model's LOCAL frame (the same
// frame piece.move animates in), which matches how TA's COB EXPLODE throws
// pieces.  `rng` defaults to Math.random — a deterministic driver virtualises
// it (the replay render harness does).
export function debrisBurst(model, { speed = 55, lift = 90, rng = Math.random } = {}) {
  const pieces = []
  if (!model || !Array.isArray(model.flat)) return pieces
  for (const piece of model.flat) {
    const ang = rng() * Math.PI * 2
    const mag = speed * (0.4 + rng() * 0.9)
    pieces.push({
      piece,
      vx: Math.cos(ang) * mag,
      vy: lift * (0.5 + rng() * 0.8),
      vz: Math.sin(ang) * mag,
      sx: (rng() * 2 - 1) * 6,
      sy: (rng() * 2 - 1) * 6,
      sz: (rng() * 2 - 1) * 6,
    })
  }
  return pieces
}

// stepDebris integrates one debris record's pieces by dtMs (gravity on the
// vertical, spin on all axes).  The caller owns the record's age/lifetime.
export function stepDebris(pieces, dtMs, gravity = 120) {
  const dt = dtMs / 1000
  for (const d of pieces) {
    d.piece.move[0] += d.vx * dt
    d.piece.move[1] += d.vy * dt
    d.piece.move[2] += d.vz * dt
    d.vy -= gravity * dt
    d.piece.rotate[0] += d.sx * dt
    d.piece.rotate[1] += d.sy * dt
    d.piece.rotate[2] += d.sz * dt
  }
}
