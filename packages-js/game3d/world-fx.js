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
import { SFX_SMOKE_GREY, SFX_SPARK, SFX_SUB_BUBBLES, SFX_NANO_PARTICLES } from './cob-particles.js'
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
    // Guided-flight + water fields (pack format v5; zero on older packs).
    // turnRate is TA angle units (65536 = full circle) per second — the
    // converted rad/s value is what the steering integrator consumes.
    turnRate: def.turnRate | 0,
    turnRateRad: (def.turnRate | 0) * TA_TURN_TO_RAD,
    guidance: !!def.guidance,
    waterWeapon: !!def.waterWeapon,
    accelerationWU: +def.accelerationWU || 0,
    flightTimeSec: +def.flightTimeSec || 0,
  }
}

// TA weapon turnrate= is in TA angle units per second (65536 = 2π).
export const TA_TURN_TO_RAD = (Math.PI * 2) / 65536

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

// impactBurst detonates a synthetic impact at `pos`.  aoe is the TDF blast
// DIAMETER in world units (defaults to a rifle-round 16).
//
// Deliberately RESTRAINED per hit (see explosion-fx.js for the readability
// disciplines): a small-arms impact is a brief tight flash + a few sparks
// and a smoke puff; the big fire visuals belong to the polygonal explosion
// manager, which coalesces and budgets them.  When the binding carries one
// (binding.explosions — createWorld installs it) the mesh detonation
// spawns through it; kind/severity ride through for the tier ladder.
//
// Water: pass { water: true } (impact at/below the sea surface) and the
// burst becomes a splash — white spray + bubbles + a foam ring via the
// manager's splash tier, no fire.
export function impactBurst(binding, pos, { aoe = 16, sparks = true, kind = 'impact', severity = 0, water = false } = {}) {
  if (!binding || !binding.particles) return
  const p = binding.particles
  if (water) {
    // Splash: upward white spray + rising bubbles; foam ring via the
    // explosion manager's splash tier.
    const n = Math.max(3, Math.min(8, Math.round(aoe / 8)))
    for (let i = 0; i < n; i++) {
      p.emit(SFX_SMOKE_WHITE, pos, {
        size: Math.max(3, aoe * 0.18),
        lifeMs: 420,
        riseSpeed: 14 + i * 3,
        drift: 2.2,
        color: [0.95, 0.98, 1.05, 0.6],
      })
    }
    for (let i = 0; i < 3; i++) {
      p.emit(SFX_SUB_BUBBLES, [pos[0], pos[1] - 2, pos[2]], {})
    }
    if (binding.explosions) binding.explosions.spawn(pos, { aoe, kind: 'splash' })
    return
  }
  // Tight, short flash — sized WELL below the damage circle; the mesh
  // fireball (below) carries the body of the visual.
  const size = Math.max(6, Math.min(34, aoe * 0.45))
  const life = Math.max(180, Math.min(420, 160 + aoe * 1.6))
  p.emit(SFX_FIRE_FLASH, pos, {
    size,
    lifeMs: life,
    color: [1.6, 0.72, 0.24, 0.9],
    lightStrength: Math.min(90, aoe * 0.9),
  })
  if (sparks) {
    const n = Math.max(2, Math.min(8, Math.round(aoe / 10)))
    for (let i = 0; i < n; i++) {
      p.emit(SFX_SPARK, pos, {})
    }
  }
  p.emit(SFX_SMOKE_GREY, [pos[0], pos[1] + 2, pos[2]], {
    size: Math.max(8, Math.min(40, aoe * 0.5)),
    lifeMs: 1000,
  })
  if (binding.explosions) binding.explosions.spawn(pos, { aoe, kind, severity })
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
  env = null,
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
    const guided = !!(w && w.guidance && w.turnRateRad > 0)
    const torpedo = !!(w && w.waterWeapon)
    const waterY = env && Number.isFinite(env.waterY) ? env.waterY : null
    let vel
    let flightSec
    if (ballistic) {
      // Lofted launch solved to LAND AT THE TARGET: pick the time of
      // flight from the horizontal distance at muzzle speed, then give
      // the arc exactly the vertical speed gravity needs to bring it
      // down on the target at that time — x(t)=target, y(t)=target.
      const horiz = Math.hypot(dx, dz) || 1
      const t = Math.max(0.4, horiz / v)
      vel = [
        dx / t,
        dy / t + 0.5 * gravity * t,
        dz / t,
      ]
      flightSec = t
    } else if (torpedo && waterY != null) {
      // Torpedo: dive to running depth then drive flat at the target —
      // stepModelShots holds it at/below the waterline.
      const horiz = Math.hypot(dx, dz) || 1
      vel = [dx / horiz * v, 0, dz / horiz * v]
      flightSec = horiz / v
    } else {
      vel = [dx / dist * v, dy / dist * v, dz / dist * v]
      flightSec = dist / v
    }
    // Guided shots get life headroom to fly their curve; everything else
    // expires exactly when the wire says the shot lands.
    const lifeMs = overrides.durationMs != null
      ? overrides.durationMs
      : Math.max(200, flightSec * 1000 * (guided ? 1.6 : 1.0))
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
      // Guided flight: steer toward tx/ty/tz at turnRad rad/s and expire
      // on proximity (see stepModelShots).
      guided,
      turnRad: guided ? w.turnRateRad : 0,
      tx: to[0], ty: to[1], tz: to[2],
      // Torpedoes run at periscope depth below the sheet.
      torpedo,
      waterY,
      speed: v,
    }
    modelShots.push(shot)
    if (binding && binding.particles) {
      binding.particles.emit(SFX_FIRE_FLASH, from, { size: 12, lifeMs: 140 })
      if (w.startSmoke) {
        binding.particles.emit(SFX_SMOKE_WHITE, from, { size: 6, lifeMs: 500 })
      }
    }
    // Missile wake — same cadence source as the studio (TDF smokedelay).
    // Torpedoes drag a bubble trail instead of smoke.
    if (smokeTrails && (w.smokeTrail || torpedo)) {
      const intervalMs = w.smokeDelaySec > 0 ? w.smokeDelaySec * 1000 : 40
      if (torpedo) {
        smokeTrails.schedule(binding, from, vel, 0, lifeMs, 60, {
          puffKind: SFX_SUB_BUBBLES, puffSize: 2.5, puffLife: 900, puffRise: 4, puffDrift: 0.4,
        })
      } else {
        smokeTrails.schedule(binding, from, vel, shot.gravity, lifeMs, intervalMs)
      }
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

// stepModelShots advances the in-flight projectile meshes by dtMs.  Flight
// faithfulness lives here:
//   * ballistic shots integrate gravity (launched to land on the target);
//   * guided shots steer toward their target at the weapon's turn rate
//     (rad/s) and detonate on proximity, so a missile fired off-axis flies
//     a visible pursuit curve;
//   * torpedoes clamp to running depth below the waterline;
//   * a shot that reaches terrain (env.heightAt) or its life detonates,
//     and an impact at/below env.waterY splashes instead of burning.
// Returns the surviving list (in place).  onExpire(shot) lets the caller
// add game touches (sounds) without re-deriving the impact point.
export function stepModelShots(modelShots, dtMs, { onExpire = null, env = null } = {}) {
  if (!modelShots || !modelShots.length) return modelShots
  const dt = dtMs / 1000
  const heightAt = env && typeof env.heightAt === 'function' ? env.heightAt : null
  const envWaterY = env && Number.isFinite(env.waterY) ? env.waterY : null
  let w = 0
  for (let i = 0; i < modelShots.length; i++) {
    const s = modelShots[i]
    s.ageMs += dtMs
    // Guided steering: rotate the velocity toward the target bearing by at
    // most turnRad·dt this step, preserving speed.
    if (s.guided && s.turnRad > 0 && dt > 0) {
      const speed = Math.hypot(s.vx, s.vy, s.vz) || 1
      const px = s.tx - s.x, py = s.ty - s.y, pz = s.tz - s.z
      const pLen = Math.hypot(px, py, pz) || 1
      const dot = (s.vx * px + s.vy * py + s.vz * pz) / (speed * pLen)
      const ang = Math.acos(Math.max(-1, Math.min(1, dot)))
      if (ang > 1e-4) {
        const k = Math.min(1, (s.turnRad * dt) / ang)
        // Slerp-lite: blend the unit velocity toward the unit bearing and
        // renormalise to the weapon speed.
        let nx = s.vx / speed + (px / pLen - s.vx / speed) * k
        let ny = s.vy / speed + (py / pLen - s.vy / speed) * k
        let nz = s.vz / speed + (pz / pLen - s.vz / speed) * k
        const nLen = Math.hypot(nx, ny, nz) || 1
        s.vx = nx / nLen * speed
        s.vy = ny / nLen * speed
        s.vz = nz / nLen * speed
      }
    }
    s.x += s.vx * dt
    s.y += s.vy * dt
    s.z += s.vz * dt
    if (s.gravity) s.vy -= s.gravity * dt
    // Torpedo running depth: once at/under the waterline, hold a couple of
    // world units below the sheet and kill any vertical drift.
    const shotWaterY = Number.isFinite(s.waterY) ? s.waterY : envWaterY
    if (s.torpedo && shotWaterY != null && s.y <= shotWaterY) {
      s.y = Math.min(s.y, shotWaterY - 2)
      if (s.y < shotWaterY - 6) s.y = shotWaterY - 6
      s.vy = 0
    }
    // Detonation checks: proximity (guided), terrain, lifetime.
    let hit = false
    if (s.guided) {
      const dTarget = Math.hypot(s.tx - s.x, s.ty - s.y, s.tz - s.z)
      const speed = Math.hypot(s.vx, s.vy, s.vz)
      if (dTarget <= Math.max(4, speed * dt * 1.5)) hit = true
    }
    if (!hit && heightAt && s.vy < 0 && s.y <= heightAt(s.x, s.z)) hit = true
    if (hit || s.ageMs >= s.lifeMs) {
      const water = shotWaterY != null && s.y <= shotWaterY + 0.5
      impactBurst(s.binding, [s.x, s.y, s.z], { aoe: s.aoe, water })
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

// unitRocksOnImpact — whether the hit-rock impulse (create-world
// unitImpulse) applies to a unit record.  Structures don't rock: a
// factory hit by a shell shrugging on its foundations reads absurd,
// so buildings must stay planted while mobile hulls shudder.
//
// The signal, in priority order:
//   * an explicit `mobile` flag on the unit (addUnit / applyState) —
//     `mobile:false` marks a structure, `mobile:true` forces mobility;
//   * with no flag, INFERENCE: a grounded unit that has never changed
//     position or heading since it appeared (`_moved` latch, set by
//     applyState / moveUnit) is treated as a structure.  Buildings never
//     move, so a replay that only passes `grounded` still keeps them
//     planted; the cost is that a mobile unit parked since spawn won't
//     rock until it first moves.
export function unitRocksOnImpact(u) {
  if (!u) return false
  if (u.mobile === false) return false
  if (u.mobile === true) return true
  return !(u.grounded && !u._moved)
}

// damageSmokeIntervalMs — the engine-driven damage-smoke cadence for a unit
// at hp01 (0..1 health fraction).  TA units start smoking below ~2/3 health
// and smoke harder as they approach death; null means "not smoking".
export function damageSmokeIntervalMs(hp01) {
  if (hp01 == null || !(hp01 < 2 / 3)) return null
  const t = Math.max(0, Math.min(1, hp01 / (2 / 3)))   // 1 at threshold → 0 dead
  return 260 + (1400 - 260) * t
}

// ── Nanolathe construction spray ──────────────────────────────────────

// The build nanolathe is a dense CONE of tiny bright-green particles
// streaming from the builder's nano piece (`from`) toward the build target
// (`to`) and converging on it — a translucent fan of fine motes, not a
// sparse train of discrete blobs.  These tunables shape one emit tick:
//
//   LATHE_CONE_PARTICLES  — motes sprayed per active build tick (per beam).
//   LATHE_CONE_HALF_ANGLE — cone half-angle at the nozzle (radians ≈ 14°).
//   LATHE_CONE_SPEED      — nominal mote speed toward the target (WU/s).
//   LATHE_CONE_SPEED_VAR  — ± fractional speed variance per mote.
//   LATHE_CONE_SIZE_*     — mote size range (small, fine particles).
//   LATHE_CONE_TARGET_JITTER — radial spread at the target as a fraction of
//     span length; the cone narrows toward `to` so motes converge on it.
//   LATHE_CONE_LIFE_SLACK — extra fraction of travel time the mote lives
//     past arrival, so it decelerates/lingers and fades ON the target.
export const LATHE_CONE_PARTICLES = 7
export const LATHE_CONE_HALF_ANGLE = 0.24          // ~14° half-angle
export const LATHE_CONE_SPEED = 150
export const LATHE_CONE_SPEED_VAR = 0.35
export const LATHE_CONE_SIZE_MIN = 1.1
export const LATHE_CONE_SIZE_MAX = 2.3
export const LATHE_CONE_TARGET_JITTER = 0.06
export const LATHE_CONE_LIFE_SLACK = 0.35
export const LATHE_CONE_LIFE_MIN_MS = 120
export const LATHE_CONE_LIFE_MAX_MS = 520

// _orthoBasis returns two unit vectors perpendicular to `axis` (assumed
// unit-length) forming a right-handed basis {u, v, axis}.  Used to fan the
// cone motes off the beam axis.
function _orthoBasis(ax, ay, az) {
  // Pick the world axis least aligned with `axis` for a stable cross.
  let hx = 0, hy = 0, hz = 0
  if (Math.abs(ax) <= Math.abs(ay) && Math.abs(ax) <= Math.abs(az)) hx = 1
  else if (Math.abs(ay) <= Math.abs(az)) hy = 1
  else hz = 1
  // u = normalize(h × axis)
  let ux = hy * az - hz * ay
  let uy = hz * ax - hx * az
  let uz = hx * ay - hy * ax
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul; uy /= ul; uz /= ul
  // v = axis × u  (already unit-length)
  const vx = ay * uz - az * uy
  const vy = az * ux - ax * uz
  const vz = ax * uy - ay * ux
  return [ux, uy, uz, vx, vy, vz]
}

// latheConeSpray emits ONE build-tick's cone of nano motes into a particle
// pool.  Pure + deterministic: every random draw comes from `rng` (a seeded
// mulberry32-style () → [0,1) generator), so a replay re-run under the same
// fx clock sprays identically — no Date.now/Math.random.
//
// The cone originates at `from` (the nano nozzle) and each mote is aimed at
// a jittered point NEAR `to`: the aim jitter shrinks the fan toward the
// target, so the stream reads as a translucent green cone converging on the
// build.  Motes are small, additive-bright green, short-lived, and FADE
// (no noFade) so the spray is soft rather than a train of hard dots.
//
// Returns a descriptor for tests/proofs:
//   { emitted, axis:[x,y,z], dist, maxAngleRad, converges:boolean }
// where maxAngleRad is the widest mote deflection off the axis (bounded by
// the cone half-angle) and converges is true when every mote's aim point
// lies within the target-jitter radius of `to`.
export function latheConeSpray(pool, {
  from,
  to,
  rng = Math.random,
  count = LATHE_CONE_PARTICLES,
  color = [0.45, 1.9, 0.85, 0.9],
  halfAngle = LATHE_CONE_HALF_ANGLE,
  speed = LATHE_CONE_SPEED,
  speedVar = LATHE_CONE_SPEED_VAR,
  sizeMin = LATHE_CONE_SIZE_MIN,
  sizeMax = LATHE_CONE_SIZE_MAX,
  targetJitter = LATHE_CONE_TARGET_JITTER,
  lifeSlack = LATHE_CONE_LIFE_SLACK,
} = {}) {
  if (!pool || !Array.isArray(from) || !Array.isArray(to)) {
    return { emitted: 0, axis: [0, 0, 0], dist: 0, maxAngleRad: 0, converges: true }
  }
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
  const dist = Math.hypot(dx, dy, dz) || 1
  const ax = dx / dist, ay = dy / dist, az = dz / dist
  const [ux, uy, uz, vx, vy, vz] = _orthoBasis(ax, ay, az)
  const jitterR = dist * targetJitter
  let maxAngle = 0
  let converges = true
  let emitted = 0
  for (let i = 0; i < count; i++) {
    // Aim point: `to` displaced by a disc within jitterR (sqrt for an even
    // areal spread), so the cone narrows onto the target as it converges.
    const aimAng = rng() * Math.PI * 2
    const aimRad = Math.sqrt(rng()) * jitterR
    const ac = Math.cos(aimAng) * aimRad, as = Math.sin(aimAng) * aimRad
    const aimX = to[0] + ux * ac + vx * as
    const aimY = to[1] + uy * ac + vy * as
    const aimZ = to[2] + uz * ac + vz * as
    if (aimRad > jitterR + 1e-6) converges = false
    // Direction from nozzle to the aim point (this is the true travel
    // direction; the cone half-angle bounds how far off-axis it can point).
    let mdx = aimX - from[0], mdy = aimY - from[1], mdz = aimZ - from[2]
    const mlen = Math.hypot(mdx, mdy, mdz) || 1
    mdx /= mlen; mdy /= mlen; mdz /= mlen
    // Deflection off the axis (for the proof + a soft cone clamp).
    const dot = Math.max(-1, Math.min(1, mdx * ax + mdy * ay + mdz * az))
    let ang = Math.acos(dot)
    if (ang > halfAngle && ang > 1e-6) {
      // Clamp back into the cone: slerp the direction toward the axis.
      const k = halfAngle / ang
      let nx = ax + (mdx - ax) * k
      let ny = ay + (mdy - ay) * k
      let nz = az + (mdz - az) * k
      const nl = Math.hypot(nx, ny, nz) || 1
      mdx = nx / nl; mdy = ny / nl; mdz = nz / nl
      ang = halfAngle
    }
    if (ang > maxAngle) maxAngle = ang
    const sp = speed * (1 + (rng() * 2 - 1) * speedVar)
    // Life: reach the target then linger a touch and fade there.
    const travelMs = (dist / Math.max(1, sp)) * 1000
    const life = Math.max(
      LATHE_CONE_LIFE_MIN_MS,
      Math.min(LATHE_CONE_LIFE_MAX_MS, travelMs * (1 + lifeSlack)),
    )
    const size = sizeMin + rng() * (sizeMax - sizeMin)
    pool.emit(SFX_NANO_PARTICLES, [from[0], from[1], from[2]], {
      velocity: [mdx * sp, mdy * sp, mdz * sp],
      lifeMs: life,
      color,
      size,
      // Fade over life (no noFade) so the cone is a soft translucent haze
      // of motes, not hard persistent dots.
    })
    emitted++
  }
  return { emitted, axis: [ax, ay, az], dist, maxAngleRad: maxAngle, converges }
}

// debrisBurst builds the flying-fragment set for a dying model.  It works on
// the model's `flat` list — either the real COB piece tree (legacy / headless
// tests) or, in the live path, the many small SHARD fragments produced by
// debris-fragments.js (each shard is a `flat` entry carrying its own
// move/rotate channels plus a `centroid`).  Fine fragments are what make a
// death read as an explosion rather than one big chunk spiralling: dozens of
// small pieces burst outward + up, each tumbling on its own axis.
//
// Velocities live in the model's LOCAL frame (the frame move animates in),
// which matches how TA's COB EXPLODE throws pieces; the local frame's Y is
// world up (the debris base transform carries no pitch/roll), so gravity and
// terrain bounces integrate exactly in that frame.
//
// Spread: each fragment flies a WIDE upward-biased cone.  When the fragment
// carries a `centroid` (shard model) its outward direction is seeded from the
// centroid's bearing off the model centre, so the shatter genuinely bursts
// away from the core in every direction rather than scattering on one axis;
// legacy piece entries (no centroid) get a random bearing.  Speeds and the
// three-axis spin rates are all independently randomised per fragment so the
// shower doesn't corkscrew in unison.
//
// Directional bias: when the killing impact came from somewhere, pass
// impactDir ([x, z], WORLD frame, pointing from the explosion source toward
// the victim) + impactMag (≈1 light round … 4 heavy shell) and headingRad
// (the victim's yaw, to rotate the push into the local frame): every
// fragment's launch velocity gains a push AWAY from the source blended over
// the radial burst, so a unit killed from the west visibly sheds eastward.
//
// `rng` defaults to Math.random — deterministic drivers pass a seeded one
// (createWorld seeds from the unit id + position).
export function debrisBurst(model, {
  speed = 55, lift = 90, rng = Math.random,
  impactDir = null, impactMag = 0, headingRad = 0,
} = {}) {
  const pieces = []
  if (!model || !Array.isArray(model.flat)) return pieces
  // World push → the local frame (inverse yaw), scaled by the magnitude.
  let pushX = 0, pushZ = 0
  if (Array.isArray(impactDir) && (impactDir[0] || impactDir[1])) {
    const len = Math.hypot(impactDir[0], impactDir[1]) || 1
    const wx = impactDir[0] / len, wz = impactDir[1] / len
    const c = Math.cos(headingRad), sn = Math.sin(headingRad)
    const mag = speed * 0.8 * Math.min(4, Math.max(0, +impactMag || 0))
    pushX = (c * wx - sn * wz) * mag
    pushZ = (sn * wx + c * wz) * mag
  }
  for (const piece of model.flat) {
    // Outward bearing.  A shard fragment bursts along its offset from the
    // model centre (centroid direction on the XZ plane); a legacy piece
    // picks a random bearing.  A small rng wobble on the shard case keeps
    // co-located shards from launching on identical vectors.
    let dirX, dirZ
    const cen = piece.centroid
    if (Array.isArray(cen) && (cen[0] || cen[2])) {
      const wob = (rng() - 0.5) * 1.1
      const base = Math.atan2(cen[2], cen[0]) + wob
      dirX = Math.cos(base)
      dirZ = Math.sin(base)
    } else {
      const ang = rng() * Math.PI * 2
      dirX = Math.cos(ang)
      dirZ = Math.sin(ang)
    }
    // Wide speed spread so fragments separate into a cloud rather than a
    // shell of equal-radius pieces.
    const mag = speed * (0.35 + rng() * 1.25)
    // Upward bias, but a full solid-angle spread: some shards rocket up,
    // some skim outward low — vy ranges from a shallow skim to a high loft.
    const up = lift * (0.25 + rng() * 1.15)
    pieces.push({
      piece,
      vx: dirX * mag + pushX * (0.6 + rng() * 0.8),
      vy: up,
      vz: dirZ * mag + pushZ * (0.6 + rng() * 0.8),
      // Independent, wide-range angular velocities per axis (rad/s): each
      // fragment tumbles on its own, so the shower never spins in lockstep.
      sx: (rng() * 2 - 1) * 12,
      sy: (rng() * 2 - 1) * 12,
      sz: (rng() * 2 - 1) * 12,
      bounces: 0,
      settled: false,
    })
  }
  return pieces
}

// stepDebris integrates one debris record's pieces by dtMs (gravity on the
// vertical, spin on all axes) — the legacy no-terrain form, kept for
// callers without a battlefield.  The caller owns the record's lifetime.
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

// Debris bounce tuning: restitution (vertical energy kept per bounce),
// ground friction on the horizontal, and how many bounces before a piece
// settles where it lies.
export const DEBRIS_RESTITUTION = 0.42
export const DEBRIS_FRICTION = 0.62
export const DEBRIS_MAX_BOUNCES = 3

// Shared zero-origin fallback for legacy debris pieces that carry no static
// origin (headless test stubs / whole-model-clone pieces animated in place).
const ZERO3 = [0, 0, 0]

// stepDebrisRecord integrates one death's pieces in WORLD terms: parabolic
// flight under gravity, spin, and terrain bounces.  rec is the createWorld
// debris record ({ x, y, z, headingRad, pieces }); env.heightAt samples the
// battlefield surface (default: the y=rec.y plane).  Each piece bounces
// with DEBRIS_RESTITUTION up to DEBRIS_MAX_BOUNCES times, losing spin and
// horizontal speed on every contact, then settles.  Returns true while any
// piece is still moving (the caller fades the record out after).
export function stepDebrisRecord(rec, dtMs, { heightAt = null, gravity = 120 } = {}) {
  const dt = dtMs / 1000
  if (!(dt > 0)) return true
  const c = Math.cos(rec.headingRad || 0), sn = Math.sin(rec.headingRad || 0)
  let moving = false
  for (const d of rec.pieces) {
    if (d.settled) continue
    d.piece.move[0] += d.vx * dt
    d.piece.move[1] += d.vy * dt
    d.piece.move[2] += d.vz * dt
    d.vy -= gravity * dt
    d.piece.rotate[0] += d.sx * dt
    d.piece.rotate[1] += d.sy * dt
    d.piece.rotate[2] += d.sz * dt
    // World position of the fragment's flight offset.  A shard's rest
    // position is its static origin (the centroid the geometry is recentred
    // about); `move` is the flight displacement on top of it.  Local XZ is
    // rotated by the record's yaw; local Y IS world up on a debris record.
    const org = d.piece.origin || ZERO3
    const lx = org[0] + d.piece.move[0], lz = org[2] + d.piece.move[2]
    const wx = rec.x + (c * lx + sn * lz)
    const wz = rec.z + (-sn * lx + c * lz)
    const groundY = heightAt ? heightAt(wx, wz) : rec.y
    const worldY = rec.y + org[1] + d.piece.move[1]
    if (worldY <= groundY && d.vy < 0) {
      d.piece.move[1] = groundY - rec.y - org[1]
      d.bounces += 1
      if (d.bounces > DEBRIS_MAX_BOUNCES || Math.abs(d.vy) < 8) {
        d.vx = 0; d.vy = 0; d.vz = 0
        d.sx = 0; d.sy = 0; d.sz = 0
        d.settled = true
        continue
      }
      d.vy = -d.vy * DEBRIS_RESTITUTION
      d.vx *= DEBRIS_FRICTION
      d.vz *= DEBRIS_FRICTION
      d.sx *= DEBRIS_FRICTION
      d.sy *= DEBRIS_FRICTION
      d.sz *= DEBRIS_FRICTION
    }
    moving = true
  }
  return moving
}
